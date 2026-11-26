import { chromium } from 'playwright-core';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { root } from './environment.mjs';
const session = JSON.parse(readFileSync(path.join(root, 'tmp/cua-session-connected.json')));
const browser = await chromium.connectOverCDP(`http://127.0.0.1:${session.port}`);
try {
  const pages = browser.contexts().flatMap(context => context.pages());
  const page = pages.find(page => /tauri\.localhost/.test(page.url()) && !page.url().includes('reminder'));
  console.log(JSON.stringify(await page.evaluate(async () => {
    const element = document.querySelector('.presets');
    return { desktop: await window.__TAURI__.core.invoke('desktop_state'), presets: element && { client: [element.clientWidth, element.clientHeight], scroll: [element.scrollWidth, element.scrollHeight], overflowY: getComputedStyle(element).overflowY, coarse: matchMedia('(any-pointer: coarse)').matches } };
  }), null, 2));
} finally { await browser.close(); }
