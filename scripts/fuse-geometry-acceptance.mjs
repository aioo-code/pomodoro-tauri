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
const evidence=path.join(build.output,'acceptance','fuse-'+randomUUID());mkdirSync(evidence,{recursive:true});
const results=[],errors=[],matrix=[];let child,browser,page,logs='';
const invoke=(command,args)=>page.evaluate(({command,args})=>window.__TAURI__.core.invoke(command,args),{command,args});
async function wait(check,label,timeout=12000){const end=Date.now()+timeout;while(Date.now()<end){if(child?.exitCode!=null)throw Error(logs);if(await check())return;await delay(35);}throw Error('Timed out: '+label);}
async function close(){if(child?.exitCode===null){const exited=once(child,'exit');await invoke('desktop_action',{action:'quit'}).catch(()=>{});await Promise.race([exited,delay(8000)]);assert.notEqual(child.exitCode,null);}await browser?.close().catch(()=>{});}
try{
 const server=createServer();server.listen(0,'127.0.0.1');await once(server,'listening');const port=server.address().port;await new Promise(resolve=>server.close(resolve));
 child=spawn(exe,['--qa-hidden','--qa-preferences-file='+path.join(evidence,'preferences.json'),'--tool-data-dir='+path.join(evidence,'tool-state')],{cwd:evidence,env:{...env,WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS:`--remote-debugging-port=${port} --remote-debugging-address=127.0.0.1`},windowsHide:true,stdio:['ignore','pipe','pipe']});
 for(const s of[child.stdout,child.stderr])s.on('data',d=>logs+=d);
 await wait(async()=>{try{return(await fetch(`http://127.0.0.1:${port}/json/version`)).ok;}catch{return false;}},'launch',40000);
 browser=await chromium.connectOverCDP(`http://127.0.0.1:${port}`);await wait(()=>{page=browser.contexts().flatMap(c=>c.pages()).find(p=>/tauri\.localhost/.test(p.url())&&!p.url().includes('reminder'));return page;},'main');
 page.on('pageerror',e=>errors.push(e.message));await page.waitForFunction(()=>document.getElementById('toggle')&&!document.getElementById('toggle').disabled);
 await invoke('action',{action:'start'});await page.waitForFunction(()=>document.querySelector('.timer-fuse')?.dataset.phase==='armed');const before=await invoke('snapshot');
 for(const theme of['light','dark']){
  if(await page.evaluate(()=>document.documentElement.dataset.theme)!==theme){await page.locator('#theme').evaluate(e=>e.click());await page.waitForFunction(theme=>document.documentElement.dataset.theme===theme,theme);}
  for(const accent of['blue','candy-lime'])for(const size of[{width:400,height:520},{width:360,height:480},{width:242,height:242}]){
   await page.setViewportSize(size);
   for(const radius of[0,12,20,22,32]){
    await invoke('set_preferences',{patch:{cornerRadius:radius,accent}});
    await wait(()=>page.locator('.timer-fuse').evaluate((e,r)=>parseFloat(getComputedStyle(e).getPropertyValue('--fb-radius'))===r,radius),'corner preference');
    await delay(40);
    const geometry=await page.locator('.timer-fuse').evaluate(e=>{const b=e.getBoundingClientRect(),s=e.querySelector('svg.fuse-button__rim'),r=s.querySelector('rect'),css=getComputedStyle(r);return {width:b.width,height:b.height,rx:r.rx.baseVal.value,ry:r.ry.baseVal.value,x:r.x.baseVal.value,y:r.y.baseVal.value,rw:r.width.baseVal.value,rh:r.height.baseVal.value,stroke:parseFloat(css.strokeWidth),filter:getComputedStyle(s).filter,opacity:Number(getComputedStyle(s).opacity),dash:parseFloat(css.strokeDashoffset)};});
    const expected=Math.max(0,Math.min(radius,geometry.width/2,geometry.height/2)-geometry.stroke/2);
    assert.ok(Math.abs(geometry.rx-expected)<.1,JSON.stringify({radius,expected,geometry}));assert.equal(geometry.rx,geometry.ry);
    assert.ok(Math.abs(geometry.rw+geometry.stroke-geometry.width)<.1);assert.ok(Math.abs(geometry.rh+geometry.stroke-geometry.height)<.1);
    assert.equal(geometry.filter,'none');assert.ok(geometry.opacity>0&&geometry.opacity<=1);assert.ok(geometry.dash>=0&&geometry.dash<=1);
    matrix.push({theme,accent,size,radius,geometry});
    if(radius===32&&accent==='candy-lime'&&size.width===400)await page.locator('.timer-fuse').screenshot({path:path.join(evidence,'maximum-'+theme+'.png'),animations:'disabled'});
   }
  }
 }
 await page.locator('#toggle').evaluate(e=>e.click());await page.waitForFunction(()=>document.querySelector('.timer-fuse').dataset.phase==='idle');await delay(220);assert.equal(await page.locator('.fuse-button__rim').evaluate(e=>Number(getComputedStyle(e).opacity)),0);
 assert.equal((await invoke('snapshot')).status,'paused');assert.equal((await invoke('snapshot')).revision,before.revision+1);
 results.push('60 actual-WebView combinations of radius 0–32, three viewport sizes, blue/lime and light/dark preserve equal SVG corner axes, in-bounds geometry and a glow-free progress stroke');
 results.push('Pause still works and hides the running outline; visual preference changes preserve the running timer');
 assert.deepEqual(errors,[]);await close();
 const result={passed:true,version:build.version,sha256:createHash('sha256').update(readFileSync(exe)).digest('hex'),results,errors,matrix,evidence};writeFileSync(path.join(build.output,'acceptance/fuse-geometry-result.json'),JSON.stringify(result,null,2));console.log(JSON.stringify({passed:true,version:build.version,results,evidence}));
}catch(error){writeFileSync(path.join(evidence,'failure.json'),JSON.stringify({error:String(error),stack:error.stack,matrix,errors,logs},null,2));try{await close();}catch{}throw error;}
