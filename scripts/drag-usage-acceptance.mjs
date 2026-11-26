import {chromium} from 'playwright-core';
import {spawn,spawnSync} from 'node:child_process';
import {createServer} from 'node:net';
import {once} from 'node:events';
import {mkdirSync,readFileSync,writeFileSync} from 'node:fs';
import {createHash,randomUUID} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import assert from 'node:assert/strict';
import path from 'node:path';
import {root,env} from './environment.mjs';
const build=JSON.parse(readFileSync(path.join(root,'tmp/settings-build-current.json'))),exe=path.join(build.output,'pomodoro-connected.exe');
const evidence=path.join(build.output,'acceptance','drag-usage-'+randomUUID());mkdirSync(evidence,{recursive:true});
const prefs=path.join(evidence,'preferences.json'),usageFile=path.join(evidence,'usage.json'),results=[],errors=[];
let child,browser,page,reminder,logs='';
const invoke=(command,args)=>page.evaluate(({command,args})=>window.__TAURI__.core.invoke(command,args),{command,args});
const desktop=()=>invoke('desktop_state'),history=()=>invoke('usage_snapshot');
async function wait(check,label,timeout=12000){const end=Date.now()+timeout;while(Date.now()<end){if(child?.exitCode!=null)throw Error(logs);if(await check())return;await delay(40);}throw Error('Timed out: '+label);}
async function click(selector){await page.locator(selector).evaluate(e=>e.click());}
async function launch(){
 const server=createServer();server.listen(0,'127.0.0.1');await once(server,'listening');const port=server.address().port;await new Promise(resolve=>server.close(resolve));
 child=spawn(exe,['--qa-hidden','--qa-seconds=2','--qa-show-reminders','--qa-preferences-file='+prefs,'--tool-data-dir='+path.join(evidence,'tool-state')],{cwd:evidence,env:{...env,WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS:`--remote-debugging-port=${port} --remote-debugging-address=127.0.0.1`},windowsHide:true,stdio:['ignore','pipe','pipe']});
 for(const stream of[child.stdout,child.stderr])stream.on('data',data=>logs+=data);
 await wait(async()=>{try{return(await fetch(`http://127.0.0.1:${port}/json/version`)).ok;}catch{return false;}},'native launch',40000);
 browser=await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
 await wait(()=>{const pages=browser.contexts().flatMap(c=>c.pages());page=pages.find(p=>/tauri\.localhost/.test(p.url())&&!p.url().includes('reminder'));reminder=pages.find(p=>p.url().includes('reminder'));return page&&reminder;},'WebViews');
 for(const target of[page,reminder])target.on('pageerror',e=>errors.push(e.message));
 await page.waitForFunction(()=>document.getElementById('toggle')&&!document.getElementById('toggle').disabled&&document.querySelectorAll('.usage-day').length===30);
 await page.evaluate(()=>{window.__dragCalls=[];window.__pointerTrace=[];document.addEventListener('pointerdown',e=>window.__pointerTrace.push({type:e.pointerType,button:e.button,primary:e.isPrimary,target:e.target?.className}),true);const api=window.__TAURI__,original=api.core.invoke;const wrapped=(command,args,options)=>{if(command==='native_drag'||command==='drag_update')window.__dragCalls.push({command,args});if(command==='native_drag')return Promise.resolve();return original(command,args,options);};window.__TAURI__={...api,core:{...api.core,invoke:wrapped}};if(window.__TAURI__.core.invoke!==wrapped)throw Error('QA bridge interception failed');});
}
async function close(){if(child?.exitCode===null){const exited=once(child,'exit');await invoke('desktop_action',{action:'quit'}).catch(()=>{});await Promise.race([exited,delay(8000)]);assert.notEqual(child.exitCode,null);}await browser?.close().catch(()=>{});}
const lifecycle=path.join(evidence,'owned-lifecycle.ps1');
writeFileSync(lifecycle,`param([int]$TargetProcess,[uint32]$Message)
Add-Type @'
using System;using System.Text;using System.Runtime.InteropServices;
public class DragLifecycle {
 public delegate bool Callback(IntPtr h,IntPtr p);
 [DllImport("user32.dll")] public static extern bool EnumWindows(Callback f,IntPtr p);
 [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h,out uint p);
 [DllImport("user32.dll",CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr h,StringBuilder s,int n);
 [DllImport("user32.dll")] public static extern IntPtr SendMessageW(IntPtr h,uint m,IntPtr w,IntPtr l);
 public static IntPtr Find(uint pid){IntPtr result=IntPtr.Zero;EnumWindows((h,p)=>{uint owner;GetWindowThreadProcessId(h,out owner);if(owner==pid){var name=new StringBuilder(512);GetWindowText(h,name,512);if(name.ToString()=="番茄时钟")result=h;}return true;},IntPtr.Zero);return result;}
}
'@
$handle=[DragLifecycle]::Find($TargetProcess)
if($handle -eq [IntPtr]::Zero){throw 'Owned HWND not found'}
[void][DragLifecycle]::SendMessageW($handle,$Message,[IntPtr]::Zero,[IntPtr]::Zero)
`);
function signal(message){const p=spawnSync('pwsh',['-NoProfile','-File',lifecycle,'-TargetProcess',String(child.pid),'-Message',String(message)],{env,encoding:'utf8',windowsHide:true});assert.equal(p.status,0,p.stderr);}
function mark(text){results.push(text);console.log(text);}
try {
 await launch();
 assert.equal((await history()).days.length,30);assert.ok((await history()).days.every(day=>day.count===0));
 // Real Chromium mouse events exercise routing; no host cursor or mouse button is injected.
 await page.mouse.move(7,12);await page.mouse.down();await page.mouse.up();console.log(JSON.stringify(await page.evaluate(()=>({pointerTrace:window.__pointerTrace,dragCalls:window.__dragCalls}))));
 await wait(()=>page.evaluate(()=>window.__dragCalls.some(c=>c.command==='native_drag')),'native title drag route');
 assert.equal(await page.evaluate(()=>window.__dragCalls.filter(c=>c.command==='drag_update').length),0);
 await page.evaluate(()=>window.__dragCalls=[]);await page.locator('#settings').click();await click('#settings-back');
 assert.equal(await page.evaluate(()=>window.__dragCalls.length),0,'title controls do not initiate drag');
 await invoke('desktop_action',{action:'mini'});await page.waitForFunction(()=>document.body.classList.contains('mini'));
 assert.equal(await page.locator('.usage-footer').count(),0);
 const time=page.locator('.mini-time-control'),originalView=await time.getAttribute('data-view');
 await time.click();const tapped=await time.getAttribute('data-view');assert.notEqual(tapped,originalView);
 await page.evaluate(()=>window.__dragCalls=[]);const rect=await time.boundingBox();
 await page.mouse.move(rect.x+rect.width/2,rect.y+rect.height/2);await page.mouse.down();await page.mouse.move(rect.x+rect.width/2+8,rect.y+rect.height/2);await page.mouse.up();
 await wait(()=>page.evaluate(()=>window.__dragCalls.some(c=>c.command==='native_drag')),'mini threshold native handoff');
 assert.equal(await time.getAttribute('data-view'),tapped,'drag does not perform a time tap');assert.equal(await page.evaluate(()=>window.__dragCalls.filter(c=>c.command==='native_drag').length),1,'one native handoff, without bubbling duplicates');
 signal(0x0231);assert.equal((await desktop()).widget.dragging,true);assert.equal((await invoke('appearance_state')).main.backend,'accent-acrylic');assert.equal((await invoke('appearance_state')).main.acrylic,true);
 const d=await desktop();await invoke('drag_to',{x:d.workX+5,y:d.workY+5});assert.equal((await desktop()).widget.dragging,true);
 signal(0x0232);await wait(async()=>!(await desktop()).widget.dragging,'native move exits');assert.equal((await invoke('appearance_state')).main.backend,'accent-acrylic');
 const end=await desktop();assert.ok(Math.abs(end.widget.frame.x-end.workX-12*end.scale)<=1);assert.ok(Math.abs(end.widget.frame.y-end.workY-12*end.scale)<=1);
 await invoke('desktop_action',{action:'mini'});await page.waitForFunction(()=>!document.body.classList.contains('mini'));
 mark('Mouse uses one native OS handoff; mini click still toggles; native enter/exit lifecycle preserves drag state and settles to 12-DIP edges');
 await invoke('action',{action:'start'});await invoke('action',{action:'pause'});assert.equal((await history()).days.at(-1).count,0);
 await invoke('action',{action:'start'});await wait(async()=>(await desktop()).reminderVisible,'focus completed');
 await wait(async()=>(await history()).days.at(-1).count===1,'completion recorded');await page.waitForFunction(()=>document.querySelector('.usage-day:last-child')?.dataset.count==='1');
 for(let i=0;i<5;i++)await invoke('snapshot');assert.equal((await history()).days.at(-1).count,1);
 await reminder.locator('#dismiss').evaluate(e=>e.click());assert.equal((await history()).days.at(-1).count,1);
 await invoke('action',{action:'break'});await invoke('action',{action:'start'});await wait(async()=>(await desktop()).reminderVisible,'break completed');assert.equal((await history()).days.at(-1).count,1);
 await reminder.locator('#dismiss').evaluate(e=>e.click());await close();await launch();assert.equal((await history()).days.at(-1).count,1);
 assert.equal(await page.locator('.usage-heatmap').getAttribute('data-total'),'1');
 mark('Daily focus completion increments once, pause/start/poll/dismiss and break do not inflate counts; actual local history survives native restart');
 await page.locator('.usage-day').last().focus();await page.keyboard.press('Home');assert.equal(await page.locator('.usage-day').first().evaluate(e=>e===document.activeElement),true);await page.keyboard.press('ArrowRight');assert.equal(await page.locator('.usage-day').nth(1).evaluate(e=>e===document.activeElement),true);
 await invoke('set_preferences',{patch:{cornerRadius:0}});await wait(()=>page.locator('.usage-day').last().evaluate(e=>getComputedStyle(e).borderRadius==='0px'),'heatmap square corners');
 for(const language of['zh','en','ja','de','eo']){
  await invoke('set_preferences',{patch:{language}});await page.waitForFunction(language=>document.documentElement.dataset.language===language,language);
  assert.ok((await page.locator('.usage-footer').getAttribute('aria-label')).includes('1'));
 }
 await invoke('set_preferences',{patch:{language:'zh',cornerRadius:20}});
 for(const size of[{width:400,height:520},{width:360,height:480},{width:242,height:242}]){
  await page.setViewportSize(size);
  assert.equal(await page.locator('.usage-footer').evaluate(e=>{const r=e.getBoundingClientRect();return r.left>=0&&r.right<=innerWidth&&r.bottom<=innerHeight&&r.top>0;}),true);
  assert.equal(await page.locator('.usage-day').evaluateAll(cells=>cells.every(e=>e.getBoundingClientRect().width>1)),true);
  await page.locator('#toggle').scrollIntoViewIfNeeded();assert.equal(await page.locator('#toggle').evaluate(e=>{const r=e.getBoundingClientRect();const footer=document.querySelector('.usage-footer').getBoundingClientRect();return r.top>=0&&r.bottom<=footer.top;}),true);
  await page.screenshot({path:path.join(evidence,'heatmap-'+size.width+'.png'),animations:'disabled'});
 }
 assert.deepEqual(errors,[]);await close();
 mark('Heatmap stays at the window bottom, fits narrow/high-scale viewports, supports keyboard date navigation, five languages and zero radius');
 const result={passed:true,version:build.version,sha256:createHash('sha256').update(readFileSync(exe)).digest('hex'),results,errors,evidence,historyFile:usageFile,limits:['Native move lifecycle uses owned HWND messages; Chromium pointer routing and touch tracking are tested without injecting host mouse input. Physical mouse/touch latency and mixed-DPI hardware were not certified.','Frequency counts completed focus sessions from this version onward; no historical sessions are fabricated.']};
 writeFileSync(path.join(build.output,'acceptance/drag-usage-result.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result));
}catch(error){writeFileSync(path.join(evidence,'failure.json'),JSON.stringify({error:String(error),stack:error.stack,results,errors,logs},null,2));try{await close();}catch{}throw error;}
