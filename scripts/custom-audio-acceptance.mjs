import {chromium} from 'playwright-core';
import {spawn} from 'node:child_process';
import {createServer} from 'node:net';
import {once} from 'node:events';
import {mkdirSync,readFileSync,writeFileSync} from 'node:fs';
import {createHash,randomUUID} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import assert from 'node:assert/strict';
import path from 'node:path';
import {root,env} from './environment.mjs';

// Run against the final connected build. All files, WebView data and preferences
// belong to this QA invocation, and both native output and the audio graph are muted.
const build=JSON.parse(readFileSync(path.join(root,'tmp/settings-build-current.json'))),exe=path.join(build.output,'pomodoro-connected.exe');
const evidence=path.join(build.output,'acceptance','custom-audio-'+randomUUID());mkdirSync(evidence,{recursive:true});
const preferences=path.join(evidence,'preferences.json'),results=[],errors=[],signals=[];
writeFileSync(preferences,JSON.stringify({accent:'blue',language:'zh',cornerRadius:20,interactionSounds:false,noiseVolume:38}));
const rate=24000,frames=rate*2,wav=Buffer.alloc(44+frames*2);
wav.write('RIFF');wav.writeUInt32LE(wav.length-8,4);wav.write('WAVEfmt ',8);wav.writeUInt32LE(16,16);wav.writeUInt16LE(1,20);wav.writeUInt16LE(1,22);wav.writeUInt32LE(rate,24);wav.writeUInt32LE(rate*2,28);wav.writeUInt16LE(2,32);wav.writeUInt16LE(16,34);wav.write('data',36);wav.writeUInt32LE(frames*2,40);
for(let i=0;i<frames;i++)wav.writeInt16LE(Math.round(Math.sin(2*Math.PI*220*i/rate)*5000),44+i*2);
const fixture=path.join(evidence,'rain-original.wav');writeFileSync(fixture,wav);const originalHash=createHash('sha256').update(wav).digest('hex');
let child,browser,page,reminder,logs='';
const invoke=(command,args,target=page)=>target.evaluate(({command,args})=>window.__TAURI__.core.invoke(command,args),{command,args});
const audio=(target=page)=>target.evaluate(()=>window.__POMODORO_AUDIO__.snapshot());
const values=async()=>(await invoke('get_preferences')).values;
async function wait(check,label,timeout=12000){const end=Date.now()+timeout;while(Date.now()<end){if(child?.exitCode!=null)throw Error('Owned QA exited: '+logs);if(await check())return;await delay(60);}throw Error('Timed out: '+label);}
async function click(target,selector){await wait(()=>target.locator(selector).evaluate(element=>!element.disabled),'enabled '+selector);await target.locator(selector).evaluate(element=>element.click());}
function mark(message){results.push(message);console.log(message);}
async function launch(){
  const server=createServer();server.listen(0,'127.0.0.1');await once(server,'listening');const port=server.address().port;await new Promise(resolve=>server.close(resolve));
  child=spawn(exe,['--qa-hidden','--qa-show-reminders','--qa-seconds=2','--qa-preferences-file='+preferences,'--tool-data-dir='+path.join(evidence,'tool-state')],{cwd:evidence,env:{...env,WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS:`--remote-debugging-port=${port} --remote-debugging-address=127.0.0.1`},windowsHide:true,stdio:['ignore','pipe','pipe']});
  for(const stream of[child.stdout,child.stderr])stream.on('data',data=>logs+=data);
  await wait(async()=>{try{return(await fetch(`http://127.0.0.1:${port}/json/version`)).ok;}catch{return false;}},'native launch',40000);
  browser=await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  await wait(()=>{const pages=browser.contexts().flatMap(context=>context.pages());page=pages.find(target=>/tauri\.localhost/.test(target.url())&&!target.url().includes('reminder'));reminder=pages.find(target=>target.url().includes('reminder'));return page&&reminder;},'WebViews');
  for(const target of[page,reminder]){
    target.on('pageerror',error=>errors.push(error.message));
    if(process.env.POMODORO_AUDIO_TRACE==='1'){await target.addInitScript(()=>{
      window.__audioLifecycle=[];const remember=(kind,detail)=>{const list=window.__audioLifecycle;list.push({kind,detail,at:performance.now(),state:window.__POMODORO_AUDIO__?.snapshot(),stack:new Error().stack});if(list.length>160)list.shift();};
      const stop=AudioBufferSourceNode.prototype.stop;AudioBufferSourceNode.prototype.stop=function(...args){remember('buffer-stop',args);return stop.apply(this,args);};
      const pause=HTMLMediaElement.prototype.pause;HTMLMediaElement.prototype.pause=function(...args){remember('media-pause',this.src);return pause.apply(this,args);};
      const suspend=AudioContext.prototype.suspend;AudioContext.prototype.suspend=function(...args){remember('context-suspend',this.currentTime);return suspend.apply(this,args);};
      const Channel=BroadcastChannel;window.BroadcastChannel=class extends Channel{constructor(name){super(name);if(name==='pomodoro-ambient-audio')this.addEventListener('message',event=>remember('channel-in',event.data));}postMessage(value){if(this.name==='pomodoro-ambient-audio')remember('channel-out',value);return super.postMessage(value);}};
    });
    await target.reload();}await target.waitForFunction(()=>window.__POMODORO_SILENT_AUDIO__===true&&!!window.__POMODORO_AUDIO__);
  }
  await page.waitForFunction(()=>document.getElementById('settings')&&document.documentElement.dataset.preferenceEvents==='ready');
  assert.equal(await invoke('audio_window_state',{label:'main'}),true);assert.equal(await invoke('audio_window_state',{label:'reminder'}),true);
}
async function close(){
  if(child?.exitCode===null){const exited=once(child,'exit');await invoke('desktop_action',{action:'quit'}).catch(()=>{});await Promise.race([exited,delay(8000)]);assert.notEqual(child.exitCode,null,'Owned QA closes normally');}
  await browser?.close();child=browser=page=reminder=undefined;
}
async function library(){return page.evaluate(()=>new Promise((resolve,reject)=>{const open=indexedDB.open('pomodoro-custom-sounds',1);open.onerror=()=>reject(open.error);open.onsuccess=()=>{const db=open.result,tx=db.transaction(['sounds','blobs'],'readonly'),metadata=tx.objectStore('sounds').getAll(),blobs=tx.objectStore('blobs').getAll();tx.oncomplete=()=>{const result={sounds:metadata.result,blobs:blobs.result.map(record=>({id:record.id,size:record.blob.size}))};db.close();resolve(result);};tx.onabort=()=>{db.close();reject(tx.error);};};}));}
async function choose(file,name){await page.locator('#custom-sound-file').setInputFiles(file);await page.locator('#custom-sound-name').fill(name);await click(page,'.custom-sounds-form button[type="submit"]');}
async function complete(){await invoke('action',{action:'reset'});await invoke('action',{action:'start'});await wait(async()=>(await invoke('desktop_state')).reminderVisible,'native reminder');await wait(async()=>(await invoke('snapshot')).status==='completed','completed timer');}
try{
  await launch();assert.equal((await values()).customNoiseId,'');await click(page,'#settings');await page.locator('#custom-sounds-heading').waitFor();
  await choose({name:'unsupported.txt',mimeType:'text/plain',buffer:Buffer.from('not audio')},'Unsupported');await wait(()=>page.locator('.custom-sounds-error').isVisible(),'unsupported format error');assert.match(await page.locator('.custom-sounds-error').innerText(),/MP3/);assert.equal((await library()).sounds.length,0);
  await choose({name:'corrupt.wav',mimeType:'audio/wav',buffer:Buffer.from('not a valid wave file')},'Corrupt');await wait(async()=>/无法播放/.test(await page.locator('.custom-sounds-error').innerText()),'corrupt audio error');assert.equal((await library()).sounds.length,0);
  await page.evaluate(()=>{const input=document.getElementById('custom-sound-file'),transfer=new DataTransfer(),chunk=new Blob([new Uint8Array(1024*1024)]);transfer.items.add(new File(Array(101).fill(chunk),'large.wav',{type:'audio/wav'}));input.files=transfer.files;input.dispatchEvent(new Event('change',{bubbles:true}));});
  await click(page,'.custom-sounds-form button[type="submit"]');await wait(async()=>/100 MB/.test(await page.locator('.custom-sounds-error').innerText()),'oversized file error');assert.equal((await library()).sounds.length,0);
  mark('Unsupported, corrupt and oversized files are rejected before library writes; the size limit is 100 MB per file.');
  await choose(fixture,'雨声 QA · Local Rain');await wait(async()=>!!(await values()).customNoiseId,'custom selection');const id=(await values()).customNoiseId;assert.match(id,/^[0-9a-f-]{36}$/i);
  const imported=await library();assert.equal(imported.sounds.length,1);assert.equal(imported.sounds[0].name,'雨声 QA · Local Rain');assert.equal(imported.blobs[0].size,wav.length);assert.equal(imported.sounds[0].duration,2);
  await wait(async()=>(await reminder.locator('#noise-texture > span').innerText())==='雨声 QA · Local Rain','shared reminder library');
  assert.equal((await audio()).playing,false);assert.equal((await audio()).mediaSources,0);assert.equal((await audio(reminder)).playing,false);
  mark('Import probes playable metadata without playback, preserves the original file, stores blob and metadata atomically, selects a UUID, and refreshes the reminder.');
  await click(page,'.custom-sound-actions button[title="重命名"]');await page.locator('.custom-sound-rename input').fill('My Rain · 冥想');await click(page,'.custom-sound-rename button[type="submit"]');await wait(async()=>(await reminder.locator('#noise-texture > span').innerText())==='My Rain · 冥想','shared rename');
  await invoke('set_preferences',{patch:{language:'en'}});assert.equal(await reminder.locator('#noise-texture > span').innerText(),'My Rain · 冥想');await invoke('set_preferences',{patch:{language:'zh'}});
  await click(page,'#preview-noise');await wait(async()=>(await audio()).playing&&(await audio()).texture===`custom:${id}`,'custom preview');await wait(async()=>(await audio()).rms>1e-5,'real custom analyser signal');const preview=await audio();signals.push({preview});assert.equal(preview.mediaSources,1);assert.equal(preview.synthesisWorkers,0);assert.equal(preview.deviceGain,0);assert.equal(preview.outputGain,0);
  await wait(async()=>!(await audio()).playing,'eight second custom preview ends',11000);assert.equal((await audio()).mediaSources,0);
  mark('User names survive translation; streaming playback produces a real analyser signal through the shared silent graph and releases its media source after eight seconds.');
  await page.evaluate(()=>{window.__customQaPlay=HTMLMediaElement.prototype.play;HTMLMediaElement.prototype.play=function(...args){return new Promise((resolve,reject)=>setTimeout(()=>window.__customQaPlay.apply(this,args).then(resolve,reject),400));};});
  await click(page,'#preview-noise');await wait(async()=>(await audio()).status==='loading','custom preparation');await click(page,'#preview-noise');await delay(700);assert.equal((await audio()).playing,false);assert.equal((await audio()).mediaSources,0);assert.equal((await audio()).pendingTexture,null);
  await page.evaluate(()=>{HTMLMediaElement.prototype.play=window.__customQaPlay;});
  await click(page,'#preview-noise');await wait(async()=>(await audio()).playing,'restart custom preview');await click(page,'.noise-choices button[data-texture="bowl"]');await wait(async()=>(await values()).customNoiseId===''&&(await audio()).texture==='bowl'&&(await audio()).status==='playing','built-in selection wins');await wait(async()=>(await audio()).mediaSources===0,'retired stream disposed');
  mark('Cancelling a pending stream never starts late audio; selecting a built-in clears the custom UUID and disposes the replaced stream after crossfade.');
  await invoke('set_preferences',{patch:{customNoiseId:id,noiseTexture:'still'}});await click(page,'#settings-back');await wait(async()=>!(await audio()).playing,'leaving settings stops custom preview');
  await close();await launch();assert.equal((await values()).customNoiseId,id);await click(page,'#settings');await wait(async()=>(await page.locator('.custom-sound-copy > span').innerText())==='My Rain · 冥想','library persists after native restart');assert.equal((await library()).blobs[0].size,wav.length);await click(page,'#settings-back');
  await complete();await wait(async()=>(await audio(reminder)).playing&&(await audio(reminder)).texture===`custom:${id}`,'reminder streams selected local audio');assert.equal((await audio(reminder)).deviceGain,0);assert.equal((await audio(reminder)).mediaSources,1);
  await click(reminder,'#noise-play');await wait(async()=>!(await audio(reminder)).playing,'manual pause');await invoke('set_preferences',{patch:{customNoiseId:'',noiseTexture:'space'}});await invoke('set_preferences',{patch:{customNoiseId:id}});await delay(1000);assert.equal((await audio(reminder)).playing,false);
  await click(reminder,'#noise-play');await wait(async()=>(await audio(reminder)).playing&&(await audio(reminder)).texture===`custom:${id}`,'manual resume custom');
  await invoke('set_preferences',{patch:{audioMuted:true}});await wait(async()=>(await audio(reminder)).masterGain===0,'custom master mute');assert.equal((await audio(reminder)).playing,true);await invoke('set_preferences',{patch:{audioMuted:false}});await wait(async()=>(await audio(reminder)).masterGain>.79,'custom unmute');
  await click(reminder,'#noise-texture');await wait(async()=>(await values()).customNoiseId===''&&(await audio(reminder)).texture==='still','reminder cycles custom to built-in');
  await click(reminder,'#noise-texture');await click(reminder,'#noise-texture');await click(reminder,'#noise-texture');await wait(async()=>(await values()).customNoiseId===id&&(await audio(reminder)).texture===`custom:${id}`,'reminder cycles back into custom library');
  mark('Blobs and selection persist across a real native restart; reminder autoplay, manual pause, master mute and cycling include local sounds.');
  await click(page,'#settings');await click(page,'.custom-sound-actions button[title="从本地音库移除"]');await wait(async()=>(await values()).customNoiseId===''&&(await library()).sounds.length===0,'selected deletion clears shared preference');await wait(async()=>(await audio(reminder)).playing&&(await audio(reminder)).texture==='bowl','reminder falls back to retained built-in');await wait(async()=>(await audio(reminder)).mediaSources===0,'retired reminder stream disposed');assert.equal((await library()).blobs.length,0);
  assert.equal(createHash('sha256').update(readFileSync(fixture)).digest('hex'),originalHash);await click(reminder,'#dismiss');await wait(async()=>!(await audio(reminder)).playing,'dismissal stops fallback');assert.deepEqual(errors,[]);await close();
  mark('Removing the selected local sound clears its native UUID, removes only the app copy, crossfades the reminder to its built-in fallback and leaves the original file intact.');
  const result={passed:true,version:build.version,sha256:createHash('sha256').update(readFileSync(exe)).digest('hex'),results,signals,errors,evidence,limits:['The generated WAV verifies decoding, graph routing, persistence and lifecycle. Actual listening quality, all codecs and storage quota exhaustion are not certified. Device output remains deliberately muted.']};writeFileSync(path.join(build.output,'acceptance/custom-audio-result.json'),JSON.stringify(result,null,2));console.log(JSON.stringify({passed:true,evidence}));
}catch(error){writeFileSync(path.join(evidence,'failure.json'),JSON.stringify({error:String(error),stack:error.stack,results,signals,errors,logs,diagnostics:await Promise.allSettled([page,reminder].filter(Boolean).map(async target=>({url:target.url(),audio:await audio(target),lifecycle:await target.evaluate(()=>window.__audioLifecycle),dom:await target.evaluate(()=>({error:document.querySelector('.custom-sounds-error')?.textContent,preview:document.querySelector('#preview-noise')?.outerHTML}))})))},null,2));try{await close();}catch{}throw error;}
