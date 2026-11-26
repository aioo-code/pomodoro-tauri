import {chromium} from 'playwright-core';
import {spawn, spawnSync} from 'node:child_process';
import {createServer} from 'node:net';
import {once} from 'node:events';
import {mkdirSync, readFileSync, writeFileSync, readdirSync, existsSync, symlinkSync} from 'node:fs';
import {createHash, randomUUID} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import assert from 'node:assert/strict';
import path from 'node:path';
import {root, env} from './environment.mjs';

const build = JSON.parse(readFileSync(path.join(root, 'tmp/settings-build-current.json')));
const exe = path.join(build.output, 'pomodoro-connected.exe');
const evidence = path.join(build.output, 'acceptance', 'private-directory-' + randomUUID());
mkdirSync(evidence, {recursive:true});
const results = [], errors = [], aclEvidence = [];
let child, browser, page;
const invoke = (command,args) => page.evaluate(({command,args}) => window.__TAURI__.core.invoke(command,args), {command,args});
async function wait(check,label,timeout=15000) {
  const end = Date.now()+timeout;
  while (Date.now()<end) {if (child?.exitCode != null) throw Error('Owned QA process exited'); if (await check()) return; await delay(60);}
  throw Error('Timed out: '+label);
}
function security(file) {
  const call = spawnSync('pwsh', ['-NoProfile', '-Command', '$acl = Get-Acl -LiteralPath $env:POMODORO_ACL_FILE; $identity = [System.Security.Principal.WindowsIdentity]::GetCurrent(); [pscustomobject]@{Owner=$acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value;User=$identity.User.Value;TokenOwner=$identity.Owner.Value;Protected=$acl.AreAccessRulesProtected;Sddl=$acl.Sddl} | ConvertTo-Json -Compress'], {env:{...env,POMODORO_ACL_FILE:file}, windowsHide:true, encoding:'utf8', timeout:8000});
  if (call.error) throw call.error; assert.equal(call.status,0,call.stderr);
  return JSON.parse(call.stdout.trim());
}
async function launch(run,data,simulate=false) {
  mkdirSync(run,{recursive:true});
  const server=createServer();server.listen(0,'127.0.0.1');await once(server,'listening');const port=server.address().port;await new Promise(resolve=>server.close(resolve));
  const args=['--qa-hidden','--tool-data-dir='+data,'--qa-preferences-file='+path.join(run,'preferences.json')];
  if (simulate) args.push('--qa-legacy-empty-owner');
  child=spawn(exe,args,{cwd:run,env:{...env,WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS:`--remote-debugging-port=${port} --remote-debugging-address=127.0.0.1`},windowsHide:true,stdio:['ignore','pipe','pipe']});
  let logs='';for(const stream of [child.stdout,child.stderr])stream.on('data',data=>logs+=data);
  await wait(async()=>{if(child.exitCode!==null)throw Error(logs);try{return(await fetch(`http://127.0.0.1:${port}/json/version`)).ok;}catch{return false;}},'native launch',40000);
  browser=await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  await wait(()=>{page=browser.contexts().flatMap(c=>c.pages()).find(p=>/tauri\.localhost/.test(p.url())&&!p.url().includes('reminder'));return page;},'main WebView');
  page.on('pageerror',error=>errors.push(error.message));
  await page.waitForFunction(()=>document.querySelector('#toggle')&&!document.querySelector('#toggle').disabled);
}
async function close() {
  if(child?.exitCode===null){const exited=once(child,'exit');await invoke('desktop_action',{action:'quit'}).catch(()=>{});await Promise.race([exited,delay(8000)]);assert.notEqual(child.exitCode,null);}
  await browser?.close().catch(()=>{});
}
function checkPrivate(data) {
  for(const leaf of ['', 'engine.lock']) {
    const file=path.join(data,leaf), acl=security(file);assert.equal(acl.Owner,acl.User,file);assert.equal(acl.Protected,true,file);
    aclEvidence.push({file,...acl});
  }
}
try {
  const fresh=path.join(evidence,'fresh'), data=path.join(fresh,'tool-state');
  await launch(fresh,data);
  checkPrivate(data);
  await invoke('set_preferences',{patch:{accent:'candy-orange'}});
  await page.locator('#toggle').evaluate(el=>el.click());await wait(async()=>(await invoke('snapshot')).status==='running','timer running');
  await page.locator('#toggle').evaluate(el=>el.click());await wait(async()=>(await invoke('snapshot')).status==='paused','timer paused');
  await close();
  const saved=path.join(data,'preserve.txt');writeFileSync(saved,'existing state must remain intact');
  const file=path.join(data,'engine.lock'), aclBefore=security(file);
  await launch(fresh,data);assert.equal((await invoke('get_preferences')).values.accent,'candy-orange');assert.equal(readFileSync(saved,'utf8'),'existing state must remain intact');
  assert.equal(security(file).Owner,aclBefore.Owner);await close();
  results.push('Fresh private roots and request lock files have actual TokenUser owners and protected ACLs; populated state and preferences survive restart');

  const empty=path.join(evidence,'legacy-empty'), emptyData=path.join(empty,'tool-state');mkdirSync(emptyData,{recursive:true});
  const originalAcl=security(emptyData);
  await launch(empty,emptyData,true);checkPrivate(emptyData);await close();
  const backups=readdirSync(empty).filter(name=>name.startsWith('tool-state.legacy-empty-'));assert.equal(backups.length,1);
  const backup=path.join(empty,backups[0]);assert.deepEqual(readdirSync(backup),[]);assert.equal(security(backup).Sddl,originalAcl.Sddl);
  await launch(empty,emptyData,true);await close();assert.equal(readdirSync(empty).filter(name=>name.startsWith('tool-state.legacy-empty-')).length,1);
  results.push('Simulated legacy owner classification exercises the real empty-directory backup and SDK recreation; original ACL retained and second launch does not repeat recovery');

  const nonempty=path.join(evidence,'nonempty'), populated=path.join(nonempty,'tool-state');mkdirSync(populated,{recursive:true});writeFileSync(path.join(populated,'keep.bin'),Buffer.from([0,11,255,3]));
  await launch(nonempty,populated,true);await close();assert.deepEqual(readFileSync(path.join(populated,'keep.bin')),Buffer.from([0,11,255,3]));
  assert.equal(readdirSync(nonempty).some(name=>name.startsWith('tool-state.legacy-empty-')),false);
  results.push('A populated directory is never backed up or replaced by the empty-legacy recovery branch');

  const linked=path.join(evidence,'linked'), target=path.join(linked,'target'), link=path.join(linked,'tool-state');mkdirSync(target,{recursive:true});writeFileSync(path.join(target,'keep.txt'),'untouched');symlinkSync(target,link,'junction');
  const call=spawnSync(exe,['--qa-hidden','--qa-legacy-empty-owner','--tool-data-dir='+link,'--qa-preferences-file='+path.join(linked,'preferences.json')],{cwd:linked,env,windowsHide:true,encoding:'utf8',timeout:15000});
  if(call.error)throw call.error;assert.equal(call.status,1,call.stderr);assert.ok(readFileSync(path.join(linked,'startup-error.log'),'utf8').includes('reparse point'));
  assert.equal(readFileSync(path.join(target,'keep.txt'),'utf8'),'untouched');assert.deepEqual(readdirSync(target),['keep.txt']);
  assert.equal(existsSync(path.join(target,'engine.lock')),false);
  results.push('A real junction is refused before recovery; its target and contents remain untouched');
  assert.deepEqual(errors,[]);
  const result={passed:true,version:build.version,sha256:createHash('sha256').update(readFileSync(exe)).digest('hex'),results,errors,aclEvidence,evidence,limits:['Host token is not elevated. Actual new-directory/file owner SIDs and ACLs were checked; the legacy Administrators-owner classification was simulated in isolated QA. Real Windows 10 Administrator launch remains unverified.']};
  writeFileSync(path.join(build.output,'acceptance/private-directory-result.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result));
} catch(error) {
  writeFileSync(path.join(evidence,'failure.json'),JSON.stringify({error:String(error),stack:error.stack,results,errors,aclEvidence},null,2));try{await close();}catch{}throw error;
}
