import { chromium } from 'playwright-core';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { createServer } from 'node:net';
import path from 'node:path';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { root, env } from './environment.mjs';

const executableName = 'pomodoro-connected';
const exe = process.env.POMODORO_EXE ?? path.join(root, `src-tauri/target/release/${executableName}.exe`);
const evidence = process.env.POMODORO_EVIDENCE ?? path.join(root, 'artifacts/desktop-acceptance');
mkdirSync(evidence, { recursive: true });
const toolDataDirectory = path.join(evidence, 'ui-tool-state');
const preferencesFile = path.join(evidence, 'ui-preferences.json');
mkdirSync(toolDataDirectory, { recursive: true });
const existing = spawnSync('powershell', ['-NoProfile', '-Command', `Get-Process ${executableName} -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq '${exe.replaceAll("'", "''")}' } | Select-Object -ExpandProperty Id`], { env, encoding: 'utf8', windowsHide: true });
if (existing.stdout.trim()) throw new Error('An app process is running; leave it intact and close it before acceptance.');
const sha256 = createHash('sha256').update(readFileSync(exe)).digest('hex');
const checkpoint = path.join(evidence, 'defaults-checkpoint.json');
const shortOnly = process.argv.includes('--short-only');
const captureOnly = process.argv.includes('--capture-only');
const noNativeCapture = process.argv.includes('--no-native-capture');
let results = [];
if (shortOnly || captureOnly) {
  const saved = JSON.parse(readFileSync(checkpoint, 'utf8'));
  assert.equal(saved.sha256, sha256, 'Default checks must match this EXE.');
  results = saved.results;
}
let browser, child, page, reminderPage;
const errors = [];
const invokeOn = (target, command, args) => target.evaluate(({ command, args }) => window.__TAURI__.core.invoke(command, args), { command, args });
const invoke = (command, args) => invokeOn(page, command, args);
const snapshot = () => invoke('snapshot');
const desktop = () => invoke('desktop_state');
async function waitFor(check, label, timeout = 8000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { if (await check()) return; await delay(80); }
  throw new Error(`Timed out: ${label}`);
}
async function click(selector, target = page) {
  await waitFor(() => target.locator(selector).evaluate(el => !el.disabled), selector);
  await target.locator(selector).evaluate(el => {
    if (el.getAttribute('role') === 'tab') el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }));
    el.click();
  });
}
async function status(value) { await waitFor(async () => (await snapshot()).status === value, value); }
async function uiStatus(value) { await waitFor(async () => (await page.locator('#status').textContent()) === value, value); }
function foregroundPid() {
  const command = "Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public class PomodoroForeground { [DllImport(\"user32.dll\")] public static extern IntPtr GetForegroundWindow(); [DllImport(\"user32.dll\")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint id); }'; [uint32]$taskPid = 0; [void][PomodoroForeground]::GetWindowThreadProcessId([PomodoroForeground]::GetForegroundWindow(), [ref]$taskPid); $taskPid";
  const result = spawnSync('powershell', ['-NoProfile', '-Command', command], { env, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(result.stderr);
  return Number(result.stdout.trim());
}
async function launch(seconds) {
  const server = createServer(); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  child = spawn(exe, ['--qa-hidden', `--tool-data-dir=${toolDataDirectory}`, `--qa-preferences-file=${preferencesFile}`, ...(seconds ? [`--qa-seconds=${seconds}`, '--qa-show-reminders'] : [])], {
    cwd: root, env: { ...env, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port} --remote-debugging-address=127.0.0.1` }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe']
  });
  let logs = ''; child.stderr.on('data', data => { logs += data; });
  child.on('error', error => { logs += error.message; });
  await waitFor(async () => {
    if (child.exitCode !== null) throw new Error(`App exited early: ${logs}`);
    try { return (await fetch(`http://127.0.0.1:${port}/json/version`)).ok; } catch { return false; }
  }, 'WebView2 debugger', 45000);
  browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  await waitFor(() => {
    const pages = browser.contexts().flatMap(c => c.pages());
    page = pages.find(p => /tauri\.localhost/.test(p.url()) && !p.url().includes('reminder.html'));
    reminderPage = pages.find(p => p.url().includes('reminder.html'));
    return page && reminderPage;
  }, 'two native WebView pages');
  for (const target of [page, reminderPage]) target.on('pageerror', error => errors.push(error.message));
  await page.waitForFunction(() => window.__TAURI__ && document.getElementById('toggle') && !document.getElementById('toggle').disabled);
  await reminderPage.waitForFunction(() => window.__TAURI__);
  await reminderPage.evaluate(()=>{
    window.__qaDismissTrace=[];
    const api=window.__TAURI__,native=api.core.invoke;
    window.__TAURI__={...api,core:{...api.core,invoke:(command,args,...rest)=>{if(command==='dismiss_reminder')window.__qaDismissTrace.push({kind:'dismiss-call',at:performance.now(),stack:new Error().stack});return native(command,args,...rest);}}};
    document.addEventListener('keydown',event=>window.__qaDismissTrace.push({kind:'key',key:event.key,trusted:event.isTrusted,at:performance.now()}),true);
    document.addEventListener('click', event => {
      const id = event.target.closest?.('button')?.id;
      window.__qaDismissTrace.push({kind:'click',id,trusted:event.isTrusted,at:performance.now()});
      // This fixture dismisses through element.click(). A desktop click can
      // otherwise close its visible reminder during the retention check.
      if (event.isTrusted && ['dismiss', 'close-reminder'].includes(id)) {
        event.preventDefault();
        event.stopImmediatePropagation();
      }
    }, true);
  });
}
async function close() {
  if (!child) return;
  const owned = child;
  const exited = once(owned, 'exit');
  if (owned.exitCode === null && page) {
    await invoke('desktop_action', { action: 'quit' }).catch(() => {});
    await Promise.race([exited, delay(6000)]);
  }
  if (browser) await browser.close().catch(() => {});
  if (owned.exitCode === null) { owned.kill(); await Promise.race([exited, delay(3000)]); throw new Error('Normal exit failed; terminated only the owned acceptance process.'); }
  browser = child = page = reminderPage = undefined;
}
async function screenshot(name, target = page) {
  await waitFor(async () => (await target.locator('canvas:not(.star-border__light):not(.orb-canvas)').count()) === 0, 'transient effect settled');
  if (target === page) await waitFor(() => target.locator('#toggle').evaluate(el => !el.disabled), 'UI action settled');
  await target.locator('[role="menu"]').waitFor({ state: 'hidden' });
  await target.screenshot({ path: path.join(evidence, `${name}.png`) });
}
async function theme(value) {
  assert.ok(['light', 'dark'].includes(value));
  await waitFor(() => page.evaluate(() => ['light', 'dark'].includes(document.documentElement.dataset.theme)), 'initial theme');
  if (await page.evaluate(() => document.documentElement.dataset.theme) !== value) await click('#theme');
  await waitFor(() => page.evaluate(value => document.documentElement.dataset.theme === value, value), 'theme selection');
  await waitFor(() => reminderPage.evaluate(value => document.documentElement.dataset.theme === value, value), 'reminder theme sync');
  await waitFor(async () => {
    const material = await invoke('appearance_state');
    return material.acrylic && material.theme === value && material.main.darkMode === (value === 'dark') && material.reminder.darkMode === (value === 'dark');
  }, 'native acrylic theme');
  await waitFor(() => page.evaluate(() => document.documentElement.dataset.material === 'acrylic'), 'transparent material ready');
  assert.equal(await page.locator('#theme').count(), 1);
  assert.equal(await page.getByRole('menuitemradio').count(), 0);
  assert.equal(await page.locator('#theme').getAttribute('aria-label'), value === 'dark' ? '切换为浅色' : '切换为深色');
  // Hidden WebViews can suspend CSS transitions. Capture their final frame before
  // sampling colors instead of mistaking the first transition frame for a theme failure.
  await page.screenshot({ animations: 'disabled' });
}
async function appearance() {
  return page.evaluate(() => {
    const shell = getComputedStyle(document.querySelector('.app-shell'));
    const root = getComputedStyle(document.documentElement);
    return { windowTint: root.getPropertyValue('--window-tint').trim(), body: getComputedStyle(document.body).backgroundColor,
      surface: shell.backgroundColor, text: getComputedStyle(document.getElementById('time')).color,
      button: getComputedStyle(document.getElementById('toggle')).backgroundColor,
      ring: getComputedStyle(document.querySelector('.comet-dial__track')).stroke,
      selection: getComputedStyle(document.getElementById('time')).userSelect };
  });
}
async function captureNative(value, prefix = 'native-glass') {
  await theme(value);
  const geometry = await desktop();
  const captured = spawnSync('powershell', ['-NoProfile', '-File', path.join(root, 'scripts/capture-glass.ps1'), '-OwnedProcessId', String(child.pid), '-ExpectedWidth', String(geometry.outerWidth), '-ExpectedHeight', String(geometry.outerHeight), '-OutputPath', path.join(evidence, `${prefix}-${value}.png`)], { env, encoding: 'utf8' });
  if (captured.status !== 0) throw new Error(`Native glass capture failed: ${captured.stderr}`);
  assert.equal(JSON.parse(captured.stdout.trim()).activated, false);
}

try {
  if (captureOnly) {
    await launch();
    for (const value of ['light', 'dark']) await captureNative(value);
    await close();
    writeFileSync(path.join(evidence, 'native-capture.json'), JSON.stringify({ at: new Date().toISOString(), sha256, result: 'passed', method: 'Exact owned PID, verified title and outer dimensions, physical DPI coordinates, DWM visible frame bounds only, no activation' }, null, 2));
    console.log('Captured both native themes inside the verified visible DWM frame.');
  } else {
  if (!shortOnly) {
    await launch();
    await delay(700);
    assert.equal(await page.locator('#error').count(), 0, 'startup has no window error');
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await theme('light');
    const lightAppearance = await appearance();
    assert.equal(lightAppearance.body, 'rgba(0, 0, 0, 0)');
    assert.equal(lightAppearance.selection, 'none');
    assert.equal(await page.evaluate(() => document.dispatchEvent(new Event('selectstart', { bubbles: true, cancelable: true }))), false);
    assert.equal((await snapshot()).remainingMs, 1_500_000);
    assert.equal((await desktop()).decorated, false);
    assert.equal((await desktop()).trayAvailable, true);
    await click('#break'); assert.equal((await snapshot()).remainingMs, 300_000);
    await click('#focus');
    for (const minutes of [5, 10, 15, 25, 30, 45, 60]) {
      await click(`[data-minutes="${minutes}"]`);
      assert.equal((await snapshot()).remainingMs, minutes * 60_000);
      await waitFor(() => page.locator(`[data-minutes="${minutes}"]`).getAttribute('aria-pressed').then(v => v === 'true'), 'selected preset');
    }
    await click('#break'); await click('[data-minutes="10"]');
    await click('#focus'); assert.equal((await snapshot()).selectedMinutes, 60);
    await click('[data-minutes="25"]');
    await click('#break'); assert.equal((await snapshot()).selectedMinutes, 10);
    await click('[data-minutes="5"]'); await click('#focus');
    await screenshot('desktop-ready');
    assert.equal(await page.evaluate(() => document.documentElement.scrollHeight <= innerHeight && document.documentElement.scrollWidth <= innerWidth), true, 'primary effect canvas must not create document scrollbars');
    assert.equal(await page.locator('button#toggle.focus-primary').count(),1);
    assert.equal(await page.locator('.fuse-button').count(),0);
    assert.equal(await page.locator('.rubber-segment').count(),1);
    assert.equal(await page.locator('.jelly-radio').count(),1);
    assert.equal(await page.locator('.comet-dial').count(),1);
    results.push('Comet Dial, bordered primary button, Jelly Radio and Rubber Segment are present as semantic native-timer controls.');
    const panelLabel=await page.locator('.timer-panel').getAttribute('aria-labelledby');
    assert.equal(await page.locator('#'+panelLabel).count(),1);
    results.push('Redesigned frameless React/shadcn UI with native Acrylic; single title-bar theme button, no theme dropdown; selection disabled; tray, all presets, separate progress.');
    await click('#toggle'); await status('running'); await delay(500);
    await click('#focus'); assert.equal((await snapshot()).status, 'running');
    await click('[data-minutes="25"]'); assert.equal((await snapshot()).status, 'running');
    const beforeSwitch = (await snapshot()).remainingMs;
    await click('#break'); await waitFor(async () => (await snapshot()).mode === 'break', 'switch to break');
    await delay(400);
    await click('#focus'); await waitFor(async () => (await snapshot()).mode === 'focus', 'switch back');
    assert.equal((await snapshot()).status, 'paused');
    const saved = (await snapshot()).remainingMs;
    assert.ok(saved <= beforeSwitch && saved > beforeSwitch - 500);
    await delay(300); assert.equal((await snapshot()).remainingMs, saved);
    await click('#toggle'); await status('running');
    await click('#toggle'); await status('paused'); await uiStatus('已暂停');
    const paused = (await snapshot()).remainingMs; await delay(600);
    assert.equal((await snapshot()).remainingMs, paused);
    await click('#toggle'); await status('running'); await delay(250);
    assert.ok((await snapshot()).remainingMs < paused);
    await click('[data-minutes="15"]'); await status('ready');
    assert.equal((await snapshot()).remainingMs, 900_000);
    await click('[data-minutes="25"]');
    results.push('Regression: same tab/preset do not reset; switching tabs pauses and preserves exact independent progress; returning remains paused.');
    assert.equal((await desktop()).pinned, true, 'main window is pinned by default');
    await click('#pin'); await waitFor(async () => !(await desktop()).pinned, 'default pin off');
    await click('#pin'); await waitFor(async () => (await desktop()).pinned, 'pin on');
    await click('#pin'); await waitFor(async () => !(await desktop()).pinned, 'pin off');
    await click('#toggle'); await status('running');
    await click('#mini'); await waitFor(async () => (await desktop()).mini, 'mini on');
    await waitFor(() => page.locator('body').evaluate(el => el.classList.contains('mini')), 'compact layout');
    const mini = await desktop();
    writeFileSync(path.join(evidence, 'mini-state.json'), JSON.stringify(mini, null, 2));
    assert.ok(Math.abs(mini.width - 280) < 2 && Math.abs(mini.height - 80) < 2);
    assert.equal(mini.pinned, true);
    assert.equal(mini.widget.toolWindow,true);assert.equal(mini.widget.appWindow,false);
    assert.ok(Math.abs(mini.workX + mini.workWidth - mini.widget.frame.x - mini.widget.frame.width - Math.round(12*mini.scale)) <= 1, 'floating visible frame has right margin');
    assert.ok(Math.abs(mini.workY + mini.workHeight - mini.widget.frame.y - mini.widget.frame.height - Math.round(12*mini.scale)) <= 1, 'floating visible frame has bottom margin');
    assert.equal(await page.locator('.clock-section').getAttribute('data-drag-handle'), 'true');
    assert.equal(await page.locator('.titlebar').count(), 0);
    assert.equal(await page.locator('button:visible').count(), 3, 'mini contains time toggle, play/pause and return only');
    assert.equal((await snapshot()).status, 'running');
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth && document.documentElement.scrollHeight <= innerHeight), true);
    await screenshot('desktop-mini');
    await click('#mini'); await waitFor(async () => !(await desktop()).mini, 'restore full');
    assert.equal((await desktop()).pinned, false);
    assert.equal((await desktop()).widget.toolWindow,false);
    assert.ok(Math.abs((await desktop()).width - 400) < 2);
    assert.equal((await snapshot()).status, 'running');
    await page.evaluate(() => window.__TAURI__.window.getCurrentWindow().close());
    assert.equal((await desktop()).visible, false);
    assert.equal((await snapshot()).status, 'running');
    await click('#reset'); await status('ready');
    results.push('Pause/resume, new duration resets only active phase; native pin on/off; compact 280x80 floating mode has no toolbar, only time toggle, play/pause and return; pinned flush at bottom-right with drag handles; full mode restores size/pin; native close hides without ending timer.');
    const duplicate = spawn(exe, ['--qa-hidden', `--tool-data-dir=${toolDataDirectory}`], { cwd: root, env, windowsHide: true, stdio: 'ignore' });
    const duplicateExit = await Promise.race([once(duplicate, 'exit'), delay(6000).then(() => null)]);
    if (!duplicateExit) { duplicate.kill(); throw new Error('Second QA instance did not exit.'); }
    assert.equal(duplicateExit[0], 0);
    assert.equal((await snapshot()).status, 'ready');
    results.push('QA single-instance guard retains original state; normal user instance is isolated.');
    await theme('dark');
    const darkAppearance = await appearance();
    assert.notEqual(darkAppearance.windowTint, lightAppearance.windowTint, 'whole-window glass tint changes');
    assert.notEqual(darkAppearance.text, lightAppearance.text, 'primary text changes');
    assert.equal(lightAppearance.button, 'rgb(240, 83, 79)', 'light theme uses default tomato logo red');
    assert.equal(darkAppearance.button, lightAppearance.button, 'tomato brand color stays consistent across light and dark themes');
    assert.notEqual(darkAppearance.ring, lightAppearance.ring, 'clock surface changes');
    const nativeAppearance = await invoke('appearance_state');
    assert.equal(nativeAppearance.main.acrylic, true);
    assert.equal(nativeAppearance.reminder.acrylic, true);
    assert.equal(nativeAppearance.main.cornerPreference, 2);
    writeFileSync(path.join(evidence, 'appearance.json'), JSON.stringify({ light: lightAppearance, dark: darkAppearance, native: nativeAppearance }, null, 2));
    assert.equal(await page.evaluate(() => document.documentElement.classList.contains('dark')), true);
    await screenshot('desktop-dark');
    if (!noNativeCapture) { await captureNative('light'); await captureNative('dark'); }
    await page.reload();
    await page.waitForFunction(() => document.getElementById('toggle') && !document.getElementById('toggle').disabled);
    assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), 'dark');
    await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'reduce' });
    assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), 'dark', 'explicit theme retained on system scheme change');
    await theme('light');
    await waitFor(() => page.locator('.app-shell').getAttribute('data-reduced-motion').then(v => v === 'true'), 'live reduced-motion preference');
    await click('#toggle'); await status('running');
    assert.equal(await page.locator('#time').getAttribute('data-numbers-animated'),'false','reduced motion suppresses rolling digits');
    await click('#reset'); await status('ready');
    results.push('Single-click light/dark changes actual glass tint, body text and dial surface while preserving tomato brand color; transparent WebView over native Acrylic; effective material, native dark-mode and rounded corners read back; persisted/synced to reminder. Reduced motion suppresses rolling digits.');
    await page.setViewportSize({ width: 360, height: 480 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await screenshot('desktop-narrow');
    await close();
    writeFileSync(checkpoint, JSON.stringify({ sha256, results }, null, 2));
  }
  await launch(2);
  await theme('dark');
  await invoke('set_preferences',{patch:{accent:'candy-lime'}});
  const initialForeground = foregroundPid();
  assert.notEqual(initialForeground, child.pid);
  await click('#toggle'); await status('running');
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Page.setWebLifecycleState', { state: 'frozen' });
  await delay(2500);
  await cdp.send('Page.setWebLifecycleState', { state: 'active' });
  await status('completed'); await uiStatus('本段已完成');
  await waitFor(async () => { const d = await desktop(); return d.reminder.pending && d.reminderVisible; }, 'visible native reminder');
  assert.notEqual(foregroundPid(), child.pid, 'Reminder must not activate this app.');
  const centered = await desktop();
  assert.ok(Math.abs(centered.reminderX + centered.reminderWidth / 2 - centered.workX - centered.workWidth / 2) <= 1);
  assert.ok(Math.abs(centered.reminderY + centered.reminderHeight / 2 - centered.workY - centered.workHeight / 2) <= 1);
  await waitFor(() => reminderPage.locator('#reminder-title').textContent().then(v => v === '专注完成'), 'focus reminder text');
  const sharedColors=target=>target.evaluate(()=>{const root=getComputedStyle(document.documentElement);return {theme:document.documentElement.dataset.theme,accent:document.documentElement.dataset.accent,surface:getComputedStyle(document.querySelector('.app-shell, .reminder-shell')).backgroundColor,primary:root.getPropertyValue('--primary'),foreground:root.getPropertyValue('--foreground')};});
  await waitFor(async()=>JSON.stringify(await sharedColors(page))===JSON.stringify(await sharedColors(reminderPage)),'completed reminder matches main appearance');
  const retention = [{ stage: 'before-capture', desktop: await desktop() }];
  await screenshot('reminder-focus', reminderPage);
  retention.push({ stage: 'after-reminder-capture', desktop: await desktop() });
  await screenshot('desktop-completed');
  await delay(700);
  retention.push({ stage: 'after-main-capture', desktop: await desktop() });
  writeFileSync(path.join(evidence, 'reminder-retention.json'), JSON.stringify(retention, null, 2));
  writeFileSync(path.join(evidence,'reminder-dismiss-trace.json'),JSON.stringify(await reminderPage.evaluate(()=>window.__qaDismissTrace),null,2));
  assert.equal(retention.at(-1).desktop.reminderVisible, true, JSON.stringify(retention.at(-1).desktop));
  assert.equal((await snapshot()).status, 'completed');
  await click('#reset'); await status('ready'); await click('#break');
  assert.equal((await desktop()).reminder.pending, true);
  assert.equal((await desktop()).reminder.mode, 'focus');
  await click('#dismiss', reminderPage);
  await waitFor(async () => { const d = await desktop(); return !d.reminder.pending && !d.reminderVisible; }, 'manual dismissal');
  results.push('Focus expires with main page frozen; real non-activating reminder is visible and centered in monitor work area, persists through time/reset/mode change, closes only by explicit button.');
  await click('#toggle'); await status('running'); await status('completed');
  await waitFor(async () => (await desktop()).reminderVisible, 'break reminder visible');
  await waitFor(() => reminderPage.locator('#reminder-title').textContent().then(v => v === '休息结束'), 'break reminder text');
  await screenshot('reminder-break', reminderPage);
  await click('#close-reminder', reminderPage);
  await waitFor(async () => !(await desktop()).reminderVisible, 'X dismissal');
  assert.equal((await snapshot()).status, 'completed');
  await uiStatus('本段已完成');
  await click('#toggle'); await status('running'); await click('#reset'); await status('ready');
  results.push('Break reminder, title-bar X dismissal, completed state retained after dismissal, explicit restart and reset.');
  assert.doesNotMatch(readFileSync(path.join(root, 'src-tauri/src/main.rs'), 'utf8'), /MessageBeep|PlaySound|Beep\(/);
  assert.equal(await reminderPage.evaluate(() => document.documentElement.classList.contains('dark')), true);
  assert.deepEqual(errors, []);
  if (!noNativeCapture) {
    for (const value of ['light', 'dark']) await captureNative(value, 'native-glass-warm');
    results.push('Light/dark native compositor captures of the exact owned QA window, presented without activation and hidden immediately after each capture.');
  }
  await close();
  writeFileSync(path.join(evidence, 'desktop-acceptance.json'), JSON.stringify({ at: new Date().toISOString(), exe, sha256, result: 'passed', method: 'Release EXE / hidden QA main window with distinct app identity; actual non-activating reminder displayed; local CDP DOM actions, no host keyboard/mouse', results, pageErrors: errors, limits: ['Physical dragging, physical tray menu clicks, OS sleep and multi-monitor switching not exercised.', 'QA tray object is created then hidden; normal tray restore handler is shared but QA show is intentionally suppressed.'] }, null, 2));
  console.log(results.join('\n'));
  }
} catch (error) {
  if (page) {
    const diagnostics = await page.evaluate(async () => ({ root: { ...document.documentElement.dataset }, native: await window.__TAURI__.core.invoke('appearance_state').catch(String) })).catch(String);
    writeFileSync(path.join(evidence, 'failure-state.json'), JSON.stringify(diagnostics, null, 2));
  }
  writeFileSync(path.join(evidence, 'desktop-acceptance.json'), JSON.stringify({ at: new Date().toISOString(), exe, sha256, result: 'failed', results, error: String(error), pageErrors: errors }, null, 2));
  throw error;
} finally { if (child) await close().catch(error => { console.error('Acceptance cleanup:', error); process.exitCode = 1; }); }
