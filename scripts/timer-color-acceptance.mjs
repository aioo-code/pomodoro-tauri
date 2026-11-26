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

const build=JSON.parse(readFileSync(path.join(root,'tmp/settings-build-current.json'))),exe=path.join(build.output,'pomodoro-connected.exe');
const evidence=path.join(build.output,'acceptance','timer-color-'+randomUUID());mkdirSync(evidence,{recursive:true});
const prefs=path.join(evidence,'preferences.json'),results=[],errors=[],measurements=[];
let child,browser,page,reminder,logs='';
const invoke=(command,args,target=page)=>target.evaluate(({command,args})=>window.__TAURI__.core.invoke(command,args),{command,args});
const values=async()=>(await invoke('get_preferences')).values,clock=()=>invoke('snapshot');
async function wait(check,label,timeout=12000){const end=Date.now()+timeout;while(Date.now()<end){if(child?.exitCode!=null)throw Error('Owned QA exited: '+logs);if(await check())return;await delay(50);}throw Error('Timed out: '+label);}
async function click(selector){const locator=page.locator(selector);await wait(()=>locator.evaluate(e=>!e.disabled),'enabled '+selector);await locator.evaluate(e=>e.click());}
async function launch(){
 const server=createServer();server.listen(0,'127.0.0.1');await once(server,'listening');const port=server.address().port;await new Promise(resolve=>server.close(resolve));
 child=spawn(exe,['--qa-hidden','--qa-preferences-file='+prefs,'--tool-data-dir='+path.join(evidence,'tool-state')],{cwd:evidence,env:{...env,WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS:`--remote-debugging-port=${port} --remote-debugging-address=127.0.0.1`},windowsHide:true,stdio:['ignore','pipe','pipe']});
 for(const stream of[child.stdout,child.stderr])stream.on('data',data=>logs+=data);
 await wait(async()=>{try{return(await fetch(`http://127.0.0.1:${port}/json/version`)).ok;}catch{return false;}},'launch',40000);
 browser=await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
 await wait(()=>{const pages=browser.contexts().flatMap(c=>c.pages());page=pages.find(p=>/tauri\.localhost/.test(p.url())&&!p.url().includes('reminder'));reminder=pages.find(p=>p.url().includes('reminder'));return page&&reminder;},'WebViews');
 for(const target of[page,reminder]){target.on('pageerror',e=>errors.push(e.message));await target.waitForFunction(()=>document.documentElement.dataset.preferenceEvents==='ready');}
 await page.waitForFunction(()=>document.getElementById('toggle')&&!document.getElementById('toggle').disabled);
}
async function close(){if(child?.exitCode===null){const exited=once(child,'exit');await invoke('desktop_action',{action:'quit'}).catch(()=>{});await Promise.race([exited,delay(8000)]);assert.notEqual(child.exitCode,null);}await browser?.close();child=browser=page=reminder=undefined;}
function mark(message){results.push(message);console.log(message);}
function luma(color){return color.map(v=>{v/=255;return v<=.04045?v/12.92:((v+.055)/1.055)**2.4;}).reduce((sum,v,i)=>sum+v*[.2126,.7152,.0722][i],0);}
function contrast(a,b){const x=luma(a),y=luma(b);return(Math.max(x,y)+.05)/(Math.min(x,y)+.05);}
try{
 await launch();await page.setViewportSize({width:400,height:520});
 await click('#toggle');await wait(async()=>(await clock()).status==='running','running');const started=await clock();
 for(const style of['arc','orbit','ticks','digits','comet']){
  await click('#timer-view-next');await wait(async()=>(await values()).timerStyle===style,'style '+style);
  await wait(()=>page.locator('.clock-section').getAttribute('data-timer-style').then(v=>v===style),'paint '+style);
  const state=await clock();assert.equal(state.status,'running');assert.equal(state.revision,started.revision);assert.equal(state.mode,started.mode);assert.ok(state.remainingMs<=started.remainingMs);
  if(style==='arc'){assert.equal(await page.locator('#time').evaluate(e=>e.classList.contains('sr-only')),true);assert.match(await page.locator('#time').getAttribute('aria-label'),/剩余/);}
 }
 await click('#timer-view-prev');await wait(async()=>(await values()).timerStyle==='digits','previous wraps');
 await click('#toggle');await wait(async()=>(await clock()).status==='paused','pause');
 for(const style of['arc','orbit','ticks','digits']){
  await invoke('set_preferences',{patch:{timerStyle:style}});await invoke('action',{action:'remaining:focus:451000'});
  await wait(()=>page.locator('.comet-dial__ring').getAttribute('aria-valuenow').then(n=>Number(n)===451),'native time');
  const slider=page.locator('.comet-dial__ring');await slider.focus();await page.keyboard.press('PageUp');await wait(async()=>(await clock()).remainingMs===511000,'keyboard edits '+style);assert.equal((await clock()).status,'paused');
  const b=await page.locator('.timer-view').boundingBox();const position=await invoke('desktop_state');
  await page.mouse.move(b.x+b.width/2,b.y+b.height/2);await page.mouse.down();await page.mouse.move(b.x+b.width/2,b.y+b.height/2-20,{steps:20});await page.mouse.up();
  await wait(async()=>(await clock()).remainingMs===611000,'fine pointer drag '+style);assert.equal((await clock()).status,'paused');
  assert.equal((await invoke('desktop_state')).x,position.x);assert.equal((await invoke('desktop_state')).y,position.y);
  // Read progress and duration in one settled sample; editing remains a native operation.
  const current=await clock();await wait(()=>page.locator('.timer-view').getAttribute('data-progress').then(v=>Math.abs(Number(v)-current.remainingMs/current.durationMs)<.00001),'remaining progress');
  await page.screenshot({path:path.join(evidence,'main-'+style+'.png'),animations:'disabled'});
 }
 mark('Five views cycle in both directions without resetting a running timer. Four alternate views preserve paused state during keyboard and fine pointer edits; all show remaining progress.');
 await invoke('set_preferences',{patch:{timerStyle:'comet',numberAnimation:false}});
 for(const selector of['#toggle','#direction','#reset','#timer-view-prev','#timer-view-next','.jelly-radio__chip:first-child','.mode-tabs button:first-of-type']){
  await page.mouse.move(0,0);await delay(300);const element=page.locator(selector),before=await element.boundingBox();assert.ok(before,selector);
  const sample=async()=>{const frames=[];for(let index=0;index<12;index++){frames.push(await element.boundingBox());await delay(20);}return frames;};
  await page.mouse.move(before.x+before.width/2,before.y+before.height/2);const hover=await sample();
  await page.mouse.down();const held=await sample();await page.mouse.move(0,0);await page.mouse.up();await delay(260);
  for(const measured of[...hover,...held])for(const key of['x','y','width','height'])assert.ok(Math.abs(measured[key]-before[key])<.2,JSON.stringify({selector,before,hover,held}));
  measurements.push({selector,before,hover,held});
 }
 mark('Main controls retain the same position and dimensions on hover and while held, including primary action, preset chips and mode buttons.');
 await click('#settings');await page.locator('#settings-panel').waitFor();
 assert.equal(await page.locator('.settings-heading').count(),0);assert.equal(await page.locator('.titlebar #settings-back').count(),1);
 assert.equal(await page.evaluate(()=>document.querySelector('.settings-viewport').getBoundingClientRect().top-document.querySelector('.titlebar').getBoundingClientRect().bottom<=16),true);
 assert.equal(await page.locator('.accent-choice').count(),5);
 assert.equal(await page.locator('.accent-options').evaluate(e=>{const r=[...e.children].map(c=>c.getBoundingClientRect());return r.every(c=>Math.abs(c.top-r[0].top)<1);}),true);
 await click('#custom-color-toggle');await page.locator('#custom-color-hex').fill('#ff4f8b');await page.locator('#custom-color-hex').press('Enter');await wait(async()=>(await values()).customAccent==='#ff4f8b'&&(await values()).accent==='custom','hex color');
 await page.locator('#custom-color-hex').fill('#zzzzzz');await page.locator('#custom-color-hex').press('Enter');assert.equal((await values()).customAccent,'#ff4f8b');assert.equal(await page.locator('.color-picker [role="alert"]').isVisible(),true);
 await page.locator('#custom-color-hex').fill('#3af');await page.locator('#custom-color-hex').press('Enter');await wait(async()=>(await values()).customAccent==='#33aaff','short hex');
 const saved=readFileSync(prefs);await assert.rejects(()=>invoke('set_preferences',{patch:{customAccent:'#badbadbad'}}));assert.deepEqual(readFileSync(prefs),saved);
 await page.locator('#custom-color-hue').focus();await page.keyboard.press('Home');await page.keyboard.press('ArrowRight');await wait(async()=>(await values()).customAccent!=='#33aaff','hue keyboard');
 const sv=page.locator('.color-sv'),box=await sv.boundingBox();await page.mouse.move(box.x+box.width*.8,box.y+box.height*.2);await page.mouse.down();await page.mouse.move(box.x+box.width*.9,box.y+box.height*.3,{steps:8});await page.mouse.up();await wait(async()=>(await values()).accent==='custom','SV pointer');
 await page.screenshot({path:path.join(evidence,'settings-custom-palette.png'),animations:'disabled'});await page.keyboard.press('Escape');await page.keyboard.press('Escape');await wait(()=>page.locator('#toggle').isVisible(),'keyboard return');
 mark('Settings reclaim the body heading, return through the title bar, and offer a single palette row. Hex, hue, saturation/brightness controls save real settings; invalid colors cannot overwrite them.');
 const customColors=['#000000','#ffffff','#777777','#ff0080','#1010ff','#30f3c0','#8c5bcf','#d32157'];
 const surface=target=>target.evaluate(()=>{const s=getComputedStyle(document.documentElement);return{primary:s.getPropertyValue('--primary'),ink:s.getPropertyValue('--primary-foreground'),background:s.getPropertyValue('--background'),accent:s.getPropertyValue('--accent-ink'),theme:document.documentElement.dataset.theme};});
 for(const theme of['light','dark']){
  if(await page.evaluate(()=>document.documentElement.dataset.theme)!==theme){await click('#theme');await wait(()=>page.evaluate(t=>document.documentElement.dataset.theme===t,theme),'theme');}
  for(const color of customColors){
   await invoke('set_preferences',{patch:{accent:'custom',customAccent:color}});await wait(async()=>JSON.stringify(await surface(page))===JSON.stringify(await surface(reminder)),'shared custom '+color);
   const paint=await page.locator('#toggle').evaluate(e=>{const s=getComputedStyle(e);return{bg:s.backgroundColor.match(/[\d.]+/g).slice(0,3).map(Number),fg:s.color.match(/[\d.]+/g).slice(0,3).map(Number),effect:Number(s.getPropertyValue('--button-effect-strength')),light:(()=>{const c=getComputedStyle(e.querySelector('.focus-primary__light')).backgroundColor.match(/[\d.]+/g).map(Number);return c.length===4?c[3]:1;})()};});
   assert.ok(contrast(paint.bg,paint.fg)>=4.5,JSON.stringify(paint));const p=1-(1-.02*paint.effect)*(1-.01*paint.effect)*(1-paint.light),hotspot=paint.bg.map(v=>v*(1-p)+255*p);assert.ok(contrast(hotspot,paint.fg)>=4.49,JSON.stringify({color,theme,paint,hotspot}));measurements.push({color,theme,paint});
  }
 }
 await invoke('set_preferences',{patch:{accent:'custom',customAccent:'#ff4f8b',timerStyle:'orbit'}});await close();await launch();const restored=await values();assert.equal(restored.customAccent,'#ff4f8b');assert.equal(restored.accent,'custom');assert.equal(restored.timerStyle,'orbit');
 await page.setViewportSize({width:400,height:520});await page.screenshot({path:path.join(evidence,'main-custom-dark.png'),animations:'disabled'});
 for(const size of[{width:400,height:520},{width:360,height:480},{width:242,height:242}]){
  await page.setViewportSize(size);
  for(const style of['comet','arc','orbit','ticks','digits']){await invoke('set_preferences',{patch:{timerStyle:style}});await wait(()=>page.locator('.clock-section').getAttribute('data-timer-style').then(v=>v===style),'small style');const geometry=await page.evaluate(()=>{const selectors=['.clock-section','#timer-view-prev','#timer-view-next','#toggle','#reset'];return{width:innerWidth,scroll:document.documentElement.scrollWidth,boxes:selectors.map(selector=>{const b=document.querySelector(selector).getBoundingClientRect();return{selector,x:b.x,y:b.y,right:b.right,bottom:b.bottom,width:b.width,height:b.height};})};});assert.ok(geometry.scroll<=size.width);for(const b of geometry.boxes){assert.ok(b.x>=-.1&&b.right<=size.width+.1,JSON.stringify({style,size,geometry}));assert.ok(b.width>0&&b.height>0);}measurements.push({style,size,geometry});}
 }
 for(const size of[{width:400,height:580},{width:360,height:540},{width:400,height:520},{width:360,height:480},{width:360,height:420}]){
  await page.setViewportSize(size);
  for(const style of['comet','arc','orbit','ticks','digits']){
   await invoke('set_preferences',{patch:{timerStyle:style}});
   await wait(()=>page.locator('.clock-section').getAttribute('data-timer-style').then(v=>v===style),'layout '+style);
   const composition=await page.evaluate(()=>{
    const box=s=>{const r=document.querySelector(s).getBoundingClientRect();return{top:r.top,bottom:r.bottom,right:r.right};};
    const main=document.querySelector('main');return{time:box('#time'),graph:box('.clock-section'),status:box('.timer-caption .clock-status'),hint:box('.dial-hint'),main:box('main'),action:box('#toggle'),scrollbar:getComputedStyle(main).scrollbarWidth,overflow:main.scrollHeight-main.clientHeight};
   });
   assert.equal(composition.scrollbar,'none');
   assert.ok(composition.overflow<=1,JSON.stringify({style,size,composition}));
   if(style!=='arc')assert.ok(composition.status.top>=composition.time.bottom+7,JSON.stringify({style,size,composition}));
   assert.ok(composition.status.top>=composition.graph.bottom+7,JSON.stringify({style,size,composition}));
   assert.ok(composition.hint.top>=composition.status.bottom+7,JSON.stringify({style,size,composition}));
   assert.ok(composition.action.bottom<=composition.main.bottom+1,JSON.stringify({style,size,composition}));
   measurements.push({style,size,composition});
  }
 }
 for(const size of[{width:400,height:580},{width:360,height:540},{width:400,height:520},{width:360,height:480},{width:360,height:420},{width:360,height:340},{width:242,height:242}]){
  await page.setViewportSize(size);
  for(const style of['comet','arc','orbit','ticks','digits']){
   await invoke('set_preferences',{patch:{timerStyle:style}});await wait(()=>page.locator('.clock-section').getAttribute('data-timer-style').then(v=>v===style),'no-scroll '+style);
   const fit=await page.evaluate(()=>{const m=document.querySelector('main'),b=document.querySelector('#toggle').getBoundingClientRect(),r=m.getBoundingClientRect();return{extra:m.scrollHeight-m.clientHeight,buttonBottom:b.bottom,mainBottom:r.bottom,top:m.scrollTop};});
   assert.ok(fit.extra<=1&&fit.buttonBottom<=fit.mainBottom&&fit.top===0,JSON.stringify({size,style,fit}));measurements.push({size,style,fit});
  }
 }
 mark('Timer captions have separate space from graphics, digits and hints; recording information occupies a quiet footer above the heatmap. Controls fit supported sizes without visible main scrollbars.');
 mark('Custom colors remain readable in both themes and synchronize with the reminder. Color and view survive a native restart; all five views keep controls in bounds at normal and minimum sizes.');
 assert.deepEqual(errors,[]);await close();const result={passed:true,mode:'native',prototypeOnly:false,version:build.version,sha256:createHash('sha256').update(readFileSync(exe)).digest('hex'),results,measurements,errors,evidence,limits:['CDP input and WebView layouts are verified on an owned hidden native instance. Physical touch feel and mixed-monitor DPI remain outside this check.']};
 writeFileSync(path.join(build.output,'acceptance/timer-color-result.json'),JSON.stringify(result,null,2));console.log(JSON.stringify({passed:true,evidence}));
}catch(error){writeFileSync(path.join(evidence,'failure.json'),JSON.stringify({error:String(error),stack:error.stack,results,measurements,errors,logs},null,2));try{await close();}catch{}throw error;}
