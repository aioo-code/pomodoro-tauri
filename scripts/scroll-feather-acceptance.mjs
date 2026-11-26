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
 child=spawn(exe,['--qa-hidden','--qa-preferences-file='+prefs,'--tool-data-dir='+path.join(evidence,'tool-state')],{cwd:evidence,env:{...env,WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS:`--remote-debugging-port=${port} --remote-debugging-address=127.0.0.1`},windowsHide:true,stdio:['ignore','pipe','pipe']});
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
const prototype=process.argv.includes('--prototype');
const proof={mode:prototype?'prototype':'native',measurements:[]};
async function pixelEdge(edge,name){
 const rect=await page.locator('.settings-viewport').evaluate(e=>{const r=e.getBoundingClientRect();return{left:r.left,right:r.right,top:r.top,bottom:r.bottom,width:innerWidth,height:innerHeight};});
 const png=await page.screenshot({path:path.join(evidence,name+'.png')});
 const sample=await page.evaluate(async({data,rect,edge})=>{
  const picture=new Image();picture.src='data:image/png;base64,'+data;await picture.decode();
  const canvas=document.createElement('canvas');canvas.width=picture.width;canvas.height=picture.height;
  const context=canvas.getContext('2d');context.drawImage(picture,0,0);const bytes=context.getImageData(0,0,canvas.width,canvas.height).data;
  const sx=canvas.width/rect.width,sy=canvas.height/rect.height;
  const y=Math.max(0,Math.min(canvas.height-1,edge==='top'?Math.ceil(rect.top*sy):Math.ceil(rect.bottom*sy)-1));
  const at=(x,y)=>{const i=(y*canvas.width+x)*4,a=bytes[i+3];return[bytes[i]*a/255,bytes[i+1]*a/255,bytes[i+2]*a/255,a];};
  const refX=Math.max(1,Math.round((rect.left-8)*sx)),background=at(refX,y),differences=[];const insideY=Math.max(0,Math.min(canvas.height-1,y+(edge==='top'?1:-1)*Math.round(60*sy))),insideBackground=at(refX,insideY),inside=[];
  for(let x=Math.ceil((rect.left+16)*sx);x<Math.floor((rect.right-18)*sx);x+=Math.max(1,Math.round(2*sx)))differences.push(Math.max(...at(x,y).map((v,i)=>Math.abs(v-background[i]))));
  for(let x=Math.ceil((rect.left+16)*sx);x<Math.floor((rect.right-18)*sx);x+=Math.max(1,Math.round(2*sx)))inside.push(Math.max(...at(x,insideY).map((v,i)=>Math.abs(v-insideBackground[i]))));inside.sort((a,b)=>a-b);differences.sort((a,b)=>a-b);
  return{edge,y,background,interiorP95:inside[Math.floor(inside.length*.95)],median:differences[Math.floor(differences.length*.5)],p95:differences[Math.floor(differences.length*.95)],max:differences.at(-1)};
 },{data:png.toString('base64'),rect,edge});
 proof.measurements.push({name,...sample});return sample;
}
async function fixtures(){
 await page.evaluate(()=>{const box=document.querySelector('.settings-scroll-content');for(const which of['top','bottom']){const sample=document.createElement('div');sample.id='qa-edge-'+which;sample.setAttribute('aria-hidden','true');sample.style.cssText='height:120px;min-height:120px;width:100%;background:#fff;pointer-events:none';if(which==='top')box.prepend(sample);else box.append(sample);}});
}
async function positions(prefix){
 await page.locator('.settings-scroll').evaluate(e=>{e.scrollTop=40;});await delay(220);const top=await pixelEdge('top',prefix+'-top');
 await page.locator('.settings-scroll').evaluate(e=>{e.scrollTop=e.scrollHeight-e.clientHeight-40;});await delay(220);const bottom=await pixelEdge('bottom',prefix+'-bottom');
 return{top,bottom};
}
try{
 await launch();await invoke('set_preferences',{patch:{accent:'candy-lime',cornerRadius:32}});
 await page.setViewportSize({width:400,height:520});
 if(await page.evaluate(()=>document.documentElement.dataset.theme)!=='dark')await page.locator('#theme').evaluate(e=>e.click());
 await page.locator('#settings').evaluate(e=>e.click());await page.locator('.settings-scroll').waitFor();
 await page.locator('.settings-scrollbar').waitFor({state:'visible'});
 const thumb=await page.locator('.settings-scroll-thumb').boundingBox();assert.ok(thumb);
 await page.mouse.move(thumb.x+thumb.width/2,thumb.y+thumb.height/2);await page.mouse.down();await page.mouse.move(thumb.x+thumb.width/2,thumb.y+thumb.height/2+60,{steps:12});await page.mouse.up();
 await page.waitForFunction(()=>document.querySelector('.settings-scroll').scrollTop>0);
 const scrollGeometry=await page.evaluate(()=>{const viewport=document.querySelector('.settings-scroll'),r=viewport.getBoundingClientRect();return{left:r.left,right:r.right,width:innerWidth,nativeScrollbar:getComputedStyle(viewport).scrollbarWidth,custom:!!document.querySelector('.settings-scrollbar'),padding:parseFloat(getComputedStyle(document.querySelector('.settings-scroll-content')).paddingLeft),dragWorked:viewport.scrollTop>0};});
 assert.ok(Math.abs(scrollGeometry.left)<1&&Math.abs(scrollGeometry.right-scrollGeometry.width)<1,JSON.stringify(scrollGeometry));
 assert.equal(scrollGeometry.nativeScrollbar,'none');assert.equal(scrollGeometry.custom,true);assert.ok(scrollGeometry.padding>=12);proof.scrollGeometry=scrollGeometry;
 await fixtures();proof.initial=await positions('initial');
 if(prototype){
  const inspector=await browser.contexts()[0].newCDPSession(page);await inspector.send('DOM.enable');await inspector.send('CSS.enable');const tree=await inspector.send('Page.getFrameTree');const sheet=await inspector.send('CSS.createStyleSheet',{frameId:tree.frameTree.frame.id});
  await inspector.send('CSS.setStyleSheetText',{styleSheetId:sheet.styleSheetId,text:readFileSync(path.join(root,'frontend/hooks/scroll-feather.css'),'utf8')+'\n.settings-edge-blur{right:var(--settings-scrollbar-width,8px)!important}'});
  await page.evaluate(()=>{const scroll=document.querySelector('.settings-scroll'),view=scroll.parentElement;
   const update=()=>{const limit=Math.max(0,scroll.scrollHeight-scroll.clientHeight),offset=Math.max(0,Math.min(limit,scroll.scrollTop)),cap=scroll.clientHeight*.22;view.style.setProperty('--settings-fade-top',Math.min(32,offset,cap)+'px');view.style.setProperty('--settings-fade-bottom',Math.min(36,limit-offset,cap)+'px');view.style.setProperty('--settings-scrollbar-width',Math.max(0,scroll.offsetWidth-scroll.clientWidth)+'px');};
   update();scroll.addEventListener('scroll',update,{passive:true});const observer=new ResizeObserver(update);observer.observe(scroll.firstElementChild);window.__qaFeatherCleanup=()=>{scroll.removeEventListener('scroll',update);observer.disconnect();};
  });
  proof.fixed=await positions('feather');
  assert.ok(proof.initial.top.p95>12&&proof.initial.bottom.p95>12,'baseline must reproduce the bright clipping boundary');
 }else proof.fixed=proof.initial;
 assert.ok(proof.fixed.top.p95<=3&&proof.fixed.bottom.p95<=3&&proof.fixed.top.interiorP95>20&&proof.fixed.bottom.interiorP95>20,JSON.stringify(proof.fixed));
 await page.evaluate(()=>{document.getElementById('qa-edge-top')?.remove();document.getElementById('qa-edge-bottom')?.remove();});await delay(150);
 await page.locator('.accent-options').evaluate(e=>{const scroll=document.querySelector('.settings-scroll');scroll.scrollTop+=e.getBoundingClientRect().top-scroll.getBoundingClientRect().top-128;});await delay(300);
 await page.screenshot({path:path.join(evidence,'settings-soft-dark.png')});
 await page.locator('#theme').evaluate(e=>e.click());await wait(()=>page.evaluate(()=>document.documentElement.dataset.theme==='light'),'light');await delay(200);await page.screenshot({path:path.join(evidence,'settings-soft-light.png')});
 if(!prototype){
  const scroller=page.locator('.settings-scroll');await scroller.evaluate(e=>{e.scrollTop=0;});await wait(()=>page.locator('.settings-viewport').evaluate(e=>parseFloat(e.style.getPropertyValue('--settings-fade-top'))===0),'first controls clear');
  await page.locator('#settings-reset').focus();await wait(()=>page.locator('.settings-viewport').evaluate(e=>parseFloat(e.style.getPropertyValue('--settings-fade-bottom'))===0),'last controls clear');
  assert.equal(await page.locator('#settings-reset').evaluate(e=>{const a=e.getBoundingClientRect(),b=document.querySelector('.settings-viewport').getBoundingClientRect();return a.top>=b.top&&a.bottom<=b.bottom;}),true);
 }
 assert.deepEqual(errors,[]);proof.passed=true;proof.errors=[...errors];proof.prototypeOnly=prototype;proof.version=build.version;proof.sha256=createHash('sha256').update(readFileSync(exe)).digest('hex');proof.evidence=evidence;
 writeFileSync(path.join(evidence,'scroll-feather-result.json'),JSON.stringify(proof,null,2));if(!prototype)writeFileSync(path.join(build.output,'acceptance/scroll-feather-result.json'),JSON.stringify(proof,null,2));
 console.log(JSON.stringify(proof));
}catch(error){writeFileSync(path.join(evidence,'feather-failure.json'),JSON.stringify({error:String(error),proof,errors,logs},null,2));throw error;}finally{await close();}
