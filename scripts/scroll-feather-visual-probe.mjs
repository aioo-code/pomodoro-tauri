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

try{await launch();await invoke('set_preferences',{patch:{accent:'candy-lime',cornerRadius:32}});await page.setViewportSize({width:400,height:520});if(await page.evaluate(()=>document.documentElement.dataset.theme)!=='dark')await page.locator('#theme').evaluate(e=>e.click());await page.locator('#settings').evaluate(e=>e.click());await page.locator('.settings-scroll').waitFor();
  const inspector=await browser.contexts()[0].newCDPSession(page);await inspector.send('DOM.enable');await inspector.send('CSS.enable');const tree=await inspector.send('Page.getFrameTree');const sheet=await inspector.send('CSS.createStyleSheet',{frameId:tree.frameTree.frame.id});
  await inspector.send('CSS.setStyleSheetText',{styleSheetId:sheet.styleSheetId,text:readFileSync(path.join(root,'frontend/hooks/scroll-feather.css'),'utf8')+'\n.settings-edge-blur{right:var(--settings-scrollbar-width,8px)!important}'});
  await page.evaluate(()=>{const scroll=document.querySelector('.settings-scroll'),view=scroll.parentElement;
   const update=()=>{const limit=Math.max(0,scroll.scrollHeight-scroll.clientHeight),offset=Math.max(0,Math.min(limit,scroll.scrollTop)),cap=scroll.clientHeight*.22;view.style.setProperty('--settings-fade-top',Math.min(32,offset,cap)+'px');view.style.setProperty('--settings-fade-bottom',Math.min(36,limit-offset,cap)+'px');view.style.setProperty('--settings-scrollbar-width',Math.max(0,scroll.offsetWidth-scroll.clientWidth)+'px');};
   update();scroll.addEventListener('scroll',update,{passive:true});const observer=new ResizeObserver(update);observer.observe(scroll.firstElementChild);window.__qaFeatherCleanup=()=>{scroll.removeEventListener('scroll',update);observer.disconnect();};
  });
await page.locator('.accent-options').evaluate(e=>{const s=document.querySelector('.settings-scroll');s.scrollTop+=e.getBoundingClientRect().top-s.getBoundingClientRect().top-128;});await delay(300);await page.screenshot({path:path.join(evidence,'six-layer-clean.png')});
 await page.evaluate(()=>{for(const root of document.querySelectorAll('.settings-edge-blur'))[...root.children].forEach((e,i)=>{if(i)e.style.display='none';else{e.style.backdropFilter='blur(calc(8px * var(--gradual-blur-reveal,1)))';e.style.maskImage='linear-gradient(to '+(root.style.top==='0px'?'top':'bottom')+',transparent 0%,#000 100%)';}});});await delay(300);await page.screenshot({path:path.join(evidence,'one-layer-clean.png')});console.log(JSON.stringify({evidence,prototypeOnly:true}));}finally{await close();}
