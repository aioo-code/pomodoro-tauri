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

const build=JSON.parse(readFileSync(path.join(root,'tmp/settings-build-current.json')));
const exe=path.join(build.output,'pomodoro-connected.exe');
const evidence=path.join(build.output,'acceptance','micro-'+randomUUID());mkdirSync(evidence,{recursive:true});
const prefs=path.join(evidence,'preferences.json'),results=[],errors=[],localeEvidence=[];
let child,browser,page,reminder,logs='';
const invoke=(command,args)=>page.evaluate(({command,args})=>window.__TAURI__.core.invoke(command,args),{command,args});
const clock=()=>invoke('snapshot'),desktop=()=>invoke('desktop_state');
async function wait(check,label,timeout=12000){const end=Date.now()+timeout;while(Date.now()<end){if(child?.exitCode!=null)throw Error('Owned QA exited: '+logs);if(await check())return;await delay(60);}throw Error('Timed out: '+label);}
async function click(selector){await wait(()=>page.locator(selector).evaluate(e=>!e.disabled),'enabled '+selector);await page.locator(selector).evaluate(e=>e.click());}
async function launch(){
 const server=createServer();server.listen(0,'127.0.0.1');await once(server,'listening');const port=server.address().port;await new Promise(resolve=>server.close(resolve));
 child=spawn(exe,['--qa-hidden','--qa-show-reminders','--qa-preferences-file='+prefs,'--tool-data-dir='+path.join(evidence,'tool-state')],{cwd:evidence,env:{...env,WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS:`--remote-debugging-port=${port} --remote-debugging-address=127.0.0.1`},windowsHide:true,stdio:['ignore','pipe','pipe']});
 for(const stream of[child.stdout,child.stderr])stream.on('data',data=>logs+=data);
 await wait(async()=>{try{return(await fetch(`http://127.0.0.1:${port}/json/version`)).ok;}catch{return false;}},'native launch',40000);
 browser=await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
 await wait(()=>{const pages=browser.contexts().flatMap(c=>c.pages());page=pages.find(p=>/tauri\.localhost/.test(p.url())&&!p.url().includes('reminder'));reminder=pages.find(p=>p.url().includes('reminder'));return page&&reminder;},'WebViews');
 for(const target of[page,reminder])target.on('pageerror',error=>errors.push(error.message));
 await page.waitForFunction(()=>document.getElementById('toggle')&&!document.getElementById('toggle').disabled&&document.documentElement.dataset.language);
}
async function close(){if(child?.exitCode===null){const exited=once(child,'exit');await invoke('desktop_action',{action:'quit'}).catch(()=>{});await Promise.race([exited,delay(8000)]);assert.notEqual(child.exitCode,null);}await browser?.close().catch(()=>{});}
function mark(text){results.push(text);console.log(text);}
function parseTime(text){const[m,s]=text.split(':').map(Number);return m*60+s;}
try{
 const catalog=JSON.parse(readFileSync(path.join(root,'frontend/locales/messages.json')));
 for(const[source,translations]of Object.entries(catalog)){assert.equal(translations.length,4,source);const tokens=text=>[...text.matchAll(/\{\w+\}/g)].map(x=>x[0]).sort();for(const text of translations){assert.ok(text.trim());assert.deepEqual(tokens(text),tokens(source));}}
 await launch();assert.equal(await page.locator('.comet-dial').count(),1);assert.equal(await page.locator('.fuse-button').count(),0);assert.equal(await page.locator('button.focus-primary').count(),1);assert.equal(await page.locator('.jelly-radio').count(),1);assert.equal(await page.locator('.rubber-segment').count(),1);
 assert.equal(await page.locator('#time').getAttribute('data-time'),'25:00');assert.equal(await page.locator('#time').getAttribute('data-numbers-animated'),'true');assert.equal(await page.locator('.rolling-number').count(),2);
 await click('#toggle');await wait(async()=>(await clock()).status==='running','Primary button starts timer');const started=await clock();await delay(4300);assert.equal((await clock()).status,'running');assert.ok((await clock()).remainingMs<started.remainingMs-3500);
 mark('Comet Dial, Jelly Radio and Rubber Segment remain mounted; the bordered primary button preserves running state beyond four seconds; Count Up keeps two-digit time fields');
 const revision=(await clock()).revision;
 for(const[language,title,focusLabel,showLabel]of[['zh','设置','专注','显示番茄时钟'],['en','Settings','Focus','Show Pomodoro'],['ja','設定','集中','ポモドーロを表示'],['de','Einstellungen','Fokus','Pomodoro anzeigen'],['eo','Agordoj','Koncentriĝo','Montri Pomodoro']]){
   await click('#settings');await wait(()=>page.locator('#setting-language').isVisible(),'language setting');
   await wait(()=>page.locator('#setting-language').isEnabled(),'language enabled');await click('#setting-language');await page.locator('[role=option][lang="'+language+'"]').click();
   for(const target of[page,reminder])await target.waitForFunction(language=>document.documentElement.dataset.language===language,language);
   assert.equal(await page.locator('#settings-panel h1').textContent(),title);
   const native=await invoke('language_state');assert.equal(native.language,language);assert.equal(native.trayLabels[0],showLabel);localeEvidence.push(native);
   assert.equal((await clock()).revision,revision);assert.equal((await clock()).status,'running');
   await page.screenshot({path:path.join(evidence,'settings-'+language+'.png'),animations:'disabled'});
   await click('#settings-back');assert.equal((await page.locator('#focus').textContent()).trim(),focusLabel);
   assert.equal(await page.evaluate(()=>document.documentElement.scrollHeight<=innerHeight&&document.documentElement.scrollWidth<=innerWidth),true);
   await page.screenshot({path:path.join(evidence,'main-'+language+'.png'),animations:'disabled'});
 }
 mark('Chinese, English, Japanese, German and Esperanto update live in main/reminder/native tray, save immediately and preserve the running timer');
 await click('#settings');
 for(const theme of ['dark','light']) {
   if(await page.evaluate(()=>document.documentElement.dataset.theme)!==theme)await click('#theme');
   await page.waitForFunction(theme=>document.documentElement.dataset.theme===theme,theme);
   for(const accent of ['blue','candy-lime','candy-purple']) {
     await invoke('set_preferences',{patch:{accent}});await click('#setting-language');await page.getByRole('listbox').waitFor();
     const colors=await page.evaluate(()=>{const rgba=css=>{const c=document.createElement('canvas');c.width=c.height=1;const x=c.getContext('2d');x.fillStyle=css;x.fillRect(0,0,1,1);return [...x.getImageData(0,0,1,1).data];};const popup=document.querySelector('.select-content');return {background:rgba(getComputedStyle(popup).backgroundColor),items:[...document.querySelectorAll('.select-item')].map(item=>({foreground:rgba(getComputedStyle(item).color),background:rgba(getComputedStyle(item).backgroundColor)}))};});
     const luminance=rgb=>rgb.slice(0,3).map(v=>{v/=255;return v<=.04045?v/12.92:((v+.055)/1.055)**2.4;}).reduce((sum,v,i)=>sum+v*[.2126,.7152,.0722][i],0);
     assert.equal(colors.background[3],255,'popup is opaque');assert.ok(theme==='dark'?luminance(colors.background)<.1:luminance(colors.background)>.8);
     for(const item of colors.items){const bg=item.background[3]===0?colors.background:item.background;const values=[luminance(item.foreground),luminance(bg)].sort((a,b)=>a-b);assert.ok((values[1]+.05)/(values[0]+.05)>=4.5,'language item contrast');}
     await page.screenshot({path:path.join(evidence,'language-popup-'+theme+'-'+accent+'.png'),animations:'disabled'});
     await page.keyboard.press('Escape');await page.getByRole('listbox').waitFor({state:'hidden'});assert.equal(await page.locator('#settings-panel').isVisible(),true);await wait(()=>page.evaluate(()=>document.activeElement?.id==='setting-language'),'popup Escape restores focus');
   }
 }
 await page.locator('#setting-language').focus();await page.keyboard.press('Space');await page.getByRole('listbox').waitFor();await page.keyboard.press('Home');await page.locator('[role=option][lang=zh][data-highlighted]').waitFor();await page.keyboard.press('ArrowDown');await page.locator('[role=option][lang=en][data-highlighted]').waitFor();await page.keyboard.press('Enter');await wait(async()=>(await invoke('get_preferences')).values.language==='en','keyboard language choice');
 await invoke('set_preferences',{patch:{cornerRadius:0}});await click('#setting-language');assert.equal(await page.locator('.select-content').evaluate(e=>getComputedStyle(e).borderRadius),'0px');await page.keyboard.press('Escape');await invoke('set_preferences',{patch:{cornerRadius:20}});await click('#settings-back');
 mark('Themed language popup stays opaque and readable in light/dark across candy accents, supports keyboard selection/Escape/focus return, and honors zero corners');

 await click('#settings');await click('#setting-number-animation');await click('#settings-back');await page.waitForFunction(()=>document.getElementById('time').dataset.numbersAnimated==='false');assert.equal(await page.locator('.rolling-number').count(),0);
 await invoke('set_preferences',{patch:{numberAnimation:true,reduceMotion:true}});await page.waitForFunction(()=>document.getElementById('time').dataset.numbersAnimated==='false');
 await invoke('set_preferences',{patch:{reduceMotion:false}});await page.waitForFunction(()=>document.getElementById('time').dataset.numbersAnimated==='true');
 for(const id of['settings','theme','pin','mini','minimize','hide']){const button=page.locator('#'+id);const box=await button.boundingBox();await page.mouse.move(box.x+box.width/2,box.y+box.height/2);assert.equal(await button.evaluate(e=>getComputedStyle(e).backgroundColor),'rgba(0, 0, 0, 0)');}
 await page.mouse.move(10,60);
 mark('Number-animation switch and reduced-motion preference render static digits; every title-bar button stays transparent on hover and while pressed');
 const beforeDirection=await clock();await click('#direction');await wait(async()=>(await invoke('get_preferences')).values.direction==='up','count up');
 await wait(async()=>Math.abs(parseTime(await page.locator('#time').getAttribute('data-time'))-((await clock()).durationMs-(await clock()).remainingMs)/1000)<2,'elapsed digits');assert.equal((await clock()).revision,beforeDirection.revision);
 await click('#mini');await page.waitForFunction(()=>document.body.classList.contains('mini'));await page.locator('.mini-time-control').evaluate(e=>e.click());await page.waitForFunction(()=>document.querySelector('.mini-time-control').dataset.view==='progress');
 assert.equal(await page.locator('.mini-progress .wake-slider').count(),1);assert.equal(await page.locator('.mini-progress .wake-slider__bar').count(),28);assert.equal(await page.locator('.mini-progress button').count(),0);
 const upProgress=Number(await page.locator('.mini-progress').getAttribute('data-remaining')),upClock=await clock();assert.ok(Math.abs(upProgress-(1-upClock.remainingMs/upClock.durationMs))<.01);
 await click('#mini');await page.waitForFunction(()=>!document.body.classList.contains('mini'));await click('#direction');await wait(async()=>(await invoke('get_preferences')).values.direction==='down','countdown restored');assert.equal((await clock()).revision,beforeDirection.revision);
 mark('Direction control sits left of the centered action and switches elapsed/remaining displays, including mini progress, without resetting the native clock');
 await click('#toggle');await wait(async()=>(await clock()).status==='paused','pause');await invoke('action',{action:'remaining:focus:90000'});await wait(()=>page.locator('.comet-dial__ring').getAttribute('aria-valuenow').then(n=>Number(n)===90),'dial reflects native remaining');
 await page.locator('.comet-dial__ring').focus();await page.keyboard.press('ArrowUp');await wait(async()=>(await clock()).remainingMs===91000,'keyboard one second');assert.equal((await clock()).status,'paused');
 await click('#toggle');await wait(async()=>(await clock()).status==='running','resume after adjustment');
 const rect=await page.locator('.comet-dial__ring').boundingBox(),origin=await desktop();
 const point=seconds=>{const angle=(120+(seconds-1)/3599*300)*Math.PI/180;return{x:rect.x+rect.width*(.5+.4*Math.cos(angle)),y:rect.y+rect.height*(.5+.4*Math.sin(angle))};};
 const a=point(91),b=point(420);await page.mouse.move(a.x,a.y);await page.mouse.down();await page.mouse.move(b.x,b.y,{steps:12});await delay(150);await page.mouse.up();
 await wait(async()=>{const c=await clock();return c.remainingMs>418000&&c.remainingMs<=420100;},'trusted dial drag adjusts real running countdown');
 const adjusted=await clock();assert.equal(adjusted.status,'running');assert.equal(adjusted.adjusted,true);assert.equal((await desktop()).x,origin.x);assert.equal((await desktop()).y,origin.y);
 await page.screenshot({path:path.join(evidence,'dial-adjusted.png'),animations:'disabled'});
 const stable=adjusted.revision;await assert.rejects(()=>invoke('action',{action:'remaining:break:10000'}));assert.equal((await clock()).revision,stable);await assert.rejects(()=>invoke('action',{action:'remaining:focus:0'}));assert.equal((await clock()).revision,stable);
 mark('Trusted pointer drag and keyboard adjust actual remaining time while preserving running/paused state; stale-mode and out-of-range requests are rejected');
 async function positionNearEdge(){const d=await desktop();await invoke('drag_to',{x:Math.round(d.x+d.workX+22*d.scale-d.widget.frame.x),y:Math.round(d.y+d.workY+22*d.scale-d.widget.frame.y)});await invoke('drag_update',{gesture:randomUUID(),sequence:1,startX:0,startY:0,x:0,y:0,finish:true,cancelled:false});return desktop();}
 let snapped=await positionNearEdge();assert.ok(Math.abs(snapped.widget.frame.x-snapped.workX-Math.round(12*snapped.scale))<=1);assert.equal(snapped.widget.toolWindow,false);
 await invoke('set_preferences',{patch:{snapToEdges:false}});snapped=await positionNearEdge();assert.ok(Math.abs(snapped.widget.frame.x-snapped.workX-Math.round(22*snapped.scale))<=1);await invoke('set_preferences',{patch:{snapToEdges:true}});
 mark('Main-window release snaps to the same 12-DIP inset as mini, honors the switch and retains normal task-switcher eligibility');
 await invoke('action',{action:'remaining:focus:1000'});await wait(async()=>(await desktop()).reminderVisible,'completion after shortening');await reminder.locator('.orb-canvas').waitFor();await reminder.waitForTimeout(350);
 const orbBounds=await reminder.locator('#orb-interaction').boundingBox();assert.ok(orbBounds.width>=350&&orbBounds.height>=410);assert.equal(await reminder.locator('#orb-interaction svg').count(),0,'background has no central status icon');const reminderClock=await clock(),messageBefore=await reminder.locator('#reminder-message').textContent();const orbPoint=await reminder.evaluate(()=>{for(const x of[12,innerWidth-12,innerWidth/2])for(const y of[innerHeight*.3,innerHeight*.5,innerHeight*.65])if(document.elementFromPoint(x,y)?.closest('#orb-interaction'))return{x,y};return null;});assert.ok(orbPoint,'Orb has a real uncovered pointer target');await reminder.mouse.click(orbPoint.x,orbPoint.y);await wait(async()=>await reminder.locator('#reminder-message').textContent()!==messageBefore,'Orb responds with gentle feedback');assert.equal((await clock()).revision,reminderClock.revision);const feedback=await reminder.locator('#orb-interaction').getAttribute('data-feedback');await reminder.locator('#orb-interaction').press('Enter');await wait(async()=>await reminder.locator('#orb-interaction').getAttribute('data-feedback')!==feedback,'keyboard encouragement');
 const orbBefore=await reminder.locator('.orb-completion').evaluate(e=>e.style.getPropertyValue('--orb-color'));
 await invoke('set_preferences',{patch:{accent:(await invoke('get_preferences')).values.accent==='candy-purple'?'candy-pink':'candy-purple'}});await wait(()=>reminder.locator('.orb-completion').evaluate((e,before)=>e.style.getPropertyValue('--orb-color')!==before,orbBefore),'Orb follows accent');
 await reminder.screenshot({path:path.join(evidence,'orb-reminder.png'),animations:'disabled'});await delay(500);assert.equal((await desktop()).reminderVisible,true);
 await invoke('set_preferences',{patch:{reduceMotion:true}});await wait(()=>reminder.locator('.orb-canvas').count().then(n=>n===0),'reduced-motion static Orb fallback');assert.equal(await reminder.locator('#dismiss').isVisible(),true);
 await reminder.locator('#dismiss').evaluate(e=>e.click());await wait(async()=>!(await desktop()).reminderVisible,'manual dismissal');
 mark('Completion mounts an enlarged theme-colored Orb, responds with local supportive text, persists until explicit dismissal and falls back to a static reminder with reduced motion');
 const values=(await invoke('get_preferences')).values;await invoke('set_preferences',{patch:{language:'en',direction:'up',numberAnimation:false,reduceMotion:false,durations:[...values.durations,{id:'custom-preserve',label:'研究 / Study',minutes:19}]}});
 await close();await launch();const restored=(await invoke('get_preferences')).values;assert.equal(restored.language,'en');assert.equal(restored.direction,'up');assert.equal(restored.numberAnimation,false);assert.equal(restored.durations.at(-1).label,'研究 / Study');
 await page.waitForFunction(()=>document.documentElement.lang==='en');assert.equal((await invoke('language_state')).trayLabels[0],'Show Pomodoro');assert.equal(await page.locator('#time').getAttribute('data-numbers-animated'),'false');
 assert.equal(await page.locator('#time').getAttribute('data-time'),'00:00');await click('#toggle');await wait(async()=>(await clock()).status==='running','count-up fresh start');await delay(200);assert.equal(await page.locator('#time').getAttribute('data-time'),'00:00','count-up waits for a complete first second');await click('#toggle');
 const saved=readFileSync(prefs);await assert.rejects(()=>invoke('set_preferences',{patch:{language:'xx'}}));assert.deepEqual(readFileSync(prefs),saved);
 await page.setViewportSize({width:360,height:480});assert.equal(await page.evaluate(()=>document.documentElement.scrollHeight<=innerHeight&&document.documentElement.scrollWidth<=innerWidth),true);
 mark('Language, direction, numeric-animation preference and original custom names survive native restart; invalid language cannot overwrite preferences; minimum layout fits');
 assert.deepEqual(errors,[]);await close();
 const result={passed:true,version:build.version,sha256:createHash('sha256').update(readFileSync(exe)).digest('hex'),results,errors,localeEvidence,evidence,limits:['Pointer/keyboard input was injected into the actual WebView through CDP; physical touch latency, multi-DPI hardware and Windows 10 real-device execution were not certified.']};
 writeFileSync(path.join(build.output,'acceptance/micro-result.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result));
}catch(error){writeFileSync(path.join(evidence,'failure.json'),JSON.stringify({error:String(error),stack:error.stack,results,errors,logs},null,2));try{await close();}catch{}throw error;}
