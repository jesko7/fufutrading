// End-to-end smoke test: launches the real Electron app with an isolated user-data dir,
// walks through the main flows and saves screenshots to tests/e2e/screenshots.
//   node tests/e2e/run.mjs [scenario...]
import { _electron as electron } from 'playwright-core';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const root = path.resolve(import.meta.dirname, '../..');
const shots = path.join(root, 'tests/e2e/screenshots');
fs.mkdirSync(shots, { recursive: true });
const scenarios = process.argv.slice(2).length ? process.argv.slice(2) : ['smoke'];
const keep = process.env.FUFU_E2E_PROFILE;
const userData = keep || fs.mkdtempSync(path.join(os.tmpdir(), 'fufu-e2e-'));
const errors = [];
let failures = 0;

function check(cond, msg) {
  if (cond) console.log(`  ✓ ${msg}`);
  else {
    console.log(`  ✗ ${msg}`);
    failures++;
  }
}

const app = await electron.launch({
  executablePath: require('electron'),
  args: [root],
  env: Object.fromEntries(Object.entries({ ...process.env, FUFU_USER_DATA: userData, FUFU_QUIET: '1' }).filter(([k]) => k !== 'ELECTRON_RUN_AS_NODE')),
  timeout: 60000,
});
const page = await app.firstWindow();
page.on('console', (m) => {
  if (m.type() === 'error') errors.push(m.text());
});
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
await page.setViewportSize({ width: 1500, height: 920 }).catch(() => {});
await app.evaluate(({ BrowserWindow }) => {
  const w = BrowserWindow.getAllWindows()[0];
  w.setSize(1500, 920);
  w.center();
});

async function shot(name) {
  await page.screenshot({ path: path.join(shots, `${name}.png`) });
  console.log(`  📷 ${name}.png`);
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const S = {
  async smoke() {
    console.log('scenario: smoke');
    await page.waitForSelector('.start, .workspace', { timeout: 30000 });
    check(await page.isVisible('.start'), 'start screen is shown on first launch');
    await shot('01-start');
    await page.click('.preset:has-text("Trader")');
    await page.waitForSelector('.chart-host canvas', { timeout: 30000 });
    await page.waitForFunction(() => [...document.querySelectorAll('.badge')].some((b) => b.textContent?.includes('Live')), null, { timeout: 45000 });
    check(true, 'chart reached live state');
    await wait(2500);
    await shot('02-trader');
    const bookRows = await page.$$eval('.ob-row', (r) => r.length);
    check(bookRows > 10, `order book shows rows (${bookRows})`);
    const watchRows = await page.$$eval('.watch-row', (r) => r.length);
    check(watchRows >= 3, `watchlist rows (${watchRows})`);
  },
  async charts() {
    console.log('scenario: charts');
    // switch chart type & timeframe on the first chart
    await page.click('.stack-head .tab:has-text("1h")').catch(() => {});
    await wait(1500);
    await page.keyboard.press('Control+k');
    await page.waitForSelector('.palette input');
    await page.fill('.palette input', '7m');
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => document.querySelector('.legend-title')?.textContent?.includes('7m'), null, { timeout: 20000 });
    check(true, 'custom timeframe 7m applied via command palette');
    await wait(2500);
    await shot('03-chart-7m');
  },
  async trading() {
    console.log('scenario: trading');
    await page.click('button:has-text("Create paper account")');
    await page.waitForSelector('.modal:has-text("New paper account")');
    await page.click('.modal button:has-text("Perpetual futures")');
    await page.click('.modal button:has-text("Create account")');
    await page.waitForSelector('.trade-panel button:has-text("Open long")', { timeout: 15000 });
    check(true, 'futures paper account created from the trade panel');
    await page.click('.trade-panel button:has-text("25%")');
    await wait(500);
    await page.click('.trade-panel button:has-text("Open long")');
    await page.waitForFunction(() => [...document.querySelectorAll('.toast')].some((t) => /Order filled/.test(t.textContent || '')), null, { timeout: 15000 });
    check(true, 'market order filled');
    await page.waitForFunction(() => document.querySelectorAll('.acct table.table tbody tr').length >= 1, null, { timeout: 10000 });
    const posText = await page.textContent('.acct table.table tbody tr');
    check(/Long/.test(posText || ''), `position shown in account module (${(posText || '').replace(/\s+/g, ' ').slice(0, 80)})`);
    await wait(1500);
    await shot('04-position');
    // set TP/SL via the account table editor
    await page.click('.acct td span[data-tip^="Edit"]');
    const fields = await page.$$('.acct td input.input');
    const last = await page.evaluate(() => parseFloat((document.querySelectorAll('.acct tbody tr td')[3]?.textContent || '').replace(/,/g, '')));
    await fields[0].fill(String(Math.round(last * 1.02)));
    await fields[1].fill(String(Math.round(last * 0.98)));
    await page.click('.acct td button.icon-btn:has(svg)');
    await wait(1500);
    const orders = await page.textContent('.acct .tabs');
    check(/Orders\s*2/.test(orders || ''), `TP and SL orders created (${(orders || '').replace(/\s+/g, ' ')})`);
    await shot('05-brackets');
    await page.click('.acct td button:has-text("Close")');
    await page.waitForFunction(() => document.querySelectorAll('.acct table.table tbody tr').length === 0, null, { timeout: 10000 });
    const tabs = await page.textContent('.acct .tabs');
    check(!/Orders\s*\d/.test(tabs || ''), 'closing the position canceled its TP/SL (OCO)');
  },
};

try {
  for (const s of scenarios) {
    if (!S[s]) throw new Error(`unknown scenario ${s}`);
    await S[s]();
  }
} catch (e) {
  failures++;
  console.log(`  ✗ ${e.message}`);
  await shot('error').catch(() => {});
} finally {
  const relevant = errors.filter((e) => !/Autofill|DevTools|favicon/.test(e));
  if (relevant.length) {
    console.log('console errors:');
    for (const e of relevant.slice(0, 20)) console.log(`  ! ${e}`);
  }
  await app.close().catch(() => {});
  if (!keep) fs.rmSync(userData, { recursive: true, force: true });
  console.log(failures ? `FAILED (${failures})` : 'PASSED');
  process.exit(failures ? 1 : 0);
}
