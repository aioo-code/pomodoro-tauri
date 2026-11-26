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
const read=file=>JSON.parse(readFileSync(file,'utf8')),hash=file=>createHash('sha256').update(readFileSync(file)).digest('hex');
const build=read(path.join(root,'tmp/settings-build-current.json')),exe=path.join(build.output,'pomodoro-connected.exe');
const evidence=path.join(build.output,'acceptance','update-'+randomUUID());mkdirSync(evidence,{recursive:true});
const prior=read(path.join(root,'artifacts/builds/0.6.0-dev.20261107.5/delivery.json')),oldExe=path.join(root,'artifacts/builds/0.6.0-dev.20261107.5/pomodoro-connected.exe');assert.equal(hash(oldExe),prior.sha256);
const current=read(path.join(build.output,'delivery.json'));
for(const file of['frontend/lib/drag.ts','frontend/lib/drag-queue.ts','src-tauri/src/drag.rs'])assert.equal(current.sources[file],prior.sources[file],'touch/mouse drag implementation deliberately remains unchanged');
let child,browser,page,logs='';const results=[],errors=[],fixtures=[];
const invoke=(command,args)=>page.evaluate(({command,args})=>window.__TAURI__.core.invoke(command,args),{command,args});
async function wait(check,label,timeout=15000){const end=Date.now()+timeout;while(Date.now()<end){if(await check())return;await delay(40);}throw Error('Timed out: '+label+' '+logs);}
function helper(target,check=false){const p=spawnSync(exe,['--prepare-update',target,'--tool-qa',...(check?['--check']:[])],{cwd:evidence,env,encoding:'utf8',windowsHide:true,timeout:60000});assert.equal(p.error,undefined);return {code:p.status,report:JSON.parse(p.stdout.trim())};}
async function launchOld(){
 const server=createServer();server.listen(0,'127.0.0.1');await once(server,'listening');const port=server.address().port;await new Promise(resolve=>server.close(resolve));
 child=spawn(oldExe,['--qa-hidden','--qa-seconds=60','--qa-preferences-file='+path.join(evidence,'preferences.json'),'--tool-data-dir='+path.join(evidence,'tool-state')],{cwd:evidence,env:{...env,WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS:`--remote-debugging-port=${port} --remote-debugging-address=127.0.0.1`},windowsHide:true,stdio:['ignore','pipe','pipe']});
 for(const s of[child.stdout,child.stderr])s.on('data',d=>logs+=d);
 await wait(async()=>{if(child.exitCode!==null)throw Error(logs);try{return(await fetch(`http://127.0.0.1:${port}/json/version`)).ok;}catch{return false;}},'old native launch',40000);
 browser=await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
 await wait(()=>{page=browser.contexts().flatMap(c=>c.pages()).find(p=>/tauri\.localhost/.test(p.url())&&!p.url().includes('reminder'));return page;},'old WebView');
 page.on('pageerror',e=>errors.push(e.message));await page.waitForFunction(()=>document.getElementById('toggle')&&!document.getElementById('toggle').disabled);
}
async function closeOld(){if(child?.exitCode===null){await invoke('desktop_action',{action:'quit'}).catch(()=>{});await wait(()=>child.exitCode!==null,'owned close');}await browser?.close().catch(()=>{});}
function mark(value){results.push(value);console.log(value);}
const formsSource=path.join(evidence,'fixture.cs');
writeFileSync(formsSource,`using System;using System.IO;using System.Windows.Forms;using System.Drawing;
class Fixture:Form {
 string dir,mode;Timer timer=new Timer();
 public Fixture(string d,string m){dir=d;mode=m;Text="Owned update fixture";ShowInTaskbar=false;Opacity=0;Size=new Size(10,10);timer.Interval=80;timer.Tick+=(s,e)=>{if(File.Exists(Path.Combine(dir,"close"))){timer.Stop();Close();}};timer.Start();Shown+=(s,e)=>File.WriteAllText(Path.Combine(dir,"ready"),"ready");}
 protected override bool ShowWithoutActivation {get{return true;}}
 protected override CreateParams CreateParams {get{var p=base.CreateParams;p.ExStyle|=0x08000080;return p;}}
 protected override void OnFormClosing(FormClosingEventArgs e){if(mode=="reject"&&!File.Exists(Path.Combine(dir,"close"))){e.Cancel=true;return;}File.WriteAllText(Path.Combine(dir,"session-ended"),"graceful");base.OnFormClosing(e);}
 protected override void WndProc(ref Message m){if(m.Msg==0x11){m.Result=mode=="accept"?new IntPtr(1):IntPtr.Zero;return;}if(m.Msg==0x16&&m.WParam!=IntPtr.Zero){File.WriteAllText(Path.Combine(dir,"session-ended"),"graceful");Environment.Exit(0);}base.WndProc(ref m);}
 [STAThread]static void Main(string[]args){AppDomain.CurrentDomain.ProcessExit+=(s,e)=>File.WriteAllText(Path.Combine(args[0],"session-ended"),"graceful");if(args[1]=="reject"){File.WriteAllText(Path.Combine(args[0],"ready"),"ready");while(!File.Exists(Path.Combine(args[0],"close")))System.Threading.Thread.Sleep(80);return;}Application.Run(new Fixture(args[0],args[1]));}
}`);
async function fixture(name,mode){const dir=path.join(evidence,name);mkdirSync(dir,{recursive:true});const file=path.join(dir,'pomodoro-connected.exe');const compiled=spawnSync('C:/Windows/Microsoft.NET/Framework64/v4.0.30319/csc.exe',['/nologo','/target:winexe','/r:System.Windows.Forms.dll','/r:System.Drawing.dll','/out:'+file,formsSource],{env,windowsHide:true,encoding:'utf8'});assert.equal(compiled.status,0,compiled.stdout+compiled.stderr);const process=spawn(file,[dir,mode],{cwd:dir,env,windowsHide:true,stdio:'ignore'});const item={dir,file,process};fixtures.push(item);await wait(()=>{try{return readFileSync(path.join(dir,'ready'),'utf8')==='ready';}catch{return false;}},'fixture ready');return item;}
try {
 const absent=path.join(evidence,'future-install','pomodoro-connected.exe');assert.equal(helper(absent,true).code,0);assert.equal(helper('relative.exe',true).code,2);
 writeFileSync(path.join(evidence,'usage.json'),JSON.stringify({days:{'2026-11-06':3}}));
 await launchOld();await invoke('set_preferences',{patch:{accent:'candy-pink',alwaysOnTop:false}});await invoke('action',{action:'start'});await invoke('desktop_action',{action:'mini'});
 const prefsHash=hash(path.join(evidence,'preferences.json')),usageHash=hash(path.join(evidence,'usage.json'));
 const check=helper(absent,true);assert.equal(check.code,10);assert.equal(check.report.instances.length,1);assert.equal(check.report.instances[0].pid,child.pid);assert.equal(child.exitCode,null);
 const stop=helper(absent);assert.equal(stop.code,0,JSON.stringify(stop));assert.equal(stop.report.closed,1);assert.equal(stop.report.shutdown,'graceful_restart_manager');await wait(()=>child.exitCode!==null,'old app exits');assert.equal(child.exitCode,0);await browser.close().catch(()=>{});
 assert.equal(hash(path.join(evidence,'preferences.json')),prefsHash);assert.equal(hash(path.join(evidence,'usage.json')),usageHash);
 mark('New installer helper normally closes an actual previous-version hidden/mini instance in another directory; settings and heatmap history remain byte-identical');
 const unrelated=await fixture('unrelated-same-name','accept');assert.equal(helper(absent).code,0);assert.equal(unrelated.process.exitCode,null);writeFileSync(path.join(unrelated.dir,'close'),'close');await wait(()=>unrelated.process.exitCode!==null,'unrelated normal cleanup');
 mark('An unrelated same-name process outside the target and without the authenticated app endpoint is not closed');
 const accepting=await fixture('target-accepts-session','accept');const accepted=helper(accepting.file);assert.equal(accepted.code,0,JSON.stringify(accepted));await wait(()=>accepting.process.exitCode!==null,'target exits');console.log(JSON.stringify({acceptingExit:accepting.process.exitCode,accepted}));assert.equal(readFileSync(path.join(accepting.dir,'session-ended'),'utf8'),'graceful');
 const rejecting=await fixture('target-refuses-session','reject');const refused=helper(rejecting.file);assert.equal(refused.code,2);assert.equal(rejecting.process.exitCode,null,'no force kill on rejection');writeFileSync(path.join(rejecting.dir,'close'),'close');await wait(()=>rejecting.process.exitCode!==null,'refusing target normal cleanup');
 mark('Exact installed-path fallback handles an app without the endpoint; a refusal stops preparation and the process stays alive');
 assert.deepEqual(errors,[]);
 const result={passed:true,version:build.version,sha256:hash(exe),previousVersion:prior.version,previousSha256:hash(oldExe),results,errors,evidence,limits:['Runs owned hidden application/WinForms fixtures and normal Windows Restart Manager messages; no real user installation or active production instance was closed.','Touch dragging remains unchanged from the previous accepted version; physical touch latency remains unresolved.']};
 writeFileSync(path.join(build.output,'acceptance/update-result.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result));
}catch(error){writeFileSync(path.join(evidence,'failure.json'),JSON.stringify({error:String(error),stack:error.stack,results,errors,logs},null,2));try{await closeOld();}catch{}for(const f of fixtures)if(f.process.exitCode===null){writeFileSync(path.join(f.dir,'close'),'close');await wait(()=>f.process.exitCode!==null,'owned fixture cleanup').catch(()=>{});}throw error;}
