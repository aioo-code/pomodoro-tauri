import {useEffect,useRef,useState,useSyncExternalStore} from 'react';
import {Check,LoaderCircle,Music2,Pause,Pencil,Play,Plus,Trash2,X} from 'lucide-react';
import {audioState,playNoise,stopNoise,subscribeAudio} from '@/lib/audio';
import {CUSTOM_SOUND_ACCEPT,customSoundError,customSoundsState,getCustomSound,importCustomSound,loadCustomSounds,removeCustomSound,renameCustomSound,soundNameFromFile,subscribeCustomSounds,type CustomSound} from '@/lib/custom-sounds';
import {savePreferences,usePreferences} from '@/lib/preferences';
import {t} from '@/lib/i18n';
import './custom-sounds-panel.css';

function soundDetail(sound:CustomSound){const seconds=Math.round(sound.duration);return `${Math.floor(seconds/60)}:${String(seconds%60).padStart(2,'0')} · ${(sound.size/1024/1024).toFixed(1)} MB`;}
export function CustomSoundsPanel({disabled=false}:{disabled?:boolean}){
  const {values}=usePreferences(),library=useSyncExternalStore(subscribeCustomSounds,customSoundsState),audio=useSyncExternalStore(subscribeAudio,audioState);
  const fileInput=useRef<HTMLInputElement>(null),missingAttempt=useRef('');
  const [pending,setPending]=useState<File>(),[name,setName]=useState(''),[editing,setEditing]=useState(''),[editName,setEditName]=useState('');
  const [busy,setBusy]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState('');
  const locked=disabled||busy;
  useEffect(()=>{void loadCustomSounds();},[]);
  useEffect(()=>{
    if(!values.customNoiseId){missingAttempt.current='';return;}
    if(!disabled&&library.loaded&&!library.error&&!library.sounds.some(sound=>sound.id===values.customNoiseId)&&missingAttempt.current!==values.customNoiseId){
      let cancelled=false;const id=values.customNoiseId;missingAttempt.current=id;
      void getCustomSound(id).then(record=>{if(cancelled)return;if(!record)void savePreferences({customNoiseId:''});else void loadCustomSounds();}).catch(()=>{});
      return()=>{cancelled=true;};
    }
  },[disabled,library.loaded,library.error,library.sounds,values.customNoiseId]);
  async function perform(action:()=>Promise<void>){
    if(locked)return;setBusy(true);setError('');setNotice('');
    try{await action();}catch(cause){setError(customSoundError(cause));}finally{setBusy(false);}
  }
  async function select(id:string){if(!await savePreferences({customNoiseId:id}))setError('未能保存声音选择，请重试。');}
  async function add(){
    if(!pending)return;
    const sound=await importCustomSound(pending,name);setPending(undefined);setName('');setNotice(t('已导入 {name}',{name:sound.name}));
    await select(sound.id);
  }
  async function remove(sound:CustomSound){
    // Clear the shared native selection before removing its bytes; the reminder
    // receives that preference and the library notification in either order.
    if(values.customNoiseId===sound.id&&!await savePreferences({customNoiseId:''})){setError('未能保存声音选择，请重试。');return;}
    await removeCustomSound(sound.id);if(editing===sound.id)setEditing('');setNotice(t('已移除 {name}',{name:sound.name}));
  }
  return <div className="custom-sounds" aria-labelledby="custom-sounds-heading" aria-busy={busy}>
    <div className="custom-sounds-header"><h3 id="custom-sounds-heading"><Music2 aria-hidden="true"/>{t('本地音库')}</h3><button type="button" className="custom-sounds-import" disabled={locked} onClick={()=>fileInput.current?.click()}><Plus aria-hidden="true"/>{t('导入音频')}</button></div>
    <p className="custom-sounds-help">{t('MP3、WAV、M4A、OGG、FLAC；每个文件最多 100 MB。仅保存在本机，不改动原文件。')}</p>
    <input ref={fileInput} id="custom-sound-file" className="sr-only" type="file" accept={CUSTOM_SOUND_ACCEPT} tabIndex={-1} disabled={locked} aria-label={t('导入音频')} onChange={event=>{const file=event.currentTarget.files?.[0];event.currentTarget.value='';if(file){setPending(file);setName(soundNameFromFile(file));setError('');setNotice('');}}}/>
    {pending&&<form className="custom-sounds-form" onSubmit={event=>{event.preventDefault();void perform(add);}}><label htmlFor="custom-sound-name">{t('音频名称')}</label><input id="custom-sound-name" value={name} maxLength={80} disabled={locked} onChange={event=>setName(event.target.value)} autoComplete="off"/><span className="custom-sound-file-name" title={pending.name}>{pending.name}</span><div className="custom-sounds-form-actions"><button type="button" disabled={locked} onClick={()=>setPending(undefined)}>{t('取消')}</button><button type="submit" disabled={locked||!name.trim()}>{busy?<LoaderCircle className="audio-loading"/>:<Plus/>}{t('导入并选用')}</button></div></form>}
    {!library.loaded&&<p className="custom-sounds-status" role="status">{t('正在读取本地音库…')}</p>}
    {library.loaded&&!library.error&&library.sounds.length===0&&!pending&&<p className="custom-sounds-empty">{t('加入自己的雨声、音乐或冥想录音。')}</p>}
    {library.sounds.length>0&&<ul className="custom-sounds-list" aria-label={t('本地音库')}>{library.sounds.map(sound=>{
      const selected=values.customNoiseId===sound.id,preview=audio.texture===`custom:${sound.id}`&&audio.preview&&(audio.playing||audio.status==='loading');
      return <li key={sound.id} className="custom-sound-row" data-selected={selected}>
        {editing===sound.id?<form className="custom-sound-rename" onSubmit={event=>{event.preventDefault();void perform(async()=>{await renameCustomSound(sound.id,editName);setEditing('');});}}><input aria-label={t('音频名称')} value={editName} maxLength={80} disabled={locked} onChange={event=>setEditName(event.target.value)} autoComplete="off"/><button type="submit" disabled={locked||!editName.trim()} aria-label={t('保存名称')} title={t('保存名称')}><Check/></button><button type="button" disabled={locked} aria-label={t('取消重命名')} title={t('取消重命名')} onClick={()=>setEditing('')}><X/></button></form>:<>
          <button type="button" className="custom-sound-select" aria-pressed={selected} aria-label={t('选用 {name}',{name:sound.name})} title={sound.name} disabled={locked} onClick={()=>void perform(()=>select(sound.id))}><span className="custom-sound-marker">{selected?<Check/>:<Music2/>}</span><span className="custom-sound-copy"><span>{sound.name}</span><small>{soundDetail(sound)}</small></span></button>
          <div className="custom-sound-actions"><button type="button" disabled={locked||values.audioMuted||values.noiseVolume===0} aria-label={t(preview?'停止试听':'试听 {name}',{name:sound.name})} title={t(preview?'停止试听':'试听 8 秒')} aria-pressed={preview} onClick={()=>{if(preview)void stopNoise();else void playNoise(`custom:${sound.id}`,true);}}>{preview&&audio.status==='loading'?<LoaderCircle className="audio-loading"/>:preview?<Pause/>:<Play/>}</button><button type="button" disabled={locked} aria-label={t('重命名 {name}',{name:sound.name})} title={t('重命名')} onClick={()=>{setEditing(sound.id);setEditName(sound.name);setError('');}}><Pencil/></button><button type="button" disabled={locked} aria-label={t('移除 {name}',{name:sound.name})} title={t('从本地音库移除')} onClick={()=>void perform(()=>remove(sound))}><Trash2/></button></div>
        </>}
      </li>;
    })}</ul>}
    {(error||library.error)&&<div className="custom-sounds-status custom-sounds-error" role="alert"><span>{t(error||library.error)}</span>{library.error&&<button type="button" disabled={locked} onClick={()=>void loadCustomSounds()}>{t('重试')}</button>}</div>}
    {notice&&!error&&<p className="custom-sounds-status" role="status">{notice}</p>}
  </div>;
}
