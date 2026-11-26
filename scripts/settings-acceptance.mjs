import { chromium } from 'playwright-core';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import assert from 'node:assert/strict';
import path from 'node:path';
import { root, env } from './environment.mjs';

const build = JSON.parse(readFileSync(path.join(root, 'tmp/settings-build-current.json')));
const exe = path.join(build.output, 'pomodoro-connected.exe');
const evidence = path.join(build.output, 'acceptance', `settings-${randomUUID()}`);
mkdirSync(evidence, { recursive: true });
const preferences = path.join(evidence, 'preferences.json');
const results = [], errors = [];
let child, browser, page, reminder;
const expected = { quotesEnabled:true,quotes:['先做好眼前这一小步。','把注意力，交给此刻。','慢一点，也在向前。','让行动先于犹豫。','专注当下，日有所进。','把今天的坚持，留给明天的自己。'].map((text,index)=>({id:'gentle-'+(index+1),text})),audioMuted:false, interactionSounds:true, interactionVolume:28, reminderNoise:true, noiseTexture:'still', customNoiseId:'', noiseVolume:22, language: 'zh', direction:'down', numberAnimation:true, accent: 'tomato', customAccent:'#9a64ff', timerStyle:'comet', position: 'bottom-right', alwaysOnTop: true, reduceMotion: false, acrylic: true, icon: 'flow', cornerRadius: 20, miniOpacity: 100, dimInactive: true, snapToEdges: true, durations: [5, 10, 15, 25, 30, 45, 60].map(minutes => ({ id: `default-${minutes}`, label: `${minutes}分钟`, minutes })) };
const invoke = (command, args) => page.evaluate(({ command, args }) => window.__TAURI__.core.invoke(command, args), { command, args });
const desktop = () => invoke('desktop_state');
const settings = async () => (await invoke('get_preferences')).values;
function systemSource(theme) { const request={schema:'cosy.tool.request/1',id:randomUUID(),operation:'qa.system_theme',params:{theme}};const result=spawnSync(exe,['--tool-qa','--tool-request',JSON.stringify(request)],{encoding:'utf8',windowsHide:true,timeout:8000});if(result.error)throw result.error;const reply=JSON.parse(result.stdout.trim());assert.equal(reply.ok,true,JSON.stringify(reply));return reply.data.theme; }
async function wait(check, label, timeout = 12000) { const until = Date.now() + timeout; while (Date.now() < until) { if (await check()) return; await delay(80); } throw Error('Timed out: ' + label); }
async function click(locator) { await wait(() => locator.evaluate(el => !el.disabled), 'enabled control'); await locator.evaluate(el => el.click()); }
function mark(text) { results.push(text); console.log(text); }
async function launch() {
  const server = createServer(); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const port = server.address().port; await new Promise(resolve => server.close(resolve));
  child = spawn(exe, ['--qa-hidden', '--qa-preferences-file=' + preferences, '--tool-data-dir=' + path.join(evidence, 'tool-state')], { cwd: evidence, env: { ...env, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port} --remote-debugging-address=127.0.0.1` }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = ''; child.stderr.on('data', chunk => log += chunk); child.stdout.on('data', chunk => log += chunk);
  await wait(async () => { if (child.exitCode !== null) throw Error(log); try { return (await fetch(`http://127.0.0.1:${port}/json/version`)).ok; } catch { return false; } }, 'native launch', 40000);
  browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  await wait(() => { const pages = browser.contexts().flatMap(context => context.pages()); page = pages.find(p => /tauri\.localhost/.test(p.url()) && !p.url().includes('reminder')); reminder = pages.find(p => p.url().includes('reminder')); return page && reminder; }, 'WebViews');
  for (const target of [page, reminder]) target.on('pageerror', error => errors.push(error.message));
  await page.waitForFunction(() => document.querySelector('#toggle') && !document.querySelector('#toggle').disabled && document.documentElement.dataset.accent);
  await reminder.addInitScript(()=>{const schedule=window.setTimeout.bind(window);window.__appearanceBlockedTimers=0;window.setTimeout=(callback,ms,...args)=>{if(ms>=500){window.__appearanceBlockedTimers++;return 0;}return schedule(callback,ms,...args);};});
  await reminder.reload();
  await reminder.waitForFunction(()=>document.documentElement.dataset.preferenceEvents==='ready'&&window.__appearanceBlockedTimers>0,null,{timeout:5000});
  await delay(200);
}
async function close() {
  if (child?.exitCode === null) {
    const exited = once(child, 'exit');
    await invoke('desktop_action', { action: 'quit' }).catch(() => {});
    await Promise.race([exited, delay(8000)]);
    if (child.exitCode === null) throw Error('Owned QA process failed normal shutdown');
  }
  await browser?.close().catch(() => {}); child = browser = page = reminder = undefined;
}
async function positionMatches(position) {
  const d = await desktop(), margin = Math.round(24 * d.scale);
  const xs = { left: d.workX + margin, right: d.workX + d.workWidth - d.outerWidth - margin, center: d.workX + Math.trunc((d.workWidth - d.outerWidth) / 2) };
  const ys = { top: d.workY + margin, bottom: d.workY + d.workHeight - d.outerHeight - margin, center: d.workY + Math.trunc((d.workHeight - d.outerHeight) / 2) };
  const [vertical, horizontal] = position === 'center' ? ['center', 'center'] : position.split('-');
  return Math.abs(d.x - xs[horizontal]) <= 1 && Math.abs(d.y - ys[vertical]) <= 1;
}
try {
  await launch(); assert.deepEqual(await settings(), expected);
  assert.equal((await desktop()).pinned, true); assert.equal(await positionMatches('bottom-right'), true);
  assert.equal(await page.locator('#time').evaluate(el => getComputedStyle(el).fontWeight), '700');
  assert.ok(await page.locator('#time').evaluate(el => getComputedStyle(el).fontFamily.includes('Cos Timer Digits')));
  assert.equal(await page.evaluate(async () => (await document.fonts.load('700 68px "Cos Timer Digits"', '25:00')).some(font => font.status === 'loaded')), true);
  for (const weight of [350, 800]) assert.equal(await page.evaluate(async weight => (await document.fonts.load(`${weight} 68px "Cos Timer Digits"`, '2500')).some(font => font.status === 'loaded'), weight), true);
  assert.equal(await page.locator('.time-minutes').evaluate(el=>getComputedStyle(el).fontWeight),'700');
  assert.equal(await page.locator('.time-seconds').evaluate(el=>getComputedStyle(el).fontWeight),'350');
  assert.equal(await page.evaluate(()=>{const m=document.querySelector('.time-minutes').getBoundingClientRect(),s=document.querySelector('.time-seconds').getBoundingClientRect(),c=document.querySelector('.clock-section').getBoundingClientRect();return m.right<s.left&&m.top<s.top&&m.left-c.left>24&&c.right-s.right>24&&Math.abs((m.left+s.right)/2-(c.left+c.right)/2)<2;}),true,'compact baseline digits leave breathing room inside the ring');
  assert.equal(await page.locator('.comet-dial__ring[role="slider"]').count(),1);
  assert.equal(await page.locator('.comet-dial__lit').count(),1);
  assert.equal(await page.locator('#time').evaluate(el=>el.textContent.includes(':')),false,'main time omits the colon');
  assert.equal(await page.evaluate(()=>{const button=document.getElementById('toggle').getBoundingClientRect(),reset=document.getElementById('reset').getBoundingClientRect(),main=document.querySelector('main').getBoundingClientRect();return Math.abs(button.x+button.width/2-main.x-main.width/2)<1&&reset.left>button.right&&reset.right<=main.right;}),true,'primary action remains centered with reset to its right');
  assert.equal(await page.locator('.brand img.app-mark').count(),1);assert.equal(await page.locator('.brand img.app-mark').getAttribute('data-app-icon'),'flow');
  assert.equal(await page.locator('.brand img.app-mark').evaluate(e=>e.complete&&e.naturalWidth>0),true);
  await page.screenshot({ path: path.join(evidence, 'main-default.png'), animations: 'disabled' });
  mark('Fresh launch has a compact 700/350 baseline time composition inside a thin countdown ring, with the selected application icon');
  await click(page.locator('#toggle'));
  await wait(async () => (await invoke('snapshot')).status === 'running', 'running timer');
  const before = await invoke('snapshot');
  await click(page.locator('#settings')); await page.locator('#settings-panel').waitFor();
  assert.equal(await page.locator('#toggle').isVisible(), false);
  const geometry = await desktop();
  await wait(()=>page.locator('#app-version').textContent().then(value=>value===build.version),'actual build version in settings');
  await wait(()=>page.evaluate(()=>document.documentElement.dataset.accent==='tomato'),'fresh tomato theme');
  assert.equal(await page.evaluate(()=>getComputedStyle(document.documentElement).getPropertyValue('--primary').trim()),'#f0534f');
  assert.equal(await page.locator('#icon-tomato').count(),0,'duplicate tomato is not offered');
  await invoke('set_preferences',{patch:{icon:'tomato'}});assert.equal((await settings()).icon,'flow','legacy duplicate migrates to default tomato');
  assert.equal(await page.locator('#custom-color-toggle svg').count(),0,'custom palette has no center glyph');
  const paletteRadii=[];
  for(const cornerRadius of[0,32]){await invoke('set_preferences',{patch:{cornerRadius}});await wait(async()=>(await settings()).cornerRadius===cornerRadius,'palette corner setting');await wait(()=>page.locator('#custom-color-toggle').evaluate((e,r)=>r===0?parseFloat(getComputedStyle(e).borderTopLeftRadius)===0:parseFloat(getComputedStyle(e).borderTopLeftRadius)>0,cornerRadius),'palette corner paint');paletteRadii.push(await page.locator('#custom-color-toggle').evaluate(e=>parseFloat(getComputedStyle(e).borderTopLeftRadius)));}
  assert.equal(paletteRadii[0],0);assert.ok(paletteRadii[1]>paletteRadii[0]);await invoke('set_preferences',{patch:{cornerRadius:20}});
  const iconIds=['flow','orbit','bloom','prism','graphite'],iconEvidence=[];
  let previousIcon=await invoke('icon_state');assert.deepEqual(previousIcon.catalog,iconIds);
  for(const id of iconIds) {
    await click(page.locator('#icon-'+id));
    await wait(async()=>{const state=await invoke('icon_state');return state.choice===id&&state.main.big!=='0'&&state.main.small!=='0'&&state.reminder.big!=='0'&&state.trayUpdateAccepted;},'native icon '+id);
    const state=await invoke('icon_state');
    if(previousIcon.choice!==id){assert.notEqual(state.main.big,previousIcon.main.big,'taskbar big icon changed');assert.notEqual(state.reminder.big,previousIcon.reminder.big,'reminder icon changed');assert.notEqual(state.sourceFingerprint,previousIcon.sourceFingerprint);}
    assert.equal(await page.locator('#icon-'+id).getAttribute('aria-checked'),'true');
    const current=await desktop();assert.deepEqual([current.x,current.y,current.width,current.height,current.pinned,current.visible],[geometry.x,geometry.y,geometry.width,geometry.height,geometry.pinned,geometry.visible]);
    const clock=await invoke('snapshot');assert.equal(clock.revision,before.revision);assert.equal(clock.status,'running');
    iconEvidence.push(state);previousIcon=state;
  }
  assert.equal(new Set(iconEvidence.map(icon=>icon.sourceFingerprint)).size,5);
  writeFileSync(path.join(evidence,'native-icons.json'),JSON.stringify(iconEvidence,null,2));
  await page.screenshot({path:path.join(evidence,'icon-picker.png'),animations:'disabled'});
  await page.locator('#icon-graphite').focus();await page.keyboard.press('Home');await wait(async()=>(await settings()).icon==='flow','icon keyboard Home');
  await page.locator('#icon-flow').press('ArrowRight');await wait(async()=>(await settings()).icon==='orbit','icon keyboard arrow');
  await wait(()=>page.evaluate(()=>document.activeElement?.id==='icon-orbit'),'icon keyboard focus');
  const savedIcon=await invoke('icon_state'),savedPreferences=readFileSync(preferences);
  await assert.rejects(()=>invoke('set_preferences',{patch:{icon:'unrecognized'}}));
  assert.equal((await invoke('icon_state')).choice,savedIcon.choice);assert.deepEqual(readFileSync(preferences),savedPreferences);
  await click(page.locator('#icon-flow'));await wait(async()=>(await settings()).icon==='flow','restore default icon');
  mark('All five distinct icon styles replace native taskbar big icons and window icons; tray setter succeeds; selection/keyboard/invalid input preserve timer, geometry, focus policy and saved settings');
  const surface=target=>target.evaluate(()=>{const root=getComputedStyle(document.documentElement),shell=getComputedStyle(document.querySelector('.app-shell, .reminder-shell'));return {background:shell.backgroundColor,foreground:root.getPropertyValue('--foreground'),primary:root.getPropertyValue('--primary'),ink:root.getPropertyValue('--primary-foreground'),theme:document.documentElement.dataset.theme};});
  for (const appearance of ['浅色','深色']) {
  await click(page.getByRole('button', { name: appearance, exact: true }));
  await wait(()=>reminder.evaluate(theme=>document.documentElement.dataset.theme===theme,appearance==='浅色'?'light':'dark'),'hidden reminder theme');
  for(const enabled of[false,true]) {
    if((await settings()).acrylic!==enabled)await click(page.locator('#setting-acrylic'));
    await wait(async()=>{const state=await invoke('appearance_state');return state.acrylic===enabled&&state.main.acrylic===enabled&&state.reminder.acrylic===enabled;},'native acrylic switch '+enabled);
    await wait(()=>page.evaluate(enabled=>document.documentElement.dataset.material===(enabled?'acrylic':'solid')&&document.documentElement.dataset.acrylic===String(enabled),enabled),'surface mode '+enabled);
    await wait(async()=>JSON.stringify(await surface(page))===JSON.stringify(await surface(reminder)),'material sync');
    const pixels=await page.evaluate(()=>{const canvas=document.createElement('canvas');canvas.width=canvas.height=1;const context=canvas.getContext('2d');context.fillStyle=getComputedStyle(document.querySelector('.app-shell')).backgroundColor;context.fillRect(0,0,1,1);return [...context.getImageData(0,0,1,1).data];});
    const expectedAlpha=enabled?Math.round((appearance==='深色'?.18:.28)*255):255;
    assert.ok(Math.abs(pixels[3]-expectedAlpha)<=1,'glass has the thin theme tint; solid is opaque: '+pixels);
    assert.ok(appearance==='深色'?Math.max(...pixels.slice(0,3))<55:Math.min(...pixels.slice(0,3))>235,'surface tint retains theme luminance: '+pixels);
  }
  for (const [accent, label] of [['tomato', '番茄红'], ['blue', '湖蓝'], ['teal', '青碧'], ['green', '松绿'], ['violet', '鸢紫'], ['rose', '蔷薇'], ['amber', '琥珀'], ['candy-pink', '糖果粉'], ['candy-purple', '电光紫'], ['candy-blue', '泡泡蓝'], ['candy-orange', '蜜橙'], ['candy-lime', '青柠'], ['black', '墨黑'], ['white', '月白']]) {
    if(['tomato','blue','candy-lime','black','white'].includes(accent))await click(page.getByRole('button',{name:label,exact:true}));else await invoke('set_preferences',{patch:{accent}});
    await wait(async () => (await settings()).accent === accent, 'saved accent');
    await wait(() => page.evaluate(accent => document.documentElement.dataset.accent === accent, accent), 'main accent');
    await wait(() => reminder.evaluate(accent => document.documentElement.dataset.accent === accent, accent), 'reminder accent');
    await wait(async()=>JSON.stringify(await surface(page))===JSON.stringify(await surface(reminder)),'shared main/reminder colors '+appearance+' '+label);
    const after = await desktop(); assert.equal(after.x, geometry.x); assert.equal(after.y, geometry.y);
    const colors = await page.evaluate(() => { const style = getComputedStyle(document.documentElement); return [style.getPropertyValue('--primary').trim(), style.getPropertyValue('--primary-foreground').trim()]; });
    const luminance = hex => { const c = hex.match(/[a-f\d]{2}/gi).map(v => parseInt(v,16)/255).map(v => v <= .04045 ? v/12.92 : ((v+.055)/1.055)**2.4); return c[0]*.2126+c[1]*.7152+c[2]*.0722; };
    const [a,b] = colors.map(luminance); assert.ok((Math.max(a,b)+.05)/(Math.min(a,b)+.05)>=4.5, 'button contrast '+label);
  }
  }
  const running = await invoke('snapshot'); assert.equal(running.status, 'running'); assert.equal(running.revision, before.revision); assert.ok(running.remainingMs < before.remainingMs);
  mark('All thirteen accents in both themes keep identical main/reminder surface, text and accent colors while hidden reminder polling is blocked; timer preserved and primary button contrast passes');
  await click(page.getByRole('button', { name: '浅色', exact: true }));
  await wait(() => page.evaluate(() => document.documentElement.dataset.theme === 'light'), 'light theme');
  const light = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--background'));
  await click(page.getByRole('button', { name: '深色', exact: true }));
  await wait(() => page.evaluate(() => document.documentElement.dataset.theme === 'dark'), 'dark theme');
  assert.notEqual(await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--background')), light);
  await click(page.getByRole('button', { name: '跟随系统', exact: true }));
  const hostTheme=await invoke('system_theme');
  systemSource('dark');await wait(()=>page.evaluate(()=>document.documentElement.dataset.theme==='dark'),'native system dark');
  await page.emulateMedia({colorScheme:'light'});await delay(350);assert.equal(await page.evaluate(()=>document.documentElement.dataset.theme),'dark','forced WebView light scheme cannot override native system dark');
  systemSource('light');await wait(()=>page.evaluate(()=>document.documentElement.dataset.theme==='light'),'live native system light');
  await wait(()=>reminder.evaluate(()=>document.documentElement.dataset.theme==='light'),'hidden reminder native system light');
  assert.equal((await invoke('appearance_state')).choice,'system');
  assert.equal(await page.getByRole('button',{name:'跟随系统',exact:true}).getAttribute('aria-pressed'),'true');
  await click(page.getByRole('button',{name:'深色',exact:true}));systemSource('dark');await delay(1100);systemSource('light');await delay(1100);
  assert.equal(await page.evaluate(()=>document.documentElement.dataset.theme),'dark','manual dark remains pinned across system changes');
  systemSource('system');await page.emulateMedia({colorScheme:null});await click(page.getByRole('button',{name:'跟随系统',exact:true}));
  await wait(()=>page.evaluate(theme=>document.documentElement.dataset.theme===theme,hostTheme),'restored actual host system theme');
  mark('Native system source changes update both windows live; opposite WebView media cannot lock system mode; manual appearance remains explicit; host settings untouched');
  for (const [position, label] of [['top-left', '左上角'], ['top-right', '右上角'], ['center', '屏幕居中'], ['bottom-left', '左下角'], ['bottom-right', '右下角']]) {
    await click(page.getByRole('button', { name: label, exact: true }));
    await wait(() => positionMatches(position), label);
  }
  mark('Theme/system preference and all five native work-area placements apply immediately');
  await page.locator('#setting-radius').press('Home');
  await wait(async () => (await settings()).cornerRadius === 0, 'square corners');
  assert.equal((await invoke('appearance_state')).main.cornerPreference,1);
  assert.equal(await page.locator('#toggle').evaluate(el => getComputedStyle(el).borderRadius),'0px');
  await click(page.getByRole('button', { name: '深色', exact: true }));
  await wait(() => page.evaluate(() => document.documentElement.dataset.theme === 'dark'), 'square theme switch');
  assert.equal((await invoke('appearance_state')).main.cornerPreference,1);
  await page.locator('#setting-radius').press('End');
  await wait(async () => (await settings()).cornerRadius === 32, 'soft corners');
  assert.equal((await invoke('appearance_state')).main.cornerPreference,2);
  await page.locator('#duration-name').fill('阅读'); await page.locator('#duration-minutes').fill('20');
  await click(page.locator('#duration-save')); await wait(async () => (await settings()).durations.some(p=>p.label==='阅读'&&p.minutes===20),'added duration');
  await page.locator('#duration-minutes').fill('25'); await click(page.locator('#duration-save'));
  await page.locator('#duration-error').waitFor(); assert.equal((await settings()).durations.length,8);
  await click(page.getByRole('button',{name:'编辑阅读',exact:true}));
  await page.locator('#duration-name').fill('短阅读'); await page.locator('#duration-minutes').fill('17');
  await click(page.locator('#duration-save')); await wait(async () => (await settings()).durations.some(p=>p.label==='短阅读'&&p.minutes===17),'edited duration');
  await click(page.getByRole('button',{name:'上移短阅读',exact:true}));
  await wait(async () => (await settings()).durations[6].minutes===17,'reordered duration');
  const managed = await invoke('snapshot'); assert.equal(managed.revision,before.revision); assert.equal(managed.status,'running');
  await page.screenshot({path:path.join(evidence,'duration-manager.png'),animations:'disabled'});
  await click(page.locator('#settings-back')); await click(page.locator('[data-minutes="17"]'));
  assert.equal((await invoke('snapshot')).durationMs,1_020_000);
  await click(page.locator('#toggle')); await wait(async () => (await invoke('snapshot')).status==='running','custom timer');
  await click(page.locator('#settings')); const active = await invoke('snapshot');
  await click(page.getByRole('button',{name:'删除短阅读',exact:true})); await wait(async () => !(await settings()).durations.some(p=>p.minutes===17),'removed duration');
  const stillActive=await invoke('snapshot'); assert.equal(stillActive.revision,active.revision); assert.equal(stillActive.status,'running'); assert.equal(stillActive.durationMs,active.durationMs);
  await page.locator('#duration-name').fill('长时段'); await page.locator('#duration-minutes').fill('1440'); await click(page.locator('#duration-save'));
  await wait(async () => (await settings()).durations.some(p=>p.minutes===1440),'long duration');
  await click(page.getByRole('button', { name: '浅色', exact: true }));
  await click(page.locator('#settings-back')); await click(page.locator('[data-minutes="1440"]'));
  assert.equal((await invoke('snapshot')).durationMs,86_400_000);
  await page.waitForFunction(()=>document.getElementById('time')?.dataset.time==='1440:00');
  await delay(350);
  assert.equal(await page.locator('.time-minutes').evaluate(el=>{const r=el.getBoundingClientRect(),s=el.closest('.clock-section').getBoundingClientRect();return r.left>=s.left&&r.right<=s.right;}),true,'four-digit minutes fit the main clock');
  await page.screenshot({path:path.join(evidence,'main-long-time.png'),animations:'disabled'});
  await invoke('set_preferences',{patch:{accent:'candy-lime'}});await wait(()=>page.evaluate(()=>document.documentElement.dataset.accent==='candy-lime'),'lime mini contrast setup');
  await click(page.locator('#mini')); await page.waitForFunction(()=>document.body.classList.contains('mini'));
  assert.equal(await page.locator('.brand').count(),0); assert.equal(await page.locator('#reset').count(),0);
  await wait(() => page.evaluate(() => document.documentElement.dataset.theme === 'light'), 'mini light theme');
  assert.equal(await page.locator('#toggle').evaluate(el => getComputedStyle(el).color), 'rgb(35, 50, 13)', 'bright lime uses a readable dark mini icon');
  assert.equal(await page.evaluate(()=>{const t=document.querySelector('#time').getBoundingClientRect(),b=document.querySelector('#toggle').getBoundingClientRect(),r=document.querySelector('#mini').getBoundingClientRect();return t.left>=0&&t.right+10<=b.left&&b.right<=r.left&&r.right<=innerWidth&&document.documentElement.scrollHeight<=innerHeight;}),true);
  await page.screenshot({path:path.join(evidence,'mini-long-time.png'),animations:'disabled'});
  await click(page.locator('#mini')); await page.waitForFunction(()=>!document.body.classList.contains('mini'));
  await click(page.locator('#settings')); await click(page.getByRole('button',{name:'删除长时段',exact:true}));
  await wait(async () => (await settings()).durations.length===7,'restored duration list');
  mark('0–32 corner control includes square native corners; duration add/edit/reorder/delete, duplicates and 24-hour timer pass without disrupting the active session; minimal mini layout fits');
  await click(page.getByRole('button', { name: '跟随系统', exact: true }));
  await click(page.locator('#setting-pin')); await wait(async () => !(await desktop()).pinned, 'unpin');
  await click(page.locator('#setting-motion')); await wait(() => page.locator('.app-shell').getAttribute('data-reduced-motion').then(v => v === 'true'), 'reduced motion');
  await click(page.locator('#setting-acrylic'));await wait(async()=>!(await settings()).acrylic,'persist solid material');
  await click(page.locator('#icon-prism'));await wait(async()=>(await settings()).icon==='prism','persist selected icon');
  await click(page.getByRole('button', { name: '墨黑', exact: true }));
  await click(page.getByRole('button', { name: '左上角', exact: true }));
  await wait(async () => (await settings()).position === 'top-left', 'saved startup position');
  await page.screenshot({ path: path.join(evidence, 'settings.png'), animations: 'disabled' });
  await close(); await launch();
  const persisted = await settings();
  assert.deepEqual(persisted, { ...expected, accent: 'black', position: 'top-left', alwaysOnTop: false, reduceMotion: true, acrylic: false, icon:'prism', cornerRadius: 32 });
  assert.equal((await invoke('icon_state')).choice,'prism','native icon restored during real process launch');
  await wait(async()=>!(await invoke('appearance_state')).acrylic,'solid survives process restart');
  assert.equal(await positionMatches('top-left'), true); assert.equal((await desktop()).pinned, false);
  assert.equal(await page.evaluate(() => localStorage.getItem('pomodoro.theme.v1')), 'system');
  mark('Accent, startup position, pin, motion and record visibility survive a real process restart');
  await click(page.locator('#settings')); await click(page.locator('#settings-reset'));
  await wait(async () => { try { assert.deepEqual(await settings(), expected); return true; } catch { return false; } }, 'reset defaults');
  assert.equal((await invoke('icon_state')).choice,'flow','reset defaults restores native icon');
  assert.equal((await desktop()).pinned, true); assert.equal(await positionMatches('bottom-right'), true);
  await page.keyboard.press('Escape'); await page.locator('#settings-panel').waitFor({ state: 'hidden' });
  await wait(() => page.evaluate(() => document.activeElement?.id === 'settings'), 'focus restored to settings button');
  await click(page.locator('#pin')); await wait(async () => !(await settings()).alwaysOnTop, 'title-bar pin persistence');
  await close(); await launch(); assert.equal((await desktop()).pinned, false);
  await invoke('set_preferences', { patch: expected });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await wait(() => page.locator('.app-shell').getAttribute('data-reduced-motion').then(v => v === 'true'), 'OS reduced motion');
  await page.setViewportSize({ width: 360, height: 480 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth && document.documentElement.scrollHeight <= innerHeight), true);
  await click(page.locator('#settings'));
  assert.equal(await page.evaluate(() => document.documentElement.scrollHeight <= innerHeight), true);
  await page.locator('#settings-reset').scrollIntoViewIfNeeded(); assert.equal(await page.locator('#settings-reset').isVisible(), true);
  await page.screenshot({ path: path.join(evidence, 'settings-narrow.png'), animations: 'disabled' });
  assert.deepEqual(errors, []); mark('Restore defaults, title-bar persistence, keyboard return, OS motion preference and narrow layout pass');
  await close();
  const result = { passed: true, sha256: createHash('sha256').update(readFileSync(exe)).digest('hex'), version: build.version, results, errors, evidence };
  writeFileSync(path.join(build.output, 'acceptance/settings-result.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
} catch (error) {
  writeFileSync(path.join(evidence, 'failure.json'), JSON.stringify({ error: String(error), stack: error.stack, results, errors }, null, 2));
  try { await close(); } catch { /* Retain unknown state rather than touching other processes. */ }
  throw error;
}
