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
try{await launch();await page.setViewportSize({width:400,height:520});
 for(const theme of['dark','light']){
 if(await page.evaluate(()=>document.documentElement.dataset.theme)!==theme)await page.locator('#theme').evaluate(e=>e.click());await wait(()=>page.evaluate(theme=>document.documentElement.dataset.theme===theme,theme),'theme');
 for(const accent of['candy-lime','blue']){await invoke('set_preferences',{patch:{accent,cornerRadius:32}});await delay(200);const b=await page.locator('#toggle').boundingBox();await page.mouse.move(b.x+b.width*.7,b.y+b.height*.45);await delay(250);await page.screenshot({path:path.join(evidence,theme+'-'+accent+'-button.png')});}
 await page.mouse.move(24,160);await delay(250);await page.screenshot({path:path.join(evidence,theme+'-whole-shell.png')});
 }
 const geometry=await page.evaluate(()=>{const main=document.querySelector('main'),foot=document.querySelector('.usage-footer'),toggle=document.getElementById('toggle'),shell=document.querySelector('.app-shell'),a=toggle.getBoundingClientRect(),b=document.getElementById('direction').getBoundingClientRect(),c=document.getElementById('reset').getBoundingClientRect();return{mainPadding:getComputedStyle(main).paddingLeft,footerPadding:getComputedStyle(foot).paddingLeft,scroll:document.documentElement.scrollHeight>innerHeight||document.documentElement.scrollWidth>innerWidth,button:getComputedStyle(toggle).backgroundImage,shadow:getComputedStyle(toggle).boxShadow,innerFrames:document.querySelectorAll('.timer-stage .spotlight-card__border').length,rootFrame:getComputedStyle(shell.querySelector(':scope > .spotlight-card__border')).display,verticalCenters:[a.y+a.height/2,b.y+b.height/2,c.y+c.height/2]};});assert.equal(geometry.innerFrames,0);assert.equal(geometry.rootFrame,'none');assert.equal(geometry.mainPadding,geometry.footerPadding);assert.equal(geometry.scroll,false);assert.ok(Math.max(...geometry.verticalCenters)-Math.min(...geometry.verticalCenters)<1.5);const result={passed:true,version:build.version,mode:'native',evidence,geometry,prototypeOnly:false,sha256:createHash('sha256').update(readFileSync(exe)).digest('hex')};writeFileSync(path.join(evidence,'window-surface-result.json'),JSON.stringify(result,null,2));writeFileSync(path.join(build.output,'acceptance/window-surface-inspection.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result));
}finally{await close();}
