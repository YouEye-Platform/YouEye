// Opens a browser window for one test user. The person signs in to YouEye ID themselves; the session
// (cookies + storage) is saved to .auth/<name>.json every few seconds and when the window closes.
// Usage: node save-session.mjs <name> <box-url>      (e.g. admin https://<name>.ui.bingo)
import { chromium } from '@playwright/test';
import { mkdirSync } from 'node:fs';

const [name, url] = process.argv.slice(2);
if (!/^[a-z0-9-]+$/.test(name ?? '') || !/^https:\/\/[a-z0-9.-]+\/?$/.test(url ?? '')) {
  console.error('usage: node save-session.mjs <name> https://<box>');
  process.exit(2);
}
mkdirSync('.auth', { recursive: true, mode: 0o700 });
const file = `.auth/${name}.json`;
const browser = await chromium.launch({ headless: false, args: [`--window-name=YouEye test: sign in as ${name}`] });
const context = await browser.newContext({ viewport: { width: 1100, height: 800 } });
const page = await context.newPage();
await page.goto(url);
await page.evaluate((n) => { document.title = `Sign in as ${n} — ` + document.title; }, name).catch(() => {});
const save = () => context.storageState({ path: file }).catch(() => {});
const timer = setInterval(save, 3000);
await new Promise((resolve) => { page.on('close', resolve); browser.on('disconnected', resolve); });
clearInterval(timer);
await save();
await browser.close().catch(() => {});
console.log(`saved ${file}`);
