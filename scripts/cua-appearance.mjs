import { chromium } from 'playwright-core';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { root } from './environment.mjs';
const theme = process.argv[2];
assert.ok(['light','dark'].includes(theme));
const session = JSON.parse(readFileSync(path.join(root,'tmp/cua-session-connected.json')));
assert.equal(session.identity,'local.cosweel.pomodoro.toolqa');
const browser = await chromium.connectOverCDP(`http://127.0.0.1:${session.port}`);
try {
  const page = browser.contexts().flatMap(context=>context.pages()).find(page=>/tauri\.localhost/.test(page.url())&&!page.url().includes('reminder'));
  if(process.argv.includes('--pin')) await page.evaluate(async()=>{const desktop=await window.__TAURI__.core.invoke('desktop_state');if(!desktop.pinned)await window.__TAURI__.core.invoke('desktop_action',{action:'pin'});});
  await page.evaluate(theme=>{localStorage.setItem('pomodoro.theme.v1',theme);window.dispatchEvent(new StorageEvent('storage',{key:'pomodoro.theme.v1',newValue:theme}));},theme);
  await page.waitForFunction(theme=>document.documentElement.dataset.theme===theme&&document.documentElement.dataset.material==='acrylic',theme);
  console.log(JSON.stringify(await page.evaluate(async()=>({theme:document.documentElement.dataset.theme,surface:getComputedStyle(document.querySelector('.app-shell')).backgroundColor,appearance:await window.__TAURI__.core.invoke('appearance_state')}))));
} finally {await browser.close();}
