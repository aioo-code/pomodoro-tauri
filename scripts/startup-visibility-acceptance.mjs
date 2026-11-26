import {chromium} from 'playwright-core';
import {spawn,spawnSync} from 'node:child_process';
import {createServer} from 'node:net';
import {once} from 'node:events';
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {createHash,randomUUID} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import {root,env} from './environment.mjs';
const build=JSON.parse(readFileSync(path.join(root,'tmp/settings-build-current.json'))),exe=path.join(build.output,'pomodoro-connected.exe');
const reproduce=process.argv.includes('--reproduce');
const evidence=reproduce?path.join(root,'tmp','startup-repro-'+randomUUID()):path.join(build.output,'acceptance','startup-visibility-'+randomUUID());mkdirSync(evidence,{recursive:true});
const matrix=[],errors=[];let child,browser,page,logs='';
const invoke=(command,args)=>page.evaluate(({command,args})=>window.__TAURI__.core.invoke(command,args),{command,args});
async function wait(test,label,timeout=20000){const end=Date.now()+timeout;while(Date.now()<end){if(child?.exitCode!=null)throw Error(logs);if(await test())return;await delay(40);}throw Error('Timed out: '+label);}
function foregroundPid(){const r=spawnSync('pwsh',['-NoProfile','-Command',`Add-Type 'using System;using System.Runtime.InteropServices;public static class OwnedStartupForeground{[DllImport("user32.dll")]public static extern IntPtr GetForegroundWindow();[DllImport("user32.dll")]public static extern uint GetWindowThreadProcessId(IntPtr h,out uint p);public static uint Pid(){uint p;GetWindowThreadProcessId(GetForegroundWindow(),out p);return p;}}';[OwnedStartupForeground]::Pid()`],{windowsHide:true,encoding:'utf8'});assert.equal(r.status,0,r.stderr);return Number(r.stdout.trim());}
async function close(){if(child?.exitCode===null){const ended=once(child,'exit');await invoke('desktop_action',{action:'quit'}).catch(()=>{});await Promise.race([ended,delay(10000)]);assert.notEqual(child.exitCode,null);}await browser?.close();}
try{
 for(const [acrylic,startInTray] of [[true,false],[false,false],[true,true]]){
  const owned=path.join(evidence,startInTray?'tray':acrylic?'glass':'solid');mkdirSync(owned);const preferences=path.join(owned,'preferences.json');writeFileSync(preferences,JSON.stringify({acrylic,audioMuted:true,dimInactive:false,alwaysOnTop:false,language:'zh'}));
  const server=createServer();server.listen(0,'127.0.0.1');await once(server,'listening');const port=server.address().port;await new Promise(resolve=>server.close(resolve));
  child=spawn(exe,['--qa-cua',...(startInTray?['--start-in-tray']:[]),'--qa-preferences-file='+preferences,'--tool-data-dir='+path.join(owned,'data')],{cwd:owned,env:{...env,WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS:`--remote-debugging-port=${port} --remote-debugging-address=127.0.0.1`},windowsHide:true,stdio:['ignore','pipe','pipe']});
  for(const s of [child.stdout,child.stderr])s.on('data',b=>logs+=b);
  await wait(async()=>{try{return(await fetch(`http://127.0.0.1:${port}/json/version`)).ok;}catch{return false;}},'owned visible startup',45000);
  browser=await chromium.connectOverCDP(`http://127.0.0.1:${port}`);await wait(()=>{page=browser.contexts().flatMap(c=>c.pages()).find(p=>/tauri.localhost/.test(p.url())&&!p.url().includes('reminder'));return page;},'main WebView');page.on('pageerror',e=>errors.push(e.message));
  await page.waitForFunction(()=>document.getElementById('toggle')&&!document.getElementById('toggle').disabled);
  const initial=await invoke('desktop_state');assert.equal(initial.visible,!startInTray);assert.equal(initial.mini,false);
  if(startInTray){await invoke('desktop_action',{action:'show'});await wait(async()=>(await invoke('desktop_state')).visible,'framework tray restore');}
  const before=await invoke('desktop_state');assert.equal(before.visible,true);assert.notEqual(foregroundPid(),child.pid,'startup must not steal foreground');
  const clock=await invoke('snapshot');
  for(let i=0;i<1;i++){
   await invoke('desktop_action',{action:'mini'});await wait(()=>page.evaluate(()=>document.body.classList.contains('mini')),'mini DOM');await delay(80);
   const mini=await invoke('desktop_state');assert.equal(mini.visible,true,JSON.stringify({problem:'First resize must retain native visibility',beforeVisible:before.visible,mini}));assert.equal(mini.mini,true);assert.equal(mini.widget.toolWindow,true);assert.ok(mini.widget.effectiveOpacity>0);
   const f=mini.widget.frame;assert.ok(f.x>=mini.workX&&f.y>=mini.workY&&f.x+f.width<=mini.workX+mini.workWidth&&f.y+f.height<=mini.workY+mini.workHeight,JSON.stringify(mini));
   assert.notEqual(foregroundPid(),child.pid,'mode switch must not steal foreground');
   await invoke('desktop_action',{action:'mini'});await wait(()=>page.evaluate(()=>!document.body.classList.contains('mini')),'main DOM');const main=await invoke('desktop_state');assert.equal(main.visible,true);assert.equal(main.widget.toolWindow,false);assert.equal((await invoke('snapshot')).revision,clock.revision);matrix.push({acrylic,startInTray,initial,cycle:i,mini,main});
  }
  await close();child=undefined;browser=undefined;
 }
 assert.deepEqual(errors,[]);const result={passed:true,mode:'native',prototypeOnly:false,version:build.version,sha256:createHash('sha256').update(readFileSync(exe)).digest('hex'),matrix,errors,evidence,limits:['Three owned QA processes briefly use unfocused startup and tray restore paths. No host mouse/keyboard input or production timer is used.']};writeFileSync(reproduce?path.join(evidence,'result.json'):path.join(build.output,'acceptance/startup-visibility-result.json'),JSON.stringify(result,null,2));console.log(JSON.stringify({passed:true,evidence}));
}catch(e){writeFileSync(path.join(evidence,'failure.json'),JSON.stringify({error:String(e),stack:e.stack,matrix,errors,logs},null,2));try{await close();}catch{}throw e;}
