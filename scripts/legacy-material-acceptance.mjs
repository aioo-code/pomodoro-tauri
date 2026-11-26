import { chromium } from 'playwright-core';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import assert from 'node:assert/strict';
import path from 'node:path';
import { root, env } from './environment.mjs';

const build = JSON.parse(readFileSync(path.join(root, 'tmp/settings-build-current.json')));
const exe = path.join(build.output, 'pomodoro-connected.exe');
const evidence = path.join(build.output, 'acceptance', 'legacy-material-' + randomUUID());
mkdirSync(evidence, { recursive: true });
let child, browser, page, reminder, logs = '';
const errors = [], results = [];
const invoke = (command, args) => page.evaluate(({command, args}) => window.__TAURI__.core.invoke(command, args), {command, args});
async function wait(check, label, timeout = 12000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { if (child?.exitCode != null) throw Error('QA process exited: ' + logs); if (await check()) return; await delay(60); }
  throw Error('Timed out: ' + label);
}
function source(theme) {
  const request = {schema:'cosy.tool.request/1', id:randomUUID(), operation:'qa.system_theme', params:{theme}};
  const call = spawnSync(exe, ['--tool-qa', '--tool-request', JSON.stringify(request)], {env, encoding:'utf8', windowsHide:true, timeout:8000});
  if (call.error) throw call.error;
  const reply = JSON.parse(call.stdout.trim()); assert.equal(reply.ok, true, call.stdout);
}
async function close() {
  if (child?.exitCode === null) {
    const exited = once(child, 'exit');
    await invoke('desktop_action', {action:'quit'}).catch(() => {});
    await Promise.race([exited, delay(8000)]);
    assert.notEqual(child.exitCode, null, 'owned QA process exits normally');
  }
  await browser?.close().catch(() => {});
}
try {
  const server = createServer(); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const port = server.address().port; await new Promise(resolve => server.close(resolve));
  child = spawn(exe, ['--qa-hidden', '--qa-legacy-material', '--qa-seconds=2', '--qa-show-reminders', '--qa-preferences-file=' + path.join(evidence, 'preferences.json'), '--tool-data-dir=' + path.join(evidence, 'tool-state')], {cwd:evidence, env:{...env, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS:`--remote-debugging-port=${port} --remote-debugging-address=127.0.0.1`}, windowsHide:true, stdio:['ignore','pipe','pipe']});
  for (const stream of [child.stdout, child.stderr]) stream.on('data', data => logs += data);
  await wait(async () => { try {return (await fetch(`http://127.0.0.1:${port}/json/version`)).ok;} catch {return false;} }, 'native startup despite unsupported DWM corners', 40000);
  browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  await wait(() => {const pages = browser.contexts().flatMap(c => c.pages()); page = pages.find(p => /tauri\.localhost/.test(p.url()) && !p.url().includes('reminder')); reminder = pages.find(p => p.url().includes('reminder')); return page && reminder;}, 'both WebViews');
  for (const target of [page, reminder]) target.on('pageerror', error => errors.push(error.message));
  await page.waitForFunction(() => document.querySelector('#toggle') && !document.querySelector('#toggle').disabled && document.documentElement.dataset.material === 'solid');
  results.push('Native setup succeeds with E_INVALIDARG for all optional DWM attributes; main and reminder initialize');
  for (const theme of ['light', 'dark', 'system']) {
    if (theme === 'system') source('dark');
    await page.evaluate(theme => {localStorage.setItem('pomodoro.theme.v1', theme); window.dispatchEvent(new StorageEvent('storage', {key:'pomodoro.theme.v1', newValue:theme}));}, theme);
    await wait(async () => {
      const state = await invoke('appearance_state');
      return state.choice === theme && !state.acrylic;
    }, 'native theme ' + theme);
    for (const target of [page, reminder]) {
      await target.waitForFunction(expected => document.documentElement.dataset.theme === expected && document.documentElement.dataset.material === 'solid' && !document.documentElement.dataset.materialError, theme === 'system' ? 'dark' : theme);
    }
  }
  source('light');
  for (const target of [page, reminder]) await target.waitForFunction(() => document.documentElement.dataset.theme === 'light');
  results.push('Manual light/dark, system theme events and reminder synchronization succeed with opaque theme backgrounds');
  for (const radius of [0, 8, 32]) {
    for (const acrylic of [false, true]) {
      await invoke('set_preferences', {patch:{cornerRadius:radius, acrylic, accent:'candy-pink'}});
      const state = await invoke('appearance_state');
      assert.equal(state.acrylic, false);
      assert.equal(state.main.backdropType, 1); assert.equal(state.reminder.backdropType, 1);
      assert.equal(state.main.cornerPreference, 1);
      const values = (await invoke('get_preferences')).values;
      assert.equal(values.cornerRadius, radius); assert.equal(values.acrylic, acrylic);
    }
  }
  results.push('Corner slider, acrylic preference and accent persist without unsupported-attribute errors');
  const original = await invoke('snapshot');
  await page.locator('#toggle').evaluate(el => el.click());
  await wait(async () => (await invoke('snapshot')).status === 'running', 'timer starts');
  await invoke('desktop_action', {action:'mini'});
  await page.waitForFunction(() => document.body.classList.contains('mini'));
  assert.equal((await invoke('desktop_state')).widget.toolWindow, true);
  await page.locator('.mini-time-control').evaluate(el => el.click());
  await page.waitForFunction(() => document.querySelector('.mini-time-control').dataset.view === 'progress');
  await wait(async () => (await invoke('desktop_state')).reminderVisible, 'completion reminder');
  const finished = await invoke('snapshot');
  assert.ok(finished.revision > original.revision);
  await delay(500);
  assert.equal((await invoke('desktop_state')).reminderVisible, true, 'reminder requires manual close');
  await invoke('dismiss_reminder');
  await wait(async () => !(await invoke('desktop_state')).reminderVisible, 'manual reminder dismissal');
  await invoke('desktop_action', {action:'mini'});
  assert.equal((await invoke('desktop_state')).widget.toolWindow, false);
  assert.equal(existsSync(path.join(evidence, 'startup-error.log')), false);
  assert.deepEqual(errors, []);
  results.push('Countdown, mini progress, Alt+Tab window flags, completion reminder and manual dismissal remain functional');
  await close();
  const result = {passed:true, version:build.version, sha256:createHash('sha256').update(readFileSync(exe)).digest('hex'), results, errors, evidence, limits:['Unsupported DWM attribute responses were injected on Windows 11; Windows 10 real-device installation and startup were not exercised.']};
  writeFileSync(path.join(build.output, 'acceptance/legacy-material-result.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
} catch (error) {
  writeFileSync(path.join(evidence, 'failure.json'), JSON.stringify({error:String(error), stack:error.stack, logs, errors, results}, null, 2));
  try {await close();} catch {}
  throw error;
}
