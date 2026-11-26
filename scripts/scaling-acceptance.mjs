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

const build=JSON.parse(readFileSync(path.join(root,'tmp/settings-build-current.json')));
const exe=path.join(build.output,'pomodoro-connected.exe');
const evidence=path.join(build.output,'acceptance','scaling-'+randomUUID());mkdirSync(evidence,{recursive:true});
let child,browser,page,reminder,logs='';const errors=[],results=[],matrix=[];
const invoke=(command,args)=>page.evaluate(({command,args})=>window.__TAURI__.core.invoke(command,args),{command,args});
const desktop=()=>invoke('desktop_state');
async function wait(check,label,timeout=12000){const end=Date.now()+timeout;while(Date.now()<end){if(child?.exitCode!=null)throw Error(logs);if(await check())return;await delay(60);}throw Error('Timed out: '+label);}
const script=path.join(evidence,'owned-window.ps1');
writeFileSync(script,`param([int]$TargetProcess,[int]$Width=0,[int]$Height=0)
Add-Type @'
using System; using System.Text; using System.Runtime.InteropServices;
public class OwnedWindow {
 public delegate bool EnumProc(IntPtr h,IntPtr p);
 [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc f,IntPtr p);
 [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h,out uint p);
 [DllImport("user32.dll",CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr h,StringBuilder s,int n);
 [DllImport("user32.dll")] public static extern uint GetDpiForWindow(IntPtr h);
 [DllImport("user32.dll")] public static extern IntPtr GetWindowDpiAwarenessContext(IntPtr h);
 [DllImport("user32.dll")] public static extern int GetAwarenessFromDpiAwarenessContext(IntPtr h);
 [DllImport("user32.dll")] public static extern IntPtr SetThreadDpiAwarenessContext(IntPtr c);
 [DllImport("user32.dll",SetLastError=true)] public static extern bool SetWindowPos(IntPtr h,IntPtr after,int x,int y,int w,int z,uint flags);
 public static IntPtr Find(uint pid) {IntPtr found=IntPtr.Zero;EnumWindows((h,p)=>{uint owner;GetWindowThreadProcessId(h,out owner);if(owner!=pid)return true;var title=new StringBuilder(512);GetWindowText(h,title,512);if(title.ToString()=="番茄时钟")found=h;return true;},IntPtr.Zero);return found;}
}
'@
$prior=[OwnedWindow]::SetThreadDpiAwarenessContext([IntPtr](-4))
try {
 $handle=[OwnedWindow]::Find($TargetProcess)
 if($handle -eq [IntPtr]::Zero){throw 'Owned main HWND not found'}
 if($Width -gt 0 -and -not [OwnedWindow]::SetWindowPos($handle,[IntPtr]::Zero,0,0,$Width,$Height,0x16)){throw 'Owned resize failed'}
 @{dpi=[OwnedWindow]::GetDpiForWindow($handle);awareness=[OwnedWindow]::GetAwarenessFromDpiAwarenessContext([OwnedWindow]::GetWindowDpiAwarenessContext($handle))}|ConvertTo-Json -Compress
} finally {[void][OwnedWindow]::SetThreadDpiAwarenessContext($prior)}
`);
function nativeSize(width=0,height=0){const result=spawnSync('pwsh',['-NoProfile','-File',script,'-TargetProcess',String(child.pid),'-Width',String(width),'-Height',String(height)],{env,encoding:'utf8',windowsHide:true});assert.equal(result.status,0,result.stderr);return JSON.parse(result.stdout.trim());}
async function close(){if(child?.exitCode===null){const exited=once(child,'exit');await invoke('desktop_action',{action:'quit'}).catch(()=>{});await Promise.race([exited,delay(8000)]);assert.notEqual(child.exitCode,null);}await browser?.close().catch(()=>{});}
try {
 const server=createServer();server.listen(0,'127.0.0.1');await once(server,'listening');const port=server.address().port;await new Promise(resolve=>server.close(resolve));
 child=spawn(exe,['--qa-hidden','--qa-seconds=2','--qa-show-reminders','--qa-preferences-file='+path.join(evidence,'preferences.json'),'--tool-data-dir='+path.join(evidence,'tool-state')],{cwd:evidence,env:{...env,WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS:`--remote-debugging-port=${port} --remote-debugging-address=127.0.0.1`},windowsHide:true,stdio:['ignore','pipe','pipe']});
 for(const stream of[child.stdout,child.stderr])stream.on('data',data=>logs+=data);
 await wait(async()=>{try{return(await fetch(`http://127.0.0.1:${port}/json/version`)).ok;}catch{return false;}},'launch',40000);
 browser=await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
 await wait(()=>{const pages=browser.contexts().flatMap(c=>c.pages());page=pages.find(p=>/tauri\.localhost/.test(p.url())&&!p.url().includes('reminder'));reminder=pages.find(p=>p.url().includes('reminder'));return page&&reminder;},'WebViews');
 for(const p of[page,reminder])p.on('pageerror',e=>errors.push(e.message));
 await page.waitForFunction(()=>document.getElementById('toggle')&&!document.getElementById('toggle').disabled);
 const initial=await desktop(),native=nativeSize();assert.equal(native.awareness,2);assert.equal(native.dpi/96,initial.scale);
 const expectedMainHeight=Math.min(580,Math.floor(initial.workHeight/initial.scale)-24);assert.ok(Math.abs(initial.height-expectedMainHeight)<=2,JSON.stringify({initial,expectedMainHeight}));matrix.push({initialMainWindow:initial});
 results.push('Real HWND is per-monitor DPI aware; native DPI agrees with window scale');
 for(let i=0;i<5;i++){
  await invoke('desktop_action',{action:'mini'});await page.waitForFunction(()=>document.body.classList.contains('mini'));
  const mini=await desktop();assert.ok(Math.abs(mini.width-280)<1);assert.ok(Math.abs(mini.height-80)<1,'mini minimum must not force height 96');
  await invoke('desktop_action',{action:'mini'});await page.waitForFunction(()=>!document.body.classList.contains('mini'));
  const main=await desktop();assert.equal(main.width,initial.width);assert.equal(main.height,initial.height);
 }
 results.push('Repeated main/mini restores preserve DIP dimensions and mini stays 280 × 80');
 // Project the logical space left by common display/scaling combinations into
 // the actual owned native HWND. This does not change Windows display settings.
 for(const [scale,screenWidth,screenHeight] of [...[1,1.25,1.5,1.75,2,2.5,3].map(s=>[s,1366,728]),[2.5,860,910],[3,800,800]]){
  const width=Math.min(400,Math.floor(screenWidth/scale)-24),height=Math.min(580,Math.floor(screenHeight/scale)-24);
  nativeSize(Math.round(width*initial.scale+initial.outerWidth-initial.width*initial.scale),Math.round(height*initial.scale+initial.outerHeight-initial.height*initial.scale));
  await delay(120);
  const actual=await desktop(),viewport=await page.evaluate(()=>({width:innerWidth,height:innerHeight}));
  matrix.push({projectedScale:scale,width,height,actual,viewport});
  console.log(JSON.stringify({scale,width,height,nativeWidth:actual.width,nativeHeight:actual.height,viewport}));
  // Windows may enforce the normal window's minimum. The small viewport cases
  // below emulate the smaller DIP space that layout::fit enables at high DPI.
  if(Math.abs(viewport.height-height)>4||Math.abs(viewport.width-width)>4) await page.setViewportSize({width,height});
  assert.equal(await page.locator('.titlebar .window-button').evaluateAll(buttons=>buttons.every(e=>{const r=e.getBoundingClientRect();return r.left>=0&&r.right<=innerWidth&&r.top>=0&&r.bottom<=innerHeight;})),true,'all title-bar actions stay inside the viewport');
  const before=await invoke('snapshot');
  for(const selector of['#toggle','#reset','#direction']){
   await page.locator(selector).scrollIntoViewIfNeeded();
   const visible=await page.locator(selector).evaluate(e=>{const r=e.getBoundingClientRect();return r.left>=0&&r.right<=innerWidth&&r.top>=0&&r.bottom<=innerHeight;});assert.equal(visible,true,selector+' reachable at '+scale);
  }
  assert.equal(await page.evaluate(()=>document.documentElement.scrollHeight<=innerHeight&&document.documentElement.scrollWidth<=innerWidth),true,'scroll belongs to content, not title bar');
  await page.locator('#settings').evaluate(e=>e.click());await page.locator('#settings-reset').scrollIntoViewIfNeeded();
  const settingsReachable=await page.locator('#settings-reset').evaluate(e=>{const r=e.getBoundingClientRect();return r.left>=0&&r.right<=innerWidth&&r.top>=0&&r.bottom<=innerHeight;});assert.equal(settingsReachable,true);
  await page.locator('#settings-back').evaluate(e=>e.click());assert.equal((await invoke('snapshot')).revision,before.revision);
  await page.screenshot({path:path.join(evidence,'viewport-'+scale+'-'+width+'.png'),animations:'disabled'});
 }
 results.push('Actual native client sizes projected from 100–300% scaling keep timer actions and bottom settings reachable without clipping or timer reset');
 nativeSize(initial.outerWidth,initial.outerHeight);await invoke('action',{action:'start'});
 await wait(async()=>(await desktop()).reminderVisible,'completion');
 const d=await desktop();assert.ok(Math.abs(d.reminderX+d.reminderWidth/2-d.workX-d.workWidth/2)<=1);assert.ok(Math.abs(d.reminderY+d.reminderHeight/2-d.workY-d.workHeight/2)<=1);
 await reminder.locator('#dismiss').evaluate(e=>e.click());await wait(async()=>!(await desktop()).reminderVisible,'dismiss');
 results.push('Native completion reminder is centered in the work area and remains manually dismissible');
 assert.deepEqual(errors,[]);await close();
 const result={passed:true,version:build.version,sha256:createHash('sha256').update(readFileSync(exe)).digest('hex'),results,matrix,native,errors,evidence,limits:['100–300% geometry uses unit matrices and projected native client viewports. Windows host scaling was not changed; physical mixed-DPI monitor transitions are not certified.']};
 writeFileSync(path.join(build.output,'acceptance/scaling-result.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result));
}catch(error){writeFileSync(path.join(evidence,'failure.json'),JSON.stringify({error:String(error),stack:error.stack,errors,results,logs},null,2));try{await close();}catch{}throw error;}
