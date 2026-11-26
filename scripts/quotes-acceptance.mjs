import {chromium} from 'playwright-core';
import {spawn} from 'node:child_process';
import {createServer} from 'node:net';
import {once} from 'node:events';
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {randomUUID,createHash} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import assert from 'node:assert/strict';
import path from 'node:path';
import {root,env} from './environment.mjs';
const build=JSON.parse(readFileSync(path.join(root,'tmp/settings-build-current.json'))),exe=path.join(build.output,'pomodoro-connected.exe');
const evidence=path.join(build.output,'acceptance','quotes-'+randomUUID());mkdirSync(evidence,{recursive:true});
const prefs=path.join(evidence,'preferences.json'),data=path.join(evidence,'tool-state'),results=[],errors=[];
let child,browser,page;
const invoke=(command,args)=>page.evaluate(({command,args})=>window.__TAURI__.core.invoke(command,args),{command,args});
const values=async()=>(await invoke('get_preferences')).values;
const quote=()=>page.locator('p[data-quote="true"] .quote-inline').textContent();
async function wait(check,label,timeout=15000){const end=Date.now()+timeout;while(Date.now()<end){if(await check())return;await delay(60);}throw Error('Timed out: '+label);}
async function click(selector){await wait(()=>page.locator(selector).isEnabled(),'enabled '+selector);await page.locator(selector).scrollIntoViewIfNeeded();await page.locator(selector).evaluate(e=>e.click());}
async function settings(){await click('#settings');await page.locator('#quote-settings').scrollIntoViewIfNeeded();}
async function leave(){await page.keyboard.press('Escape');await page.locator('#settings-panel').waitFor({state:'hidden'});}
async function launch(){
 const server=createServer();server.listen(0,'127.0.0.1');await once(server,'listening');const port=server.address().port;await new Promise(r=>server.close(r));
 child=spawn(exe,['--qa-hidden','--qa-preferences-file='+prefs,'--tool-data-dir='+data],{cwd:evidence,env:{...env,WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS:`--remote-debugging-port=${port} --remote-debugging-address=127.0.0.1`},windowsHide:true,stdio:['ignore','pipe','pipe']});
 let log='';child.stderr.on('data',b=>log+=b);child.stdout.on('data',b=>log+=b);
 await wait(async()=>{if(child.exitCode!==null)throw Error(log);try{return(await fetch(`http://127.0.0.1:${port}/json/version`)).ok;}catch{return false;}},'native startup',45000);
 browser=await chromium.connectOverCDP(`http://127.0.0.1:${port}`);await wait(()=>{page=browser.contexts().flatMap(c=>c.pages()).find(p=>/tauri\.localhost/.test(p.url())&&!p.url().includes('reminder'));return !!page;},'WebView');
 page.on('pageerror',e=>errors.push(e.message));await page.waitForFunction(()=>document.getElementById('toggle')&&!document.getElementById('toggle').disabled);
}
async function close(){if(child?.exitCode===null){await invoke('desktop_action',{action:'quit'}).catch(()=>{});await Promise.race([once(child,'exit'),delay(12000)]);assert.notEqual(child.exitCode,null,'Owned QA process must close normally');}if(browser)await browser.close();}
function mark(text){results.push(text);console.log(text);}
try{
 await launch();await wait(()=>page.locator('.quote-inline').count().then(n=>n===1),'default maxim');assert.equal((await values()).quotes.length,6);
 for(const [language,expected]of Object.entries({zh:'先做好眼前这一小步。',en:'Start with this small step.',ja:'まず、目の前の小さな一歩を。',de:'Beginne mit diesem kleinen Schritt.',eo:'Komencu per ĉi tiu eta paŝo.'})){
   await invoke('set_preferences',{patch:{language}});await wait(async()=>(await quote())===expected,'localized built-in '+language);
 }
 await invoke('set_preferences',{patch:{language:'zh'}});await settings();await wait(()=>page.locator('#setting-quotes').isEnabled(),'editor loaded');
 for(let index=0;index<6;index++)await click('.quote-item-actions button:last-child >> nth=0');
 await wait(async()=>(await values()).quotes.length===0,'delete built-ins');
 const custom='把眼前的小事做好。';await page.locator('#quote-text').fill(custom);await click('#quote-save');await wait(async()=>(await values()).quotes.length===1,'add custom');
 await click('.quote-item-actions button:first-child');await page.locator('#quote-text').fill(custom+'慢慢来。');await click('#quote-save');
 await wait(async()=>(await values()).quotes[0].text===custom+'慢慢来。','edit custom');
 await page.locator('#quote-text').fill('只做一件事。');await click('#quote-save');await wait(async()=>(await values()).quotes.length===2,'second custom');
 await leave();const initial=await quote();await invoke('action',{action:'toggle'});await wait(async()=>(await quote())!==initial,'new segment rotates maxim');const active=await quote();
 await invoke('action',{action:'toggle'});await wait(()=>page.locator('#status').textContent().then(v=>v==='已暂停'),'paused state');assert.equal(await quote(),active);await invoke('action',{action:'toggle'});assert.equal(await quote(),active);
 await click('#mini');await wait(()=>page.locator('body').getAttribute('class').then(c=>c?.includes('mini')),'mini mode');assert.equal(await quote(),active);
 await page.locator('#time').evaluate(el=>el.click());assert.equal(await quote(),active);
 const footer=await page.locator('.mini-feedback').boundingBox();assert.ok(footer.y>=62&&footer.y+footer.height<=77,JSON.stringify(footer));assert.equal(await page.locator('.mini-feedback').getAttribute('data-kind'),'quote');
 await page.screenshot({path:path.join(evidence,'mini-quote.png'),animations:'disabled'});
 await page.evaluate(()=>{const original=window.__TAURI__,native=original.core.invoke;window.__quotesRestore=original;window.__TAURI__={...original,core:{...original.core,invoke:(command,args)=>command==='snapshot'?Promise.reject(Error('QA unavailable')):native(command,args)}};});
 await page.locator('.mini-feedback[data-kind="alert"] #error').waitFor();assert.equal(await page.locator('.mini-feedback .quote-inline').count(),0);
 await page.evaluate(()=>{window.__TAURI__=window.__quotesRestore});await wait(()=>page.locator('.mini-feedback').getAttribute('data-kind').then(v=>v==='quote'),'alert recovery');
 await click('#mini');await wait(()=>page.locator('body').getAttribute('class').then(c=>!c?.includes('mini')),'main mode');
 await invoke('set_preferences',{patch:{language:'de'}});await wait(()=>page.evaluate(()=>document.documentElement.lang==='de'),'custom language change');assert.equal(await quote(),active);
 await invoke('action',{action:'reset'});await invoke('set_preferences',{patch:{language:'zh',quotesEnabled:false}});await wait(()=>page.locator('.quote-inline').count().then(n=>n===0),'disabled quotes');await wait(()=>page.locator('#status').textContent().then(v=>v==='准备开始'),'ready state');
 await click('#mini');await wait(()=>page.locator('.mini-feedback').getAttribute('data-kind').then(v=>v==='status'),'mini status fallback');
 assert.equal(await page.locator('.mini-message').textContent(),'准备开始');await invoke('action',{action:'toggle'});await wait(()=>page.locator('.mini-message').textContent().then(v=>v==='专注中'),'running fallback');await invoke('action',{action:'toggle'});await wait(()=>page.locator('.mini-message').textContent().then(v=>v==='已暂停'),'paused fallback');
 await click('#mini');await wait(()=>page.locator('body').getAttribute('class').then(c=>!c?.includes('mini')),'restore main');await invoke('action',{action:'reset'});
 const literal='<img src=x onerror=alert(1)> '+ '专注'.repeat(45),entry={id:'literal-quote',text:literal};
 await invoke('set_preferences',{patch:{quotesEnabled:true,quotes:[entry]}});await wait(async()=>(await quote())===literal,'literal custom maxim');assert.equal(await page.locator('img[src=x]').count(),0);
 for(const radius of [0,32])for(const style of ['comet','arc','orbit','ticks','digits']){
  await invoke('set_preferences',{patch:{cornerRadius:radius,timerStyle:style}});await page.setViewportSize({width:360,height:540});
  const layout=await page.locator('.timer-caption .clock-status').evaluate(el=>{const a=el.getBoundingClientRect(),b=document.querySelector('.clock-section').getBoundingClientRect();return{top:a.top,graphBottom:b.bottom,scroll:document.documentElement.scrollWidth>innerWidth||document.documentElement.scrollHeight>innerHeight};});assert.ok(layout.top>=layout.graphBottom);assert.equal(layout.scroll,false);
 }
 await page.screenshot({path:path.join(evidence,'main-quote.png'),animations:'disabled'});await settings();await click('#settings-reset');await wait(async()=>{const current=await values();return current.cornerRadius===20&&current.quotes[0]?.text===literal;},'defaults retain user text');
 await close();await launch();assert.equal((await values()).quotes[0].text,literal);await wait(async()=>(await quote())===literal,'custom maxim persisted');
 await invoke('set_preferences',{patch:{quotes:[]}});await wait(()=>page.locator('.quote-inline').count().then(n=>n===0),'empty list fallback');assert.equal(await page.locator('#status').textContent(),'准备开始');
 await assert.rejects(invoke('set_preferences',{patch:{quotes:[{id:'too-long',text:'长'.repeat(121)}]}}));assert.deepEqual((await values()).quotes,[]);
 await close();assert.deepEqual(errors,[]);mark('Original built-ins translate; custom maxims add/edit/delete and survive defaults and restart. Timer-segment rotation is stable across pause/resume, mini mode and progress view.');mark('Empty/disabled maxims restore real status; mini alerts take priority. Long and HTML-like text remains literal and bounded across all timer styles and corner extremes.');
 const result={passed:true,mode:'native',version:build.version,sha256:createHash('sha256').update(readFileSync(exe)).digest('hex'),results,errors,evidence,productionDataTouched:false};writeFileSync(path.join(build.output,'acceptance/quotes-result.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result));
}catch(error){writeFileSync(path.join(evidence,'failure.json'),JSON.stringify({error:String(error),stack:error.stack,results,errors},null,2));await close();throw error;}
