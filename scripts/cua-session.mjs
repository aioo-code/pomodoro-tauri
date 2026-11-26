import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { mkdirSync, readFileSync, writeFileSync, createWriteStream } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import path from 'node:path';
import { chromium } from 'playwright-core';
import { root, env } from './environment.mjs';
const suffix = 'connected';
const receipt = path.join(root, `tmp/cua-session-${suffix}.json`);
if (process.argv.includes('stop')) {
  const session = JSON.parse(readFileSync(receipt, 'utf8'));
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${session.port}`);
  const page = browser.contexts().flatMap(c => c.pages()).find(p => /tauri\.localhost/.test(p.url()) && !p.url().includes('reminder.html'));
  if (!page) throw new Error('Owned QA main page is unavailable; leave the unknown result intact.');
  await page.evaluate(() => window.__TAURI__.core.invoke('desktop_action', { action: 'quit' })).catch(() => {});
  await browser.close().catch(() => {});
  console.log('Requested normal exit of the dedicated CUA QA instance.');
} else {
  const dataDirectory = path.join(root, `tmp/cua-tool-${suffix}`);
  const launchDirectory = path.join(root, 'tmp/connected-cua-launch');
  mkdirSync(dataDirectory, { recursive: true });
  mkdirSync(launchDirectory, { recursive: true });
  const launchArgs = ['--qa-cua'];
  if (process.env.POMODORO_CUA_SHORT_TIMER === '1') launchArgs.push('--qa-seconds=2', '--qa-show-reminders');
  launchArgs.push(`--tool-data-dir=${dataDirectory}`);
  if (process.env.POMODORO_CUA_PREFERENCES) launchArgs.push(`--qa-preferences-file=${process.env.POMODORO_CUA_PREFERENCES}`);
  const server = createServer(); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const port = server.address().port; await new Promise(resolve => server.close(resolve));
  const child = spawn(process.env.POMODORO_EXE ?? path.join(root, 'src-tauri/target/release/pomodoro-connected.exe'), launchArgs, { cwd: launchDirectory, env: { ...env, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port} --remote-debugging-address=127.0.0.1` }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  const log = createWriteStream(path.join(root, `tmp/cua-native-${suffix}.log`));
  child.stdout.pipe(log); child.stderr.pipe(log);
  child.on('error', error => { console.error(error); process.exitCode = 1; });
  writeFileSync(receipt, JSON.stringify({ pid: child.pid, port, exe: child.spawnfile, identity: 'local.cosweel.pomodoro.toolqa', at: new Date().toISOString() }, null, 2));
  await delay(1000);
  console.log(`Dedicated visible QA process ${child.pid}, port ${port}.`);
  await once(child, 'exit');
  log.end();
}
