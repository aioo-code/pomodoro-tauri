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
const evidence=path.join(build.output,'acceptance','elastic-acrylic-'+randomUUID());mkdirSync(evidence,{recursive:true});
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
 await launch();await click(page,'#settings');await page.waitForFunction(()=>!document.documentElement.dataset.sceneTransition);await page.locator('#setting-noise-volume').evaluate(e=>e.scrollIntoView({block:'center'}));
 assert.equal(await page.locator('.audio-card .elastic-slider').count(),2);assert.equal(await reminder.locator('.elastic-slider').count(),1);
 const slider=page.locator('#setting-noise-volume'),track=page.locator('.audio-card').nth(1).locator('.elastic-slider__track');
 const beforeRevision=(await invoke('snapshot')).revision,original=(await values()).noiseVolume;
 const box=await slider.boundingBox();assert.ok(box.height>=44);const y=box.y+box.height/2;
 await page.mouse.move(box.x+box.width*original/100,y);await page.mouse.down();await page.mouse.move(box.x+box.width+20,y,{steps:8});
 assert.equal(await slider.inputValue(),'100');assert.equal((await values()).noiseVolume,original);await delay(120);assert.ok(await track.evaluate(e=>new DOMMatrixReadOnly(getComputedStyle(e).transform).a)>1.001);
 await page.screenshot({path:path.join(evidence,'elastic-pull.png')});await page.mouse.up();await wait(async()=>(await values()).noiseVolume===100,'pointer release commits bounded volume');
 await wait(()=>track.evaluate(e=>Math.abs(new DOMMatrixReadOnly(getComputedStyle(e).transform).a-1)<.0001),'spring settles');assert.equal((await invoke('snapshot')).revision,beforeRevision);
 await wait(()=>slider.isEnabled(),'keyboard slider enabled');await slider.press('Home');await wait(async()=>(await values()).noiseVolume===0,'Home commits zero');await wait(()=>slider.isEnabled(),'keyboard slider enabled');await slider.press('End');await wait(async()=>(await values()).noiseVolume===100,'End commits full volume');await wait(()=>slider.isEnabled(),'keyboard slider enabled');await slider.press('ArrowLeft');await wait(async()=>(await values()).noiseVolume===99,'keyboard step');
 mark('Elastic volume is a native 44px range: immediate bounded tracking, overflow stretch, spring return, keyboard access and commit on release without resetting the clock.');
 await wait(()=>slider.isEnabled(),'touch slider enabled');const touch=await browser.contexts()[0].newCDPSession(page);await touch.send('Emulation.setTouchEmulationEnabled',{enabled:true,maxTouchPoints:5});
 const b=await slider.boundingBox(),point={id:1,x:b.x+b.width*.6,y:b.y+b.height/2,radiusX:6,radiusY:6,force:1};
 await touch.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[point]});await touch.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{...point,x:b.x+b.width*.4}]});await touch.send('Input.dispatchTouchEvent',{type:'touchCancel',touchPoints:[]});
 await delay(350);assert.equal((await values()).noiseVolume,99);assert.equal(await slider.inputValue(),'99');assert.equal(await slider.evaluate(e=>getComputedStyle(e).touchAction),'pan-y');await touch.send('Emulation.setTouchEmulationEnabled',{enabled:false});await touch.detach();
 await invoke('set_preferences',{patch:{reduceMotion:true,cornerRadius:0}});await wait(()=>page.locator('.audio-card .elastic-slider').first().getAttribute('data-reduced-motion').then(v=>v==='true'),'reduced slider');
 const reduced=await slider.boundingBox();await page.mouse.move(reduced.x+reduced.width*.5,reduced.y+22);await page.mouse.down();await page.mouse.move(reduced.x+reduced.width+20,reduced.y+22,{steps:5});assert.equal(await track.evaluate(e=>new DOMMatrixReadOnly(getComputedStyle(e).transform).a),1);assert.equal(await track.evaluate(e=>getComputedStyle(e).borderRadius),'0px');await page.mouse.up();
 await wait(()=>slider.isEnabled(),'released slider enabled');await click(page,'#settings-back');
 mark('Touch cancellation restores the starting volume; vertical scrolling remains available. Reduced motion removes stretch and zero corners produce square tracks.');
 await invoke('set_preferences',{patch:{reduceMotion:false,acrylic:true,miniOpacity:80,dimInactive:false}});await click(page,'#mini');await page.waitForFunction(()=>document.body.classList.contains('mini'));
 const glass=await invoke('desktop_state'),material=await invoke('appearance_state');assert.equal(material.main.acrylic,true);assert.equal(glass.widget.acrylic,true);assert.equal(glass.widget.layered,false);assert.equal(glass.widget.nativeOpacity,100);assert.equal(glass.widget.contentOpacity,80);assert.equal(glass.widget.effectiveOpacity,80);assert.equal(glass.widget.toolWindow,true);assert.equal(glass.widget.appWindow,false);
 await wait(()=>page.locator('.app-shell').evaluate(e=>Math.abs(Number(getComputedStyle(e).opacity)-.8)<.01),'glass content alpha');await page.screenshot({path:path.join(evidence,'mini-glass.png')});
 await invoke('set_preferences',{patch:{miniOpacity:50,dimInactive:true}});await page.mouse.move(1,1);await page.mouse.move(350,180);await invoke('widget_activity',{inside:false});
 await wait(async()=>(await invoke('desktop_state')).widget.dimmed,'inactive glass dims');const dim=await invoke('desktop_state');assert.equal(dim.widget.nativeOpacity,100);assert.equal(dim.widget.contentOpacity,30);assert.equal(dim.widget.effectiveOpacity,30);assert.equal(dim.widget.layered,false);assert.equal((await invoke('appearance_state')).main.acrylic,true);
 await wait(()=>page.locator('.app-shell').evaluate(e=>Math.abs(Number(getComputedStyle(e).opacity)-.3)<.01),'inactive content fade');
 await click(page,'#mini');await page.waitForFunction(()=>!document.body.classList.contains('mini'));assert.equal((await invoke('desktop_state')).widget.nativeOpacity,100);assert.equal((await invoke('desktop_state')).widget.contentOpacity,100);
 await invoke('set_preferences',{patch:{acrylic:false,miniOpacity:50,dimInactive:false}});await click(page,'#mini');await page.waitForFunction(()=>document.body.classList.contains('mini'));const solid=await invoke('desktop_state');assert.equal(solid.widget.acrylic,false);assert.equal(solid.widget.layered,true);assert.equal(solid.widget.nativeOpacity,50);assert.equal(solid.widget.contentOpacity,100);assert.equal(solid.widget.effectiveOpacity,50);assert.equal((await invoke('appearance_state')).main.backdropType,1);
 await click(page,'#mini');await page.waitForFunction(()=>!document.body.classList.contains('mini'));await invoke('set_preferences',{patch:{acrylic:true}});assert.equal((await invoke('appearance_state')).main.acrylic,true);assert.equal((await invoke('desktop_state')).widget.layered,false);
 mark('Mini keeps native Acrylic on a non-layered host while content/tint fade; solid mode retains native whole-window alpha. Main restoration and Alt+Tab shell flags remain correct.');
 assert.deepEqual(errors,[]);await close();
 const result={passed:true,version:build.version,sha256:createHash('sha256').update(readFileSync(exe)).digest('hex'),results,glass,material,dim,solid,errors,evidence,limits:['Pointer/touch events use the actual owned WebView through CDP; hardware touch latency is not certified. Acrylic uses native material state and a non-layered HWND; final appearance follows Windows transparency/compositor support.']};writeFileSync(path.join(build.output,'acceptance/elastic-acrylic-result.json'),JSON.stringify(result,null,2));console.log(JSON.stringify({passed:true,evidence}));
}catch(error){writeFileSync(path.join(evidence,'failure.json'),JSON.stringify({error:String(error),stack:error.stack,results,errors,logs},null,2));try{await close();}catch{}throw error;}
