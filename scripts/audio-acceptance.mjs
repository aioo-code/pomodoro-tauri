import {chromium} from 'playwright-core';
import {spawn} from 'node:child_process';
import {createServer} from 'node:net';
import {once} from 'node:events';
import {mkdirSync,readFileSync,writeFileSync,cpSync} from 'node:fs';
import {createHash,randomUUID} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import assert from 'node:assert/strict';
import path from 'node:path';
import {root,env} from './environment.mjs';
const build=JSON.parse(readFileSync(path.join(root,'tmp/settings-build-current.json'))),exe=path.join(build.output,'pomodoro-connected.exe');
const evidence=path.join(build.output,'acceptance','audio-'+randomUUID());mkdirSync(evidence,{recursive:true});
const prefs=path.join(evidence,'preferences.json'),results=[],errors=[],signals=[];
writeFileSync(prefs,JSON.stringify({accent:'blue',language:'zh',cornerRadius:20}));
let child,browser,page,reminder,logs='';
const invoke=(command,args,target=page)=>target.evaluate(({command,args})=>window.__TAURI__.core.invoke(command,args),{command,args});
const audio=target=>target.evaluate(()=>window.__POMODORO_AUDIO__.snapshot());
const nodes=target=>target.evaluate(()=>({...window.__audioNodes}));
const values=async()=>(await invoke('get_preferences')).values;
async function wait(check,label,timeout=12000){const end=Date.now()+timeout;while(Date.now()<end){if(child?.exitCode!=null)throw Error('Owned QA exited: '+logs);if(await check())return;await delay(60);}throw Error('Timed out: '+label);}
async function click(target,selector){await wait(()=>target.locator(selector).evaluate(e=>!e.disabled),'enabled '+selector);await target.locator(selector).evaluate(e=>e.click());}
function mark(message){results.push(message);console.log(message);}
async function launch(){
 const server=createServer();server.listen(0,'127.0.0.1');await once(server,'listening');const port=server.address().port;await new Promise(resolve=>server.close(resolve));
 child=spawn(exe,['--qa-hidden','--qa-show-reminders','--qa-seconds=2','--qa-preferences-file='+prefs,'--tool-data-dir='+path.join(evidence,'tool-state')],{cwd:evidence,env:{...env,WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS:`--remote-debugging-port=${port} --remote-debugging-address=127.0.0.1`},windowsHide:true,stdio:['ignore','pipe','pipe']});
 for(const stream of[child.stdout,child.stderr])stream.on('data',data=>logs+=data);
 await wait(async()=>{try{return(await fetch(`http://127.0.0.1:${port}/json/version`)).ok;}catch{return false;}},'native launch',40000);
 browser=await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
 await wait(()=>{const pages=browser.contexts().flatMap(c=>c.pages());page=pages.find(p=>/tauri\.localhost/.test(p.url())&&!p.url().includes('reminder'));reminder=pages.find(p=>p.url().includes('reminder'));return page&&reminder;},'WebViews');
 for(const target of[page,reminder]){
  target.on('pageerror',error=>errors.push(error.message));
  await target.addInitScript(()=>{window.__audioNodes={started:0,ended:0,live:0};const create=AudioContext.prototype.createBufferSource;AudioContext.prototype.createBufferSource=function(...args){const source=create.apply(this,args),start=source.start;source.start=function(...params){const result=start.apply(this,params);window.__audioNodes.started++;window.__audioNodes.live++;source.addEventListener('ended',()=>{window.__audioNodes.ended++;window.__audioNodes.live--;},{once:true});return result;};return source;};});
  await target.reload();await target.waitForFunction(()=>window.__POMODORO_SILENT_AUDIO__===true&&!!window.__POMODORO_AUDIO__);
 }
 await page.waitForFunction(()=>document.getElementById('toggle')&&!document.getElementById('toggle').disabled&&document.documentElement.dataset.preferenceEvents==='ready');
}
async function close(){if(child?.exitCode===null){const exited=once(child,'exit');await invoke('desktop_action',{action:'quit'}).catch(()=>{});await Promise.race([exited,delay(8000)]);assert.notEqual(child.exitCode,null);}await browser?.close().catch(()=>{});}
async function complete(){await invoke('action',{action:'reset'});await invoke('action',{action:'start'});await wait(async()=>(await invoke('desktop_state')).reminderVisible,'native reminder');await wait(async()=>(await invoke('snapshot')).status==='completed','completed timer');}
try{
 await launch();const migrated=await values();for(const[key,value]of Object.entries({audioMuted:false,interactionSounds:true,interactionVolume:28,reminderNoise:true,noiseTexture:'still',noiseVolume:22}))assert.equal(migrated[key],value);
 assert.equal((await audio(reminder)).playing,false);assert.equal(await invoke('audio_window_state',{label:'main'}),true);assert.equal(await invoke('audio_window_state',{label:'reminder'}),true);
 await complete();await wait(async()=>(await audio(reminder)).playing,'autoplay without any reminder gesture');
 const reminderSlider=await reminder.locator('.reminder-audio .elastic-slider').evaluate(e=>{const a=e.getBoundingClientRect(),b=e.closest('.reminder-audio').getBoundingClientRect();return{width:a.width,left:a.left-b.left,right:b.right-a.right,hit:e.querySelector('input').getBoundingClientRect().height,track:parseFloat(getComputedStyle(e.querySelector('.elastic-slider__track')).height)};});
 assert.ok(reminderSlider.width>=180&&reminderSlider.hit>=43.5&&reminderSlider.track>1&&reminderSlider.track<=2.1&&reminderSlider.left>=24&&reminderSlider.right>=24&&Math.abs(reminderSlider.left-reminderSlider.right)<=1.5,JSON.stringify(reminderSlider));
 mark('Reminder volume has a long two-pixel line with balanced 26px panel insets, including coarse pointers, while preserving the native 44-pixel input target.');
 const fadeStart=await audio(reminder);await wait(async()=>(await audio(reminder)).rms>1e-5,'nonzero pre-output signal');await delay(2500);const settled=await audio(reminder);
 assert.equal(settled.context,'running');assert.equal(settled.outputGain,0);assert.ok(settled.noiseGain>fadeStart.noiseGain);assert.ok(Math.abs(settled.noiseGain-.65*Math.pow(.22,1.5))<.001);assert.ok(settled.rms>1e-5&&settled.peak<.2);assert.equal((await nodes(reminder)).live,1);signals.push({fadeStart,settled});
 mark('Legacy settings migrate; real reminder autoplays a fading original noise loop without a gesture. QA keeps native WebViews and final output muted while its analyser confirms a real signal.');
 const beforeSilentClock=await invoke('snapshot'),beforeSilentWindow=await invoke('desktop_state');const soundPreferences=await values(),muteBackground=await page.locator('#mute').evaluate(e=>getComputedStyle(e).backgroundColor);
 await click(page,'#mute');await wait(async()=>(await values()).audioMuted&&(await audio(reminder)).muted&&(await audio(reminder)).masterGain===0,'master mute fades to zero');assert.equal(await page.locator('#mute').getAttribute('aria-pressed'),'true');assert.equal(await page.locator('#mute').evaluate(e=>getComputedStyle(e).backgroundColor),muteBackground);assert.equal((await audio(reminder)).playing,true);assert.equal((await audio(reminder)).deviceGain,0);signals.push({silentMode:await audio(reminder)});
 for(const key of['interactionSounds','interactionVolume','reminderNoise','noiseTexture','noiseVolume'])assert.equal((await values())[key],soundPreferences[key]);
 await click(page,'#settings');assert.equal(await page.locator('#preview-cue').isDisabled(),true);assert.equal(await page.locator('#preview-noise').isDisabled(),true);await click(page,'#settings-back');
 await click(page,'#mute');await wait(async()=>!(await values()).audioMuted&&(await audio(reminder)).masterGain>.79,'unmute restores master output');signals.push({restoredMaster:await audio(reminder)});assert.equal((await invoke('snapshot')).revision,beforeSilentClock.revision);for(const key of['x','y','width','height','pinned','mini'])assert.equal((await invoke('desktop_state'))[key],beforeSilentWindow[key]);
 await click(reminder,'#noise-play');await wait(async()=>!(await audio(reminder)).playing,'manual pause before mute');await click(page,'#mute');await click(page,'#mute');await delay(400);assert.equal((await audio(reminder)).playing,false);await click(reminder,'#noise-play');await wait(async()=>(await audio(reminder)).playing,'resume after mute test');
 mark('Main title-bar silent mode mutes the real master gain, preserves independent volumes/switches and manual pause, blocks previews, and highlights only the icon.');
 const revision=(await invoke('snapshot')).revision;
 await click(reminder,'#noise-play');await wait(async()=>!(await audio(reminder)).playing,'manual pause');await delay(1200);assert.equal((await audio(reminder)).playing,false);assert.equal((await nodes(reminder)).live,0);
 await click(reminder,'#noise-play');await wait(async()=>(await audio(reminder)).playing,'manual resume');await click(reminder,'#noise-texture');await wait(async()=>(await values()).noiseTexture==='space'&&(await audio(reminder)).texture==='space'&&(await audio(reminder)).status==='playing','crossfade texture');await delay(700);assert.equal((await nodes(reminder)).live,1);
 await reminder.locator('#reminder-volume').press('Home');await wait(async()=>(await values()).noiseVolume===0,'keyboard mute saved');await delay(200);assert.equal((await audio(reminder)).noiseGain,0);
 await click(reminder,'#noise-mute');await wait(async()=>(await values()).noiseVolume===22,'restore last audible volume');
 assert.equal((await invoke('snapshot')).revision,revision);
 mark('Manual pause stays paused across polls; resume and texture changes leave one loop; keyboard volume and mute persist without touching timer progress.');
 const saved=readFileSync(prefs);
 for(const patch of[{noiseVolume:101},{interactionVolume:101},{noiseTexture:'storm'}])await assert.rejects(()=>invoke('set_preferences',{patch}));
 await assert.rejects(()=>invoke('set_reminder_audio',{patch:{noiseVolume:50}}));
 await assert.rejects(()=>invoke('set_reminder_audio',{patch:{cornerRadius:0}},reminder));
 await assert.rejects(()=>invoke('set_preferences',{patch:{noiseVolume:50}},reminder));
 assert.deepEqual(readFileSync(prefs),saved);
 mark('Invalid volume/texture and reminder attempts to change non-audio settings are rejected without overwriting preferences.');
 await click(page,'#settings');await page.locator('#audio-heading').waitFor();
 await page.evaluate(()=>{window.__originalAudioPost=Worker.prototype.postMessage;Worker.prototype.postMessage=function(...args){setTimeout(()=>window.__originalAudioPost.apply(this,args),400);};});
 const startedBeforeCancel=(await nodes(page)).started;await click(page,'#preview-noise');await wait(async()=>(await audio(page)).status==='loading','preparing state');assert.equal(await page.locator('#preview-noise').getAttribute('aria-busy'),'true');await click(page,'#preview-noise');await wait(async()=>(await audio(page)).synthesisWorkers===0,'cancelled preparation finishes without playback');assert.equal((await audio(page)).playing,false);assert.equal((await nodes(page)).started,startedBeforeCancel);
 await page.evaluate(()=>{Worker.prototype.postMessage=window.__originalAudioPost;});
 mark('Background synthesis keeps the preview cancellable during preparation; cancelling never starts a late audio source.');
 await click(page,'#preview-noise');await wait(async()=>(await audio(page)).preview,'finite preview');await wait(async()=>!(await audio(reminder)).playing,'single ambience across both windows');await delay(900);assert.ok((await audio(page)).rms>1e-5);await wait(async()=>!(await audio(page)).playing,'8-second preview ends',11000);assert.equal((await nodes(page)).live,0);
 await invoke('set_preferences',{patch:{noiseTexture:'still'}});await click(page,'#preview-noise');await wait(async()=>(await audio(page)).status==='loading','uncached sound prepares');await invoke('set_preferences',{patch:{noiseTexture:'bowl'}});await wait(async()=>(await audio(page)).playing&&(await audio(page)).status==='playing'&&(await audio(page)).texture==='bowl','latest selected sound wins');await delay(700);assert.equal((await nodes(page)).live,1);await click(page,'#settings-back');await wait(async()=>(await nodes(page)).live===0,'leaving settings releases preview');
 mark('Settings preview really processes audio, stops after eight seconds, stops on leaving settings, and never overlaps the reminder loop.');
 await click(page,'#settings');
 for(const theme of['light','dark'])for(const cornerRadius of[0,32]){
  await page.evaluate(theme=>{localStorage.setItem('pomodoro.theme.v1',theme);window.dispatchEvent(new StorageEvent('storage',{key:'pomodoro.theme.v1',newValue:theme}));},theme);
  await invoke('set_preferences',{patch:{cornerRadius,accent:'candy-lime'}});await wait(()=>page.evaluate(({theme,cornerRadius})=>document.documentElement.dataset.theme===theme&&document.documentElement.dataset.cornerRadius===String(cornerRadius),{theme,cornerRadius}),'audio card appearance');
  const styles=await page.evaluate(()=>{const css=s=>getComputedStyle(document.querySelector(s));return{cards:[...document.querySelectorAll('.audio-card')].map(e=>({radius:getComputedStyle(e).borderRadius,top:getComputedStyle(e).borderTopWidth,bottom:getComputedStyle(e).borderBottomWidth,bg:getComputedStyle(e).backgroundColor})),rangeBorder:css('.audio-card .range-setting').borderTopWidth,rangeBg:css('.audio-card .range-setting').backgroundColor,previewBg:css('#preview-noise').backgroundColor,previewTop:css('#preview-noise').borderTopWidth,previewBottom:css('#preview-noise').borderBottomWidth,labels:[...document.querySelectorAll('.noise-choices button span')].map(e=>e.textContent)};});
  assert.equal(styles.cards.length,2);for(const card of styles.cards){assert.equal(card.radius,cornerRadius+'px');assert.ok(parseFloat(card.top)>0&&parseFloat(card.top)<=1.01);assert.equal(card.top,card.bottom);assert.notEqual(card.bg,'rgba(0, 0, 0, 0)');}assert.equal(styles.rangeBorder,'0px');assert.equal(styles.rangeBg,'rgba(0, 0, 0, 0)');assert.notEqual(styles.previewBg,'rgba(0, 0, 0, 0)');assert.ok(parseFloat(styles.previewTop)>0&&parseFloat(styles.previewTop)<=1.01);assert.equal(styles.previewTop,styles.previewBottom);assert.deepEqual(styles.labels,['静心','空灵','颂钵']);
  await page.locator('.audio-card').nth(1).evaluate(e=>e.scrollIntoView({block:'center'}));await page.screenshot({path:path.join(evidence,`settings-meditation-${theme}-${cornerRadius}.png`),animations:'disabled'});
 }
 await click(page,'#settings-back');mark('Sound settings use two complete neutral cards, inset volume controls and themed preview/selection surfaces, including zero/max corners in both themes.');
 await invoke('set_preferences',{patch:{interactionSounds:false}});await delay(300);const beforeMuted=(await nodes(page)).started;await click(page,'#reset');await delay(250);assert.equal((await nodes(page)).started,beforeMuted);
 await invoke('set_preferences',{patch:{interactionSounds:true,interactionVolume:40}});await click(page,'#toggle');await wait(async()=>(await nodes(page)).started>beforeMuted,'start cue');await click(page,'#toggle');await wait(async()=>(await invoke('snapshot')).status==='paused','pause cue');await delay(450);assert.equal((await nodes(page)).live,0);
 mark('GUI actions create short interaction cues; disabling interaction sounds suppresses them. Ended cue nodes are released.');
 await invoke('dismiss_reminder');await invoke('set_preferences',{patch:{reminderNoise:false}});await complete();await delay(700);assert.equal((await audio(reminder)).playing,false);
 await click(reminder,'#noise-play');await wait(async()=>(await audio(reminder)).playing,'manual sound with autoplay off');await invoke('set_preferences',{patch:{cornerRadius:32}});await delay(800);assert.equal((await audio(reminder)).playing,true);
 await click(reminder,'#dismiss');await wait(async()=>!(await invoke('desktop_state')).reminderVisible,'manual dismissal');await wait(async()=>(await nodes(reminder)).live===0,'dismissal releases sound');
 await invoke('set_preferences',{patch:{reminderNoise:true,noiseVolume:22}});await complete();await wait(async()=>(await audio(reminder)).playing,'new reminder restarts once');
 const session=await reminder.context().newCDPSession(reminder);await session.send('Page.setWebLifecycleState',{state:'frozen'});await invoke('dismiss_reminder');assert.equal(await invoke('audio_window_state',{label:'reminder'}),true);assert.equal((await invoke('desktop_state')).reminderVisible,false);await session.send('Page.setWebLifecycleState',{state:'active'});await wait(async()=>!(await audio(reminder)).playing,'dismissal received after renderer thaw');await session.detach();
 mark('Autoplay can be disabled while manual play still works. Dismissal releases sound, and the native WebView stays silent even with a frozen renderer.');
 await complete();
 for(const theme of['light','dark'])for(const accent of['blue','candy-lime']){
  await invoke('set_appearance',{theme});await page.evaluate(theme=>{localStorage.setItem('pomodoro.theme.v1',theme);window.dispatchEvent(new StorageEvent('storage',{key:'pomodoro.theme.v1',newValue:theme}));},theme);
  await invoke('set_preferences',{patch:{accent,cornerRadius:theme==='light'?0:32}});await wait(()=>reminder.evaluate(theme=>document.documentElement.dataset.theme===theme,theme),'reminder theme');await delay(250);await reminder.screenshot({path:path.join(evidence,`reminder-${theme}-${accent}.png`),animations:'disabled'});
 }
 for(const size of[{width:360,height:300},{width:270,height:203},{width:180,height:150}]){await reminder.setViewportSize(size);assert.equal(await reminder.evaluate(()=>{const b=document.getElementById('dismiss').getBoundingClientRect();return b.top>=0&&b.bottom<=innerHeight&&b.left>=0&&b.right<=innerWidth&&document.documentElement.scrollHeight<=innerHeight;}),true);await reminder.screenshot({path:path.join(evidence,`small-${size.width}.png`),animations:'disabled'});}
 await reminder.setViewportSize({width:360,height:420});await click(reminder,'#dismiss');
 await invoke('set_preferences',{patch:{audioMuted:true,interactionSounds:false,interactionVolume:37,reminderNoise:false,noiseTexture:'bowl',noiseVolume:31}});await close();await launch();const restored=await values();for(const[key,value]of Object.entries({audioMuted:true,interactionSounds:false,interactionVolume:37,reminderNoise:false,noiseTexture:'bowl',noiseVolume:31}))assert.equal(restored[key],value);assert.equal((await audio(reminder)).playing,false);
 mark('Light/dark and saturated accents retain calm layout; tiny windows keep dismissal reachable. Silent mode and the five independent audio preferences survive a native restart.');
 assert.deepEqual(errors,[]);await close();
 cpSync(path.join(root,'tmp/meditation-palette'),path.join(evidence,'palette'),{recursive:true});const dsp=JSON.parse(readFileSync(path.join(evidence,'palette/dsp-result.json')));assert.equal(dsp.passed,true);assert.equal(dsp.sourceSha256,createHash('sha256').update(readFileSync(path.join(root,'frontend/lib/audio-dsp.ts'))).digest('hex'));
 const result={passed:true,version:build.version,sha256:createHash('sha256').update(readFileSync(exe)).digest('hex'),results,signals,dsp,errors,evidence,limits:['Original audio is verified by DSP measurements, real Web Audio processing and native mute state. Hardware speaker loudness and listening quality are not certified; QA deliberately mutes device output.','Existing physical touch and mixed-DPI limitations remain unchanged.']};writeFileSync(path.join(build.output,'acceptance/audio-result.json'),JSON.stringify(result,null,2));console.log(JSON.stringify({passed:true,evidence}));
}catch(error){writeFileSync(path.join(evidence,'failure.json'),JSON.stringify({error:String(error),stack:error.stack,results,signals,errors,logs,diagnostics:await Promise.allSettled([page,reminder].filter(Boolean).map(async target=>({audio:await audio(target),nodes:await nodes(target),dom:await target.evaluate(()=>({hidden:document.hidden,preview:document.querySelector('#preview-noise')?.outerHTML}))})))},null,2));try{await close();}catch{}throw error;}
