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
const evidence=path.join(build.output,'acceptance','primary-glass-'+randomUUID());mkdirSync(evidence,{recursive:true});
const results=[],errors=[],matrix=[];let child,browser,page,logs='';
const invoke=(command,args)=>page.evaluate(({command,args})=>window.__TAURI__.core.invoke(command,args),{command,args});
async function wait(check,label,timeout=12000){const end=Date.now()+timeout;while(Date.now()<end){if(child?.exitCode!=null)throw Error(logs);if(await check())return;await delay(35);}throw Error('Timed out: '+label);}
async function close(){if(child?.exitCode===null){const exited=once(child,'exit');await invoke('desktop_action',{action:'quit'}).catch(()=>{});await Promise.race([exited,delay(8000)]);assert.notEqual(child.exitCode,null);}await browser?.close().catch(()=>{});}
const rgb=text=>text.match(/[\d.]+/g).map(Number);
const luma=rgb=>rgb.slice(0,3).map(v=>{v/=255;return v<=.04045?v/12.92:((v+.055)/1.055)**2.4;}).reduce((sum,v,i)=>sum+v*[.2126,.7152,.0722][i],0);
const contrast=(a,b)=>{const x=luma(a),y=luma(b);return(Math.max(x,y)+.05)/(Math.min(x,y)+.05);};
try{
 const server=createServer();server.listen(0,'127.0.0.1');await once(server,'listening');const port=server.address().port;await new Promise(r=>server.close(r));
 child=spawn(exe,['--qa-hidden','--qa-preferences-file='+path.join(evidence,'preferences.json'),'--tool-data-dir='+path.join(evidence,'tool-state')],{cwd:evidence,env:{...env,WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS:`--remote-debugging-port=${port} --remote-debugging-address=127.0.0.1`},windowsHide:true,stdio:['ignore','pipe','pipe']});
 for(const s of[child.stdout,child.stderr])s.on('data',d=>logs+=d);
 await wait(async()=>{try{return(await fetch(`http://127.0.0.1:${port}/json/version`)).ok;}catch{return false;}},'launch',40000);
 browser=await chromium.connectOverCDP(`http://127.0.0.1:${port}`);await wait(()=>{page=browser.contexts().flatMap(c=>c.pages()).find(p=>/tauri\.localhost/.test(p.url())&&!p.url().includes('reminder'));return page;},'main');
 page.on('pageerror',e=>errors.push(e.message));await page.waitForFunction(()=>document.getElementById('toggle')&&!document.getElementById('toggle').disabled);
 assert.equal(await page.locator('.fuse-button').count(),0);assert.equal(await page.locator('#toggle').evaluate(e=>e.tagName),'BUTTON');
 await page.locator('#toggle').evaluate(e=>e.click());await wait(async()=>(await invoke('snapshot')).status==='running','start');const before=await invoke('snapshot');
 const accents=['tomato','blue','teal','green','violet','rose','amber','candy-pink','candy-purple','candy-blue','candy-orange','candy-lime','black','white'];
 for(const theme of['light','dark']){
  if(await page.evaluate(()=>document.documentElement.dataset.theme)!==theme){await page.locator('#theme').evaluate(e=>e.click());await page.waitForFunction(theme=>document.documentElement.dataset.theme===theme,theme);}
  const levels=[];
  for(const accent of accents){
   await invoke('set_preferences',{patch:{accent,acrylic:true}});await wait(()=>page.evaluate(accent=>document.documentElement.dataset.accent===accent&&document.documentElement.dataset.material==='acrylic',accent),'glass accent');
   const paint=await page.evaluate(()=>{const b=getComputedStyle(document.getElementById('toggle')),s=getComputedStyle(document.querySelector('.app-shell'));return{background:b.backgroundColor,ink:b.color,light:Number(b.getPropertyValue('--focus-light')),glass:s.backgroundColor};});
   const glass=rgb(paint.glass),bg=rgb(paint.background),fg=rgb(paint.ink),spot=bg.slice(0,3).map((v,i)=>((v*.98+255*.02)*.99+fg[i]*.01)*(1-paint.light)+255*paint.light);
   assert.ok(Math.abs(glass[3]-(theme==='dark'?.18:.28))<.001);assert.ok(contrast(fg,bg)>=4.5,JSON.stringify({theme,accent,paint}));assert.ok(contrast(fg,spot)>=4.5,JSON.stringify({theme,accent,paint,spot}));levels.push(luma(glass));
   matrix.push({theme,accent,paint});
  }
  assert.ok(Math.max(...levels)-Math.min(...levels)<.006,'Accent surface luminance stays within 8-bit quantization tolerance');
  for(const accent of['blue','candy-lime'])for(const size of[{width:400,height:520},{width:360,height:480},{width:242,height:242}]){
   await page.setViewportSize(size);
   for(const radius of[0,12,20,22,32]){
    await invoke('set_preferences',{patch:{cornerRadius:radius,accent}});await wait(()=>page.evaluate(radius=>document.documentElement.dataset.cornerRadius===String(radius),radius),'radius');
    const box=await page.locator('#toggle').evaluate(e=>{const r=e.getBoundingClientRect(),c=getComputedStyle(e);return{x:r.x,y:r.y,width:r.width,height:r.height,radius:parseFloat(c.borderRadius),border:parseFloat(c.borderTopWidth),style:c.borderTopStyle,svgRim:e.querySelectorAll('.fuse-button__rim').length,viewport:innerWidth,clockCenter:(()=>{const r=document.querySelector('.clock-section').getBoundingClientRect();return r.x+r.width/2;})()};});
    assert.equal(box.radius,radius);assert.ok(box.border>0&&box.border<=1.1);assert.equal(box.style,'solid');assert.equal(box.svgRim,0);assert.ok(Math.abs(box.x+box.width/2-box.clockCenter)<=1,JSON.stringify(box));assert.ok(box.x>=0&&box.x+box.width<=box.viewport);assert.ok(box.height>=43.5);matrix.push({theme,accent,size,radius,box});
   }
  }
 }
 results.push('Thirteen accents in both themes use the same low-opacity, equal-luminance glass; text passes contrast checks at the brightest hover hotspot. Sixty size/radius combinations retain a single in-bounds solid border.');
 await page.setViewportSize({width:400,height:520});await invoke('set_preferences',{patch:{accent:'blue',cornerRadius:32,reduceMotion:false}});const button=page.locator('#toggle'),b=await button.boundingBox();
 const stage=page.locator('.app-shell.spotlight-card'),light=stage.locator(':scope > .spotlight-card__light');assert.equal(await stage.count(),1);assert.equal(await stage.getAttribute('data-disabled'),'false');
 const area=await stage.boundingBox();await page.mouse.move(area.x+12,area.y+80);await wait(()=>light.evaluate(e=>Number(getComputedStyle(e).opacity)>.01),'panel spotlight');const paint=await light.evaluate(e=>e.style.background);
 await page.mouse.move(area.x+area.width-12,area.y+140);await delay(250);assert.notEqual(await light.evaluate(e=>e.style.background),paint);assert.equal(await stage.evaluate(e=>{const s=getComputedStyle(e);return s.padding==='0px'&&e.getBoundingClientRect().width===innerWidth&&e.getBoundingClientRect().height===innerHeight&&e.querySelectorAll('.timer-stage.spotlight-card').length===0&&getComputedStyle(e.querySelector(':scope > .spotlight-card__border')).display==='none';}),true);assert.equal(await stage.locator('.spotlight-card__edge').evaluate(e=>getComputedStyle(e).pointerEvents),'none');await page.screenshot({path:path.join(evidence,'main-spotlight.png')});
 await page.mouse.move(b.x+b.width*.2,b.y+b.height/2);await delay(200);const left=await button.evaluate(e=>parseFloat(e.style.getPropertyValue('--chroma-x')));await button.screenshot({path:path.join(evidence,'hover-left.png')});assert.equal(await light.evaluate(e=>Number(getComputedStyle(e).opacity)),0,'panel yields to the main button');
 await page.mouse.move(b.x+b.width*.8,b.y+b.height/2);await delay(200);const right=await button.evaluate(e=>parseFloat(e.style.getPropertyValue('--chroma-x')));assert.ok(right-left>b.width*.5);assert.equal(await button.getAttribute('data-spotlight'),'true');await button.screenshot({path:path.join(evidence,'hover-right.png')});
 await page.mouse.move(0,0);await delay(550);assert.equal(await button.getAttribute('data-spotlight'),'false');assert.equal(await page.locator('.focus-primary__light').evaluate(e=>Number(getComputedStyle(e).opacity)),0);
 await invoke('set_preferences',{patch:{reduceMotion:true}});await page.mouse.move(b.x+b.width/2,b.y+b.height/2);assert.equal(await button.getAttribute('data-spotlight'),'false');assert.equal(await button.evaluate(e=>getComputedStyle(e).transform),'none');assert.equal(await stage.getAttribute('data-disabled'),'true');assert.equal(await light.evaluate(e=>getComputedStyle(e).display),'none');
 await button.focus();await page.keyboard.press('Space');await wait(async()=>(await invoke('snapshot')).status==='paused','keyboard pause');assert.equal((await invoke('snapshot')).revision,before.revision+1);assert.equal(await page.locator('.fuse-button').count(),0);
 results.push('ChromaGrid damping, soft mask and border glow follow mouse position and fade on leave; reduced motion disables tracking/transforms. Keyboard pause works and the old effect never mounts.');
 results.push('SpotlightCard covers the entire app shell without an inner card or base border; its soft theme light follows the mouse, yields to the main button and is disabled in reduced motion/settings/mini.');
 await invoke('set_preferences',{patch:{reduceMotion:false}});await page.locator('#settings').evaluate(e=>e.click());await page.locator('.settings-scroll').waitFor();
 const edges=page.locator('.settings-edge-blur');assert.equal(await edges.count(),2);
 const reveal=index=>edges.nth(index).evaluate(e=>Number(e.style.getPropertyValue('--gradual-blur-reveal')));
 await wait(async()=>await reveal(0)===0&&await reveal(1)===1,'top/bottom blur initial boundaries');
 for(const edge of await edges.all())assert.equal(await edge.evaluate(e=>e.children.length>0&&getComputedStyle(e).pointerEvents==='none'&&[...e.children].every(c=>getComputedStyle(c).backdropFilter.includes('blur(')&&getComputedStyle(c).maskImage.includes('linear-gradient'))),true);
 const scroller=page.locator('.settings-scroll');await scroller.evaluate(e=>{e.scrollTop=(e.scrollHeight-e.clientHeight)/2;});
 await wait(async()=>await reveal(0)===1&&await reveal(1)===1,'both blur edges while scrolling');await page.screenshot({path:path.join(evidence,'settings-middle-blur.png')});
 await page.locator('#settings-reset').focus();await wait(async()=>await reveal(1)===0,'last control remains clear at bottom');
 assert.equal(await page.locator('#settings-reset').evaluate(e=>{const a=e.getBoundingClientRect(),b=document.querySelector('.settings-viewport').getBoundingClientRect();return a.top>=b.top&&a.bottom<=b.bottom;}),true);
 await scroller.evaluate(e=>{e.scrollTop=0;});await wait(async()=>await reveal(0)===0,'first controls remain clear at top');
 assert.equal(await page.evaluate(()=>{const h=document.querySelector('.titlebar').getBoundingClientRect(),v=document.querySelector('.settings-viewport').getBoundingClientRect();return !document.querySelector('.settings-heading')&&h.bottom<=v.top+1&&document.documentElement.scrollHeight<=innerHeight&&!!document.querySelector('.titlebar #settings-back');}),true);
 await invoke('set_preferences',{patch:{reduceMotion:true}});assert.equal(await edges.first().evaluate(e=>getComputedStyle(e.firstElementChild).transitionDuration),'0s');
 await page.locator('#settings-back').evaluate(e=>e.click());await wait(()=>page.locator('.settings-edge-blur').count().then(n=>n===0),'blur unmount');
 results.push('GradualBlur and the complete scroll composition feather together at the viewport edges; boundary controls remain clear, the scrollbar remains outside the fade, reduced motion disables transitions and close removes the overlays.');
 const cdp=await browser.contexts()[0].newCDPSession(page);await cdp.send('Emulation.clearDeviceMetricsOverride');await cdp.detach();
 await invoke('set_preferences',{patch:{reduceMotion:false,miniOpacity:100,dimInactive:false,acrylic:true,accent:'blue'}});const mainPaint=await page.locator('.app-shell').evaluate(e=>getComputedStyle(e).backgroundColor);await page.locator('#mini').evaluate(e=>e.click());await page.waitForFunction(()=>document.body.classList.contains('mini'));await wait(()=>page.locator('.app-shell').evaluate((e,c)=>getComputedStyle(e).backgroundColor===c,mainPaint),'mini matches main tint');const d=await invoke('desktop_state');assert.equal(d.widget.acrylic,true);assert.equal(d.widget.layered,false);assert.equal(d.widget.nativeOpacity,100);assert.equal((await invoke('appearance_state')).main.acrylic,true);assert.equal((await invoke('appearance_state')).main.backend,'accent-acrylic');
 results.push('Mini shares the transparent tint and retains native Acrylic on a non-layered host.');
 assert.deepEqual(errors,[]);await close();const result={passed:true,version:build.version,sha256:createHash('sha256').update(readFileSync(exe)).digest('hex'),results,errors,matrix,evidence,limits:['Glass overlay opacity, native compositor state and isolated owned-window visuals are checked; Windows transparency settings still control the system backdrop.']};writeFileSync(path.join(build.output,'acceptance/primary-glass-result.json'),JSON.stringify(result,null,2));console.log(JSON.stringify({passed:true,evidence}));
}catch(error){writeFileSync(path.join(evidence,'failure.json'),JSON.stringify({error:String(error),stack:error.stack,errors,matrix,logs},null,2));try{await close();}catch{}throw error;}
