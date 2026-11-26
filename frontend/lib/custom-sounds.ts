export interface CustomSound {
  id:string; name:string; fileName:string; size:number; mimeType:string; duration:number; addedAt:number;
}
interface SoundBlob {id:string; blob:Blob}
interface LibraryState {sounds:readonly CustomSound[]; loaded:boolean; error:string}
export interface CustomSoundChange {kind:'added'|'renamed'|'removed'; id:string}

export const CUSTOM_SOUND_LIMIT=100*1024*1024;
export const CUSTOM_SOUND_ACCEPT='.mp3,.wav,.m4a,.ogg,.flac,audio/mpeg,audio/wav,audio/mp4,audio/ogg,audio/flac';
const databaseName='pomodoro-custom-sounds',databaseVersion=1;
let database:Promise<IDBDatabase>|undefined,loading:Promise<void>|undefined,reloadRequested=false;
let state:LibraryState={sounds:[],loaded:false,error:''};
const listeners=new Set<()=>void>(),changeListeners=new Set<(change:CustomSoundChange)=>void>();
let channel:BroadcastChannel|undefined;

export class CustomSoundError extends Error {}
export const subscribeCustomSounds=(callback:()=>void)=>{listeners.add(callback);return()=>{listeners.delete(callback);};};
export const customSoundsState=()=>state;
export const subscribeCustomSoundChanges=(callback:(change:CustomSoundChange)=>void)=>{changeListeners.add(callback);return()=>{changeListeners.delete(callback);};};
function publish(next:Partial<LibraryState>){state={...state,...next};for(const listener of listeners)listener();}
export function customSoundError(error:unknown){return error instanceof CustomSoundError?error.message:'无法保存本地音库，请重试。';}
function storageError(error:unknown,reading=false){
  if(error instanceof CustomSoundError)return error;
  if(error instanceof DOMException&&error.name==='QuotaExceededError')return new CustomSoundError('本地音库空间不足，请移除部分声音后重试。');
  return new CustomSoundError(reading?'无法读取本地音库，请重试。':'无法保存本地音库，请重试。');
}
function openDatabase():Promise<IDBDatabase>{
  if(database)return database;
  database=new Promise((resolve,reject)=>{
    if(typeof indexedDB==='undefined'){reject(new CustomSoundError('本地音库存储不可用，请重启应用后重试。'));return;}
    const request=indexedDB.open(databaseName,databaseVersion);
    request.onupgradeneeded=()=>{
      const db=request.result;
      if(!db.objectStoreNames.contains('sounds'))db.createObjectStore('sounds',{keyPath:'id'});
      if(!db.objectStoreNames.contains('blobs'))db.createObjectStore('blobs',{keyPath:'id'});
    };
    request.onerror=()=>reject(storageError(request.error,true));
    request.onblocked=()=>reject(new CustomSoundError('本地音库存储不可用，请重启应用后重试。'));
    request.onsuccess=()=>{
      const db=request.result;
      db.onversionchange=()=>{db.close();database=undefined;};
      resolve(db);
    };
  });
  void database.catch(()=>{database=undefined;});
  return database;
}
function transaction<T>(db:IDBDatabase,stores:string[],mode:IDBTransactionMode,operation:(tx:IDBTransaction,setResult:(value:T)=>void)=>void):Promise<T>{
  return new Promise((resolve,reject)=>{
    let result:T;
    const tx=mode==='readwrite'?db.transaction(stores,mode,{durability:'strict'}):db.transaction(stores,mode);
    tx.oncomplete=()=>resolve(result);
    tx.onabort=()=>reject(storageError(tx.error,mode==='readonly'));
    tx.onerror=()=>{/* The abort handler reports only after the transaction has failed. */};
    try{operation(tx,value=>{result=value;});}catch(error){tx.abort();reject(storageError(error,mode==='readonly'));}
  });
}
export function loadCustomSounds():Promise<void>{
  reloadRequested=true;
  if(loading)return loading;
  loading=(async()=>{
    do{reloadRequested=false;try{
      const db=await openDatabase();
      const sounds=await transaction<CustomSound[]>(db,['sounds'],'readonly',(tx,result)=>{
        const request=tx.objectStore('sounds').getAll();request.onsuccess=()=>result(request.result as CustomSound[]);
      });
      sounds.sort((a,b)=>a.addedAt-b.addedAt||a.id.localeCompare(b.id));
      publish({sounds,loaded:true,error:''});
    }catch(error){publish({loaded:true,error:error instanceof CustomSoundError?error.message:'无法读取本地音库，请重试。'});}
    }while(reloadRequested);
  })().finally(()=>{loading=undefined;});
  return loading;
}
function changed(change:CustomSoundChange){for(const listener of changeListeners)listener(change);channel?.postMessage(change);}
export async function getCustomSound(id:string):Promise<{sound:CustomSound;blob:Blob}|undefined>{
  const db=await openDatabase();
  return transaction(db,['sounds','blobs'],'readonly',(tx,result)=>{
    let sound:CustomSound|undefined,record:SoundBlob|undefined;
    const finish=()=>result(sound&&record?.blob?{sound,blob:record.blob}:undefined);
    const meta=tx.objectStore('sounds').get(id),content=tx.objectStore('blobs').get(id);
    meta.onsuccess=()=>{sound=meta.result as CustomSound|undefined;finish();};
    content.onsuccess=()=>{record=content.result as SoundBlob|undefined;finish();};
  });
}
export function soundNameFromFile(file:File){return file.name.replace(/\.[^.]+$/,'').trim().slice(0,80)||'Audio';}
function checkedName(name:string){
  const trimmed=name.trim();
  if(!trimmed)throw new CustomSoundError('音频名称不能为空。');
  if(Array.from(trimmed).length>80)throw new CustomSoundError('音频名称最多 80 个字符。');
  return trimmed;
}
async function readDuration(file:File):Promise<number>{
  if(!/\.(mp3|wav|m4a|ogg|flac)$/i.test(file.name))throw new CustomSoundError('请选择 MP3、WAV、M4A、OGG 或 FLAC 音频文件。');
  if(file.size===0)throw new CustomSoundError('音频文件为空，请重新选择。');
  if(file.size>CUSTOM_SOUND_LIMIT)throw new CustomSoundError('单个音频文件不能超过 100 MB。');
  // Metadata is read without playing or decoding the complete recording into PCM.
  const media=new Audio(),url=URL.createObjectURL(file);media.preload='auto';media.muted=true;
  try{
    return await new Promise<number>((resolve,reject)=>{
      const timeout=setTimeout(()=>finish(new CustomSoundError('音频读取超时，请换用其他文件。')),12000);
      const finish=(error?:CustomSoundError)=>{
        clearTimeout(timeout);media.oncanplay=null;media.onerror=null;
        if(error)reject(error);
        else if(!Number.isFinite(media.duration)||media.duration<=0)reject(new CustomSoundError('此音频无法播放，请换用浏览器支持的格式。'));
        else resolve(media.duration);
      };
      media.oncanplay=()=>finish();
      media.onerror=()=>finish(new CustomSoundError('此音频无法播放，请换用浏览器支持的格式。'));
      media.src=url;media.load();
    });
  }finally{media.removeAttribute('src');media.load();URL.revokeObjectURL(url);}
}
export async function importCustomSound(file:File,name=soundNameFromFile(file)):Promise<CustomSound>{
  const label=checkedName(name),duration=await readDuration(file);
  const sound:CustomSound={id:crypto.randomUUID(),name:label,fileName:file.name,size:file.size,mimeType:file.type,duration,addedAt:Date.now()};
  try{
    const db=await openDatabase();
    await transaction<void>(db,['sounds','blobs'],'readwrite',tx=>{
      tx.objectStore('sounds').add(sound);tx.objectStore('blobs').add({id:sound.id,blob:file} satisfies SoundBlob);
    });
  }catch(error){throw storageError(error);}
  await loadCustomSounds();changed({kind:'added',id:sound.id});return sound;
}
export async function renameCustomSound(id:string,name:string):Promise<void>{
  const label=checkedName(name),db=await openDatabase();
  await transaction<void>(db,['sounds'],'readwrite',tx=>{
    const store=tx.objectStore('sounds'),request=store.get(id);
    request.onsuccess=()=>{if(request.result)store.put({...request.result,name:label});else tx.abort();};
  });
  await loadCustomSounds();changed({kind:'renamed',id});
}
export async function removeCustomSound(id:string):Promise<void>{
  const db=await openDatabase();
  await transaction<void>(db,['sounds','blobs'],'readwrite',tx=>{tx.objectStore('sounds').delete(id);tx.objectStore('blobs').delete(id);});
  await loadCustomSounds();changed({kind:'removed',id});
}
if(typeof window!=='undefined'&&typeof BroadcastChannel!=='undefined'){
  channel=new BroadcastChannel('pomodoro-custom-sounds');
  channel.onmessage=event=>{
    const change=event.data as CustomSoundChange;
    if(!change||!['added','renamed','removed'].includes(change.kind)||typeof change.id!=='string')return;
    for(const listener of changeListeners)listener(change);
    void loadCustomSounds();
  };
  window.addEventListener('pagehide',()=>{channel?.close();});
}
