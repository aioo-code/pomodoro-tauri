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

const read=file=>JSON.parse(readFileSync(file)),hash=file=>createHash('sha256').update(readFileSync(file)).digest('hex');
const build=read(path.join(root,'tmp/settings-build-current.json')),exe=path.join(build.output,'pomodoro-connected.exe');
const evidence=path.join(build.output,'acceptance','popup-motion-'+randomUUID());mkdirSync(evidence,{recursive:true});
const results=[],errors=[],matrix=[];let child,browser,page,reminder,logs='';
const invoke=(command,args,target=page)=>target.evaluate(({command,args})=>window.__TAURI__.core.invoke(command,args),{command,args});
const values=async()=>(await invoke('get_preferences')).values,clock=()=>invoke('snapshot');
async function wait(check,label,timeout=12000){const end=Date.now()+timeout;while(Date.now()<end){if(child?.exitCode!=null)throw Error('Owned QA exited: '+logs);if(await check())return;await delay(40);}throw Error('Timed out: '+label);}
async function click(selector){const element=page.locator(selector);await wait(()=>element.evaluate(e=>!e.disabled),'enabled '+selector);await element.evaluate(e=>e.click());}
async function launch(){
 const server=createServer();server.listen(0,'127.0.0.1');await once(server,'listening');const port=server.address().port;await new Promise(resolve=>server.close(resolve));
 child=spawn(exe,['--qa-hidden','--qa-preferences-file='+path.join(evidence,'preferences.json'),'--tool-data-dir='+path.join(evidence,'tool-state')],{cwd:evidence,env:{...env,WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS:`--remote-debugging-port=${port} --remote-debugging-address=127.0.0.1`},windowsHide:true,stdio:['ignore','pipe','pipe']});
 for(const stream of[child.stdout,child.stderr])stream.on('data',data=>logs+=data);
 await wait(async()=>{try{return(await fetch(`http://127.0.0.1:${port}/json/version`)).ok;}catch{return false;}},'native launch',40000);
 browser=await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
 await wait(()=>{const pages=browser.contexts().flatMap(c=>c.pages());page=pages.find(p=>/tauri\.localhost/.test(p.url())&&!p.url().includes('reminder'));reminder=pages.find(p=>p.url().includes('reminder'));return page&&reminder;},'WebViews');
 for(const target of[page,reminder]){target.on('pageerror',e=>errors.push(e.message));await target.waitForFunction(()=>document.documentElement.dataset.preferenceEvents==='ready');}
 await page.waitForFunction(()=>document.getElementById('toggle')&&!document.getElementById('toggle').disabled);
}
async function close(){if(child?.exitCode===null){const exited=once(child,'exit');await invoke('desktop_action',{action:'quit'}).catch(()=>{});await Promise.race([exited,delay(8000)]);assert.notEqual(child.exitCode,null);}await browser?.close();}
function mark(text){results.push(text);console.log(text);}
try{
 await launch();await invoke('set_preferences',{patch:{audioMuted:true,numberAnimation:false,reduceMotion:true}});
 const manifest=read(path.join(root,'frontend/components/reactbits/timer-effect-sources.json'));
 for(const[file,source]of Object.entries(manifest.files))assert.equal(hash(path.join(root,'frontend/components/reactbits',file)),source.adaptedSha256);
 assert.equal(read(path.join(build.output,'licenses/react-bits-timer-effect-sources.json')).commit,manifest.commit);
 await invoke('action',{action:'start'});await invoke('action',{action:'pause'});await invoke('action',{action:'remaining:focus:375000'});
 for(const theme of['dark','light']){
  if(await page.evaluate(()=>document.documentElement.dataset.theme)!==theme){await click('#theme');await wait(()=>page.evaluate(theme=>document.documentElement.dataset.theme===theme,theme),'theme');}
  for(const style of['arc','orbit'])for(const accent of['blue','candy-lime','black','white']){
   await invoke('set_preferences',{patch:{timerStyle:style,accent}});await wait(()=>page.locator('.timer-view').getAttribute('data-view').then(v=>v===style),'effect mounts');
   const actual=await clock(),progress=actual.remainingMs/actual.durationMs;
   await wait(()=>page.locator('.timer-view').getAttribute('data-progress').then(v=>Math.abs(Number(v)-progress)<.0001),'native fraction');
   if(style==='arc'){
    assert.equal(await page.locator('.status-mark[data-indeterminate]').count(),0);
    const ring=await page.locator('.status-mark__ring').evaluate(e=>{const dash=e.getAttribute('stroke-dasharray').split(/[ ,]+/).map(Number);return{fraction:dash[0]/(dash[0]+dash[1]),r:Number(e.getAttribute('r'))};});assert.ok(Math.abs(ring.fraction-progress)<.0001);assert.ok(ring.r>0);assert.equal(await page.locator('#time').evaluate(e=>e.classList.contains('sr-only')),true);
   }else{
    await wait(()=>page.locator('.slosh-gauge').getAttribute('aria-valuenow').then(n=>Number(n)===Math.round(progress*100)),'liquid fraction');
    const level=await page.locator('.slosh-gauge__liquid').evaluate(e=>Number(e.style.clipPath.match(/[\d.]+(?=%)/)?.[0]));assert.ok(Math.abs(level-(1-progress)*100)<.01);assert.equal(await page.locator('.slosh-gauge').getAttribute('data-interactive'),'false');
   }
   matrix.push({theme,style,accent,progress});
  }
  await page.screenshot({path:path.join(evidence,'liquid-'+theme+'.png'),animations:'disabled'});
 }
 mark('Both vendored React Bits effects use actual native remaining progress in both themes and four contrasting accents. No indeterminate spinner or duplicate interactive slider is used.');
 for(const icon of['flow','orbit','bloom','prism','graphite']){
  await invoke('set_preferences',{patch:{icon}});
  for(const target of[page,reminder])await wait(()=>target.locator('.brand img.app-mark').evaluate((e,id)=>e.dataset.appIcon===id&&e.complete&&e.naturalWidth>0,icon),'shared image '+icon);
  assert.equal((await invoke('icon_state')).choice,icon);
 }
 mark('All five chosen application icons synchronize in main/reminder title bars with the actual native icon choice.');
 for(const selector of['#settings','#hide','.usage-day:last-child']){
  await page.mouse.move(1,1);await page.locator(selector).hover();const tip=page.locator('[data-slot="tooltip-content"][data-window-tip="regular"]');await tip.waitFor({state:'visible'});
  const bounds=await tip.evaluate(e=>{const r=e.getBoundingClientRect();return{x:r.x,y:r.y,right:r.right,bottom:r.bottom,width:innerWidth,height:innerHeight};});assert.ok(bounds.x>=8&&bounds.y>=8&&bounds.right<=bounds.width-8&&bounds.bottom<=bounds.height-8,JSON.stringify(bounds));matrix.push({selector,regularTip:bounds});
 }
 await page.mouse.move(1,1);await page.keyboard.press('Escape');
 await invoke('set_preferences',{patch:{icon:'flow',accent:'blue',reduceMotion:false}});
 await page.evaluate(()=>{
  window.__motionTrace=[];window.__nativeActions=[];const api=window.__TAURI__,native=api.core.invoke;const wrapped=(command,args,options)=>{if(command==='desktop_action')window.__nativeActions.push(args.action);return native(command,args,options);};window.__TAURI__={...api,core:{...api.core,invoke:wrapped}};if(window.__TAURI__.core.invoke!==wrapped)throw Error('QA invoke interception unavailable');
  window.__startViewTransition=document.startViewTransition;
  if(document.startViewTransition)document.startViewTransition=function(update){const record={scene:document.documentElement.dataset.sceneTransition,updates:0,ready:false,skipped:false};window.__motionTrace.push(record);const transition=window.__startViewTransition.call(document,async()=>{record.updates++;await update();});transition.ready.then(()=>record.ready=true,()=>record.skipped=true);return transition;};window.__tracedViewTransition=document.startViewTransition;
 });
 const before=await clock();
 await click('#settings');await page.locator('#settings-panel').waitFor();await click('#settings-back');await page.locator('#toggle').waitFor({state:'visible'});
 await click('#timer-view-next');await wait(async()=>(await values()).timerStyle==='ticks','style preserves state');assert.equal((await clock()).revision,before.revision);
 await page.locator('#mini').evaluate(e=>{e.click();e.click();e.click();});await page.waitForFunction(()=>document.body.classList.contains('mini'));
 assert.deepEqual(await page.evaluate(()=>window.__nativeActions),['mini']);
 assert.equal(await page.evaluate(()=>window.__motionTrace.filter(item=>item.scene==='window').length),0,'Native geometry changes do not wait for compositor snapshots');
 const beforeMiniSwitch=await clock();
 const miniBlend=await page.locator('.mini-time-control').evaluate(control=>new Promise((resolve,reject)=>{
  const a=control.querySelector('.mini-view-digits'),b=control.querySelector('.mini-view-progress');
  // Commit the old styles and sample each CSS transition at its midpoint.
  // The hidden WebView's frame clock need not advance in wall-clock time.
  getComputedStyle(a).opacity;
  getComputedStyle(b).opacity;
  const observer=new MutationObserver(()=>{
   observer.disconnect();clearTimeout(deadline);
   const duration=getComputedStyle(a).transitionDuration;
   getComputedStyle(b).opacity;
   const animations=[a,b].flatMap(layer=>layer.getAnimations().filter(animation=>animation.transitionProperty==='opacity'));
   for(const animation of animations)animation.currentTime=animation.effect.getComputedTiming().duration/2;
   resolve({a:Number(getComputedStyle(a).opacity),b:Number(getComputedStyle(b).opacity),duration,animations:animations.length,width:a.getBoundingClientRect().width,otherWidth:b.getBoundingClientRect().width});
  });
  const deadline=setTimeout(()=>{observer.disconnect();reject(Error('Timed out: mini visual toggle'));},8000);
  observer.observe(control,{attributes:true,attributeFilter:['data-view']});
  control.click();
 }));
 if(miniBlend.duration!=='0s')assert.equal(miniBlend.animations,2,JSON.stringify(miniBlend));
 if(miniBlend.duration!=='0s')assert.ok(miniBlend.a>0&&miniBlend.a<1&&miniBlend.b>0&&miniBlend.b<1,JSON.stringify(miniBlend));
 assert.equal(miniBlend.width,miniBlend.otherWidth);assert.equal((await clock()).revision,beforeMiniSwitch.revision);matrix.push({miniBlend});
 await page.locator('.mini-time-control').evaluate(e=>e.click());await delay(200);
 const cdp=await browser.contexts()[0].newCDPSession(page);await cdp.send('Emulation.clearDeviceMetricsOverride');
 for(const language of['zh','en','ja','de','eo']){
  await click('#mini');await page.waitForFunction(()=>!document.body.classList.contains('mini'));await invoke('set_preferences',{patch:{language}});await click('#mini');await page.waitForFunction(()=>document.body.classList.contains('mini'));
  for(const selector of['#mini','#toggle','.mini-time-control']){
   await page.mouse.move(1,1);const button=page.locator(selector);await button.hover();
   const tip=page.locator('[data-slot="tooltip-content"][data-window-tip="compact"]');await tip.waitFor({state:'visible'});
   assert.equal(await page.locator('.mini-feedback').evaluate(e=>getComputedStyle(e).opacity),'0','The active button hint replaces the footer text');
   const geometry=await tip.evaluate(e=>{const r=e.getBoundingClientRect(),controls=[document.getElementById('toggle'),document.getElementById('mini')].map(c=>c.getBoundingClientRect());return{x:r.x,y:r.y,right:r.right,bottom:r.bottom,height:r.height,width:r.width,viewport:[innerWidth,innerHeight],controlsBottom:Math.max(...controls.map(c=>c.bottom)),text:e.textContent,arrows:document.querySelectorAll('.compact-tip-layer .tooltip-arrow').length};});
   assert.ok(geometry.x>=8&&geometry.right<=geometry.viewport[0]-8&&geometry.bottom<=geometry.viewport[1]-3,JSON.stringify(geometry));assert.ok(geometry.y>=geometry.controlsBottom+2,JSON.stringify(geometry));assert.equal(geometry.arrows,0);assert.equal(geometry.height,14);matrix.push({language,selector,tip:geometry});
  }
 }
 await page.screenshot({path:path.join(evidence,'mini-tip.png')});
 await page.mouse.move(1,1);await page.keyboard.press('Escape');await page.locator('#mini').focus();await page.locator('[data-window-tip="compact"]').waitFor({state:'visible'});await page.keyboard.press('Escape');await wait(()=>page.locator('[data-window-tip="compact"]').count().then(n=>n===0),'Escape closes tip');
 assert.equal(await page.locator('.mini-feedback').evaluate(e=>getComputedStyle(e).opacity),'1','Closing the hint restores the footer');
 // The last main style must never leak its vertical padding into the mini clock.
 for(const style of['comet','arc','orbit','ticks','digits']){
  await assert.rejects(()=>invoke('set_preferences',{patch:{timerStyle:style}}));
  // Main-only preference mutations are intentionally refused in mini; exercise
  // the retained style through normal restore/change/compact transitions.
  await click('#mini');await page.waitForFunction(()=>!document.body.classList.contains('mini'));
  await invoke('set_preferences',{patch:{timerStyle:style}});await click('#mini');await page.waitForFunction(()=>document.body.classList.contains('mini'));
  const geometry=await page.evaluate(()=>{const time=document.getElementById('time').getBoundingClientRect(),button=document.getElementById('toggle').getBoundingClientRect(),face=document.querySelector('.clock-face').getBoundingClientRect();return{height:innerHeight,time:[time.y,time.bottom],button:[button.y,button.bottom],face:[face.y,face.bottom],padding:getComputedStyle(document.querySelector('.clock-face')).paddingBottom};});
  assert.equal(geometry.padding,'0px');assert.ok(geometry.face[0]>=0&&geometry.face[1]<=geometry.height-14,JSON.stringify(geometry));assert.ok(Math.abs((geometry.time[0]+geometry.time[1]-geometry.button[0]-geometry.button[1])/2)<1,JSON.stringify(geometry));
 }
 mark('Mini hints fit inside its 280×80 client area in all five languages, without arrows or control overlap. Focus/Escape work; every retained timer style keeps the compact time vertically centered.');
 await page.evaluate(()=>{
  const api=window.__TAURI__,native=api.core.invoke;window.__restoreFailure=api;const wrapped=(command,args,options)=>command==='snapshot'?Promise.reject(Error('QA timer unavailable')):native(command,args,options);window.__TAURI__={...api,core:{...api.core,invoke:wrapped}};
 });
 await page.locator('.mini-feedback #error').waitFor();
 await page.locator('#mini').hover();await wait(()=>page.locator('[data-window-tip="compact"]').count().then(n=>n===1),'suppressed hint mounts');assert.equal(await page.locator('[data-window-tip="compact"]').evaluate(e=>getComputedStyle(e).visibility),'hidden');
 assert.equal(await page.locator('.mini-feedback').evaluate(e=>getComputedStyle(e).opacity),'1','An alert keeps the footer visible');
 const footer=await page.locator('.mini-feedback').boundingBox();assert.ok(footer.y>=62&&footer.y+footer.height<=77);
 await page.evaluate(()=>{window.__TAURI__=window.__restoreFailure;});await wait(()=>page.locator('.mini-feedback[data-kind="alert"]').count().then(n=>n===0),'failure recovers');assert.equal(await page.locator('.mini-feedback .mini-message').count(),1);
 await click('#mini');await page.waitForFunction(()=>!document.body.classList.contains('mini'));
 // Missing or rejected transition snapshots must not repeat native operations.
 await page.evaluate(()=>{document.startViewTransition=()=>{throw new DOMException('QA snapshot unavailable','InvalidStateError');};});
 const oldActions=await page.evaluate(()=>window.__nativeActions.length);await click('#mini');await page.waitForFunction(()=>document.body.classList.contains('mini'));assert.equal(await page.evaluate(()=>window.__nativeActions.length),oldActions+1);await click('#mini');await page.waitForFunction(()=>!document.body.classList.contains('mini'));
 await page.evaluate(()=>{document.startViewTransition=window.__tracedViewTransition;});
 await invoke('set_preferences',{patch:{reduceMotion:true}});const traceLength=await page.evaluate(()=>window.__motionTrace.length);await click('#settings');await page.locator('#settings-panel').waitFor();await click('#settings-back');await page.locator('#toggle').waitFor({state:'visible'});assert.equal(await page.evaluate(()=>window.__motionTrace.length),traceLength);
 const trace=await page.evaluate(()=>window.__motionTrace);assert.ok(trace.length>=3);for(const item of trace)assert.equal(item.updates,1);matrix.push({transitions:trace});
 mark('View-transition callbacks run once, rapid mini clicks issue one native action, unavailable snapshots fall back, reduced motion bypasses animation, and timer state is preserved. Error and hint footer priorities recover cleanly.');
 await reminder.setViewportSize({width:280,height:300});
 await reminder.evaluate(()=>{const message=document.querySelector('.reminder-message-region');message.querySelector('h1').textContent='Lange Erinnerung';message.querySelector('p:last-of-type').textContent=Array(60).fill('Eine ruhige Pause. ').join('');});
 const message=reminder.locator('.reminder-message-region');await wait(()=>message.getAttribute('data-scrollable').then(v=>v==='true'),'overflow enables message scrolling');
 assert.equal(await message.evaluate(e=>getComputedStyle(e).pointerEvents),'auto');assert.equal(await message.evaluate(e=>getComputedStyle(e).justifyContent),'safe center');
 const box=await message.boundingBox();await reminder.mouse.move(box.x+box.width/2,box.y+Math.min(box.height-4,20));await reminder.mouse.wheel(0,200);await wait(()=>message.evaluate(e=>e.scrollTop>0),'long message wheel scroll');
 assert.equal(await reminder.locator('#dismiss').evaluate(e=>{const b=e.getBoundingClientRect();return b.top>=0&&b.bottom<=innerHeight;}),true);await reminder.screenshot({path:path.join(evidence,'reminder-long-text.png')});
 mark('The reminder message receives pointer input, long text scrolls from a safe starting position, and dismissal stays reachable in a short client viewport.');
 assert.deepEqual(errors,[]);await close();const result={passed:true,mode:'native',prototypeOnly:false,version:build.version,sha256:hash(exe),results,matrix,errors,evidence,limits:['Hidden native WebViews verify transition lifecycle and final layouts; visible transition frames are reviewed separately in the built-frontend preview. Physical mixed-DPI movement and human comfort are not certified. Renderer error and long-copy cases use explicit QA injection.']};writeFileSync(path.join(build.output,'acceptance/popup-motion-result.json'),JSON.stringify(result,null,2));console.log(JSON.stringify({passed:true,evidence}));
}catch(error){writeFileSync(path.join(evidence,'failure.json'),JSON.stringify({error:String(error),stack:error.stack,results,matrix,errors,logs},null,2));try{await close();}catch{}throw error;}
