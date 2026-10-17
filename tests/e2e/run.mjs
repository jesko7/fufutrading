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

// FUFU_E2E_EXE=path/to/FuFu Trading.exe tests the packaged build instead of the source checkout
const exe = process.env.FUFU_E2E_EXE;
const app = await electron.launch({
  executablePath: exe || require('electron'),
  args: exe ? [] : [root],
  env: Object.fromEntries(Object.entries({ ...process.env, FUFU_USER_DATA: userData, FUFU_QUIET: '1', FUFU_TEST_TOOLS: '1' }).filter(([k]) => k !== 'ELECTRON_RUN_AS_NODE')),
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

/** A legend row of the first chart; on a crowded chart it may sit in the "+N more" list. */
async function legendRow(name, timeout = 30000) {
  const inLegend = page.locator('.chart-legend .ind-item', { hasText: name }).first();
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await inLegend.isVisible().catch(() => false)) return inLegend;
    const more = page.locator('.chart-legend .ind-more').first();
    if (await more.isVisible().catch(() => false)) {
      if (!(await page.locator('.ind-more-list').isVisible().catch(() => false))) await more.click();
      const r = page.locator('.ind-more-list .ind-item', { hasText: name }).first();
      if (await r.isVisible().catch(() => false)) return r;
    }
    await wait(250);
  }
  throw new Error(`legend row "${name}" not found`);
}

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
  async presets() {
    console.log('scenario: workspace presets');
    const open = async (name) => {
      if (!(await page.isVisible('.start'))) {
        await page.keyboard.press('Control+k');
        await page.waitForSelector('.palette input');
        await page.fill('.palette input', 'Workspaces & presets');
        await page.keyboard.press('Enter');
        await page.waitForSelector('.start', { timeout: 10000 });
      }
      await page.click(`.preset:has(.p-name:text-is("${name}"))`);
      await page.waitForSelector('.start', { state: 'detached', timeout: 15000 });
    };
    for (const [name, sels, file] of [
      ['Automation', ['.bots', '.chart-host canvas', '.alerts'], '03-preset-automation'],
      ['Prop Challenge', ['.prop-mod', '.chart-host canvas'], '03-preset-prop'],
      ['Strategy Lab', ['.ai-studio', '.chart-host canvas', '.tester'], '03-preset-lab'],
    ]) {
      await open(name);
      for (const s of sels) await page.waitForSelector(s, { timeout: 30000 });
      check(true, `${name} preset opens with ${sels.join(', ')}`);
      await wait(1500);
      await shot(file);
    }
    // later scenarios expect the Trader layout from the smoke test
    await open('Trader');
    await page.waitForSelector('.trade-panel, .empty-title:has-text("No paper account")', { timeout: 30000 });
  },
  async light() {
    console.log('scenario: light theme');
    await page.click('button[data-tip="Toggle light / dark"]');
    await page.waitForFunction(() => document.documentElement.dataset.theme === 'light' || document.body.classList.contains('light') || getComputedStyle(document.body).backgroundColor !== 'rgb(10, 11, 14)', null, { timeout: 5000 });
    for (const [name, file] of [
      ['Trader', '40-light-trader'],
      ['Order Flow', '41-light-orderflow'],
      ['Strategy Lab', '42-light-lab'],
      ['Automation', '43-light-automation'],
      ['Prop Challenge', '44-light-prop'],
    ]) {
      if (!(await page.isVisible('.start'))) {
        await page.keyboard.press('Control+k');
        await page.waitForSelector('.palette input');
        await page.fill('.palette input', 'Workspaces & presets');
        await page.keyboard.press('Enter');
        await page.waitForSelector('.start', { timeout: 10000 });
      }
      await page.click(`.preset:has(.p-name:text-is("${name}"))`);
      await page.waitForSelector('.start', { state: 'detached', timeout: 15000 });
      await page.waitForSelector('.chart-host canvas, .heatmap canvas', { timeout: 30000 });
      await wait(4000);
      await shot(file);
    }
    check(true, 'presets render in the light theme');
    // newer modules in the light theme: derivatives data and the futures alert editor
    await page.keyboard.press('Control+k');
    await page.waitForSelector('.palette input');
    await page.fill('.palette input', 'Add Derivatives');
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => document.querySelectorAll('.deriv-card .dc-value').length >= 4, null, { timeout: 45000 });
    await wait(1500);
    await shot('45-light-derivatives');
    await page.keyboard.press('Control+k');
    await page.waitForSelector('.palette input');
    await page.fill('.palette input', 'Add Alerts');
    await page.keyboard.press('Enter');
    await page.waitForSelector('.alerts', { timeout: 15000 });
    await page.click('.stack-head button:has-text("New alert")');
    await page.click('.menu-item:has-text("Futures data")');
    await page.waitForSelector('.alert-editor');
    await wait(800);
    await shot('46-light-futures-alert');
    await page.keyboard.press('Escape');
    check(true, 'derivatives and the futures alert editor render in the light theme');
    // options: the smile (series colours have light-theme steps) and the chain
    await page.keyboard.press('Control+k');
    await page.waitForSelector('.palette input');
    await page.fill('.palette input', 'Add Options');
    await page.keyboard.press('Enter');
    await page.waitForSelector('.opt-mod .oc-table tbody tr td.oc-strike', { timeout: 90000 });
    await page.locator('.opt-mod .tabs .tab:has-text("Smile")').last().click();
    await page.waitForSelector('.opt-mod .ox-chart svg path.ox-series', { timeout: 15000 });
    await wait(800);
    await shot('46b-light-options-smile');
    await page.locator('.opt-mod .tabs .tab:has-text("Chain")').last().click();
    await wait(500);
    await shot('46c-light-options-chain');
    check(true, 'the options module renders in the light theme');
    await page.click('button[data-tip="Toggle light / dark"]');
  },
  async perf() {
    console.log('scenario: performance');
    const metrics = () => app.evaluate(({ app }) => app.getAppMetrics().map((m) => ({ type: m.type, pid: m.pid, cpu: m.cpu.percentCPUUsage, mem: Math.round(m.memory.workingSetSize / 1024) })));
    await wait(4000);
    await metrics();
    await wait(10000);
    const idle = await metrics();
    const total = idle.reduce((a, m) => a + m.cpu, 0);
    console.log('    idle (10 s): ' + idle.map((m) => `${m.type} ${m.cpu.toFixed(1)}% ${m.mem}MB`).join(' | '));
    check(total < 60, `idle CPU with a live chart, book, tape and watchlist: ${total.toFixed(1)}% of one core`);
    // frame rate while panning the chart
    const box = await page.locator('.chart-host').first().boundingBox();
    const fps = page.evaluate(() => new Promise((r) => { let n = 0; const t0 = performance.now(); const f = () => { n++; if (performance.now() - t0 < 2000) requestAnimationFrame(f); else r(n / ((performance.now() - t0) / 1000)); }; requestAnimationFrame(f); }));
    await page.mouse.move(box.x + box.width * 0.6, box.y + box.height * 0.5);
    await page.mouse.down();
    for (let k = 0; k < 60; k++) {
      await page.mouse.move(box.x + box.width * (0.6 - 0.3 * Math.sin(k / 10)), box.y + box.height * 0.5);
      await wait(25);
    }
    await page.mouse.up();
    const f = await fps;
    check(f > 30, `frame rate while panning: ${f.toFixed(0)} fps`);
    // a long backtest: one year of 5-minute bars
    const t0 = Date.now();
    const bt = await page.evaluate(() => window.fufu.invoke('ai:testTool', 'backtest', { id: 'builtin:strat_ma_cross', symbol: 'BTCUSDT', tf: '5m', days: 365 }));
    const ms = Date.now() - t0;
    console.log(`    backtest 1y of 5m: ${ms} ms (${bt.result.metrics?.trades} trades)`);
    check(bt.result.ok && ms < 120000, `one year of 5-minute bars backtested in ${(ms / 1000).toFixed(1)} s`);
    // the same again with the data cached: compute only
    const t1 = Date.now();
    const bt2 = await page.evaluate(() => window.fufu.invoke('ai:testTool', 'backtest', { id: 'builtin:strat_ma_cross', symbol: 'BTCUSDT', tf: '5m', days: 365 }));
    const ms2 = Date.now() - t1;
    check(bt2.result.ok && ms2 < 30000, `cached rerun: ${(ms2 / 1000).toFixed(1)} s`);
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
    // the Trader chart shows spot; it points at the perpetual position and switches over on click
    await page.waitForSelector('.stack-head .other-pos', { timeout: 10000 });
    check(/Perp long/.test((await page.textContent('.stack-head .other-pos')) || ''), 'spot chart points to the perp position');
    // Binance lets a cross position change its leverage: raise it by one step with the keyboard
    const levText = () => page.textContent('.trade-panel .row:has(input[type=range]) b.num');
    const lev0 = parseInt((await levText()) || '0');
    await page.focus('.trade-panel input[type=range]');
    await page.keyboard.press('ArrowRight');
    await wait(1000);
    const lev1 = parseInt((await levText()) || '0');
    const badge = await page.textContent('.acct table.table tbody tr .badge');
    check(lev1 === lev0 + 1 && new RegExp(`${lev1}x`).test(badge || ''), `leverage of the open position raised ${lev0}x → ${lev1}x (${badge})`);
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
    // a reduce-only trailing stop from the trade panel
    await page.click('.trade-panel .tabs .tab:has-text("Trailing")');
    await page.click('.trade-panel .buy-sell button:has-text("Short")');
    await page.locator('.trade-panel label:has-text("Reduce-only") .toggle, .trade-panel label:has-text("Reduce-only") [role=switch]').first().click();
    await page.click('.trade-panel button:has-text("Reduce long BTC (trailing)")');
    await page.waitForFunction(() => /Orders\s*3/.test(document.querySelector('.acct .tabs')?.textContent || ''), null, { timeout: 10000 });
    check(true, 'reduce-only trailing stop placed from the trade panel');
    await shot('05-brackets');
    await page.click('.acct td button:has-text("Close")');
    await page.waitForFunction(() => document.querySelectorAll('.acct table.table tbody tr').length === 0, null, { timeout: 10000 });
    const tabs = await page.textContent('.acct .tabs');
    check(!/Orders\s*\d/.test(tabs || ''), 'closing the position canceled its TP/SL (OCO)');
    // journal: a note, a tag and a rating on the closed trade; stats per setup
    await page.click('.acct .tabs .tab:has-text("Trades")');
    await page.click('.acct .journal-btn');
    await page.fill('.journal-editor textarea', 'Tested the trailing stop');
    await page.fill('.journal-editor input', 'breakout');
    await page.click('.journal-editor .star-btn >> nth=3');
    await page.click('.journal-editor button:has-text("Save")');
    await page.waitForSelector('.acct .journal-tag:has-text("breakout")', { timeout: 10000 });
    await page.click('.acct button:has-text("By setup")');
    const setups = await page.textContent('.acct .mod-scroll');
    check(/breakout/.test(setups || '') && /4\.0 ★/.test(setups || ''), 'journal tag, note and rating saved; stats per setup');
    await shot('05b-journal');
    await page.click('.acct button:has-text("Trades") >> nth=0');
    // the equity tab: the curve and the account's Greeks against buy & hold
    await page.click('.acct .tabs .tab:has-text("Equity")');
    await page.waitForSelector('.acct .equity-greeks:has-text("Greeks against BTC buy & hold")', { timeout: 15000 });
    const eqText = await page.textContent('.acct .equity-greeks');
    check(/at least five daily returns|α/.test(eqText || ''), `account Greeks against buy & hold (${(eqText || '').replace(/\s+/g, ' ').slice(0, 90)})`);
    const ids = await page.evaluate(() => window.fufu.invoke('trading:list'));
    const g = await page.evaluate((id) => window.fufu.invoke('trading:greeks', id, 'ETHUSDT'), ids[0].id ?? ids[0].config?.id);
    check(g.symbol === 'ETHUSDT' && g.days === 0 && g.greeks === null, `a new account has no Greeks yet (${g.days} days)`);
    await page.click('.acct .tabs .tab:has-text("Positions")');
  },
  async scripts() {
    console.log('scenario: scripts');
    await page.locator('button:has-text("Indicators")').first().click();
    await page.waitForSelector('.picker-row', { timeout: 15000 });
    check(true, 'indicator picker lists scripts');
    for (const q of ['Relative Strength', 'Bollinger Bands', 'MA Crossover Strategy', 'Python: Z-Score']) {
      await page.fill('.picker-main input', q);
      await wait(150);
      await page.keyboard.press('Enter');
      await wait(150);
    }
    await shot('06-picker');
    // nothing found: Claude offers to build it; "Create with AI" prepares the request without sending
    await page.fill('.picker-main input', 'volume weighted squeeze ribbon');
    await page.waitForSelector('.picker-list button:has-text("with AI")', { timeout: 5000 });
    check(true, 'an unmatched search offers to build the indicator with AI');
    await page.click('.picker-foot button:has-text("Create with AI")');
    await page.waitForSelector('.ai-studio', { timeout: 15000 });
    await page.waitForFunction(() => /Build an indicator that/.test(document.querySelector('.ai-input')?.value || ''), null, { timeout: 10000 });
    check(true, 'AI Studio opens with the request prepared');
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => document.querySelectorAll('.chart-module:first-of-type .ind-item, .ind-item').length >= 4, null, { timeout: 30000 });
    // Python needs Pyodide to start (first run may take a few seconds)
    await page.waitForFunction(() => [...document.querySelectorAll('.ind-item')].every((r) => !r.querySelector('.spinner')), null, { timeout: 90000 });
    const errs = await page.$$eval('.ind-err', (e) => e.map((x) => x.textContent));
    check(errs.length === 0, `scripts run without errors ${errs.length ? JSON.stringify(errs) : ''}`);
    const rsi = await page.$$eval('.pane-legend .ind-item', (rows) => rows.map((r) => r.textContent || ''));
    check(rsi.some((t) => /RSI/.test(t) && /\d+\.\d+/.test(t)), `RSI pane legend shows values (${rsi.join(' | ').slice(0, 120)})`);
    const strat = await page.$$eval('.ind-item', (rows) => rows.map((r) => r.textContent || '').filter((t) => /trades/.test(t)));
    check(strat.length === 1, `strategy summary in legend (${strat.join('')})`);
    await wait(1000);
    await shot('07-indicators');
    // change the RSI length via the settings dialog
    const rsiRow = page.locator('.pane-legend .ind-item', { hasText: 'RSI' }).first();
    const before = await rsiRow.textContent();
    await rsiRow.hover();
    await rsiRow.locator('button[data-tip="Settings"]').click();
    await page.waitForSelector('.modal .set-row');
    const len = page.locator('.modal .set-row', { hasText: 'RSI Length' }).locator('input');
    await len.fill('5');
    await len.press('Enter');
    await page.click('.modal button:has-text("OK")');
    await page.waitForFunction((b) => {
      const r = [...document.querySelectorAll('.pane-legend .ind-item')].find((x) => /RSI/.test(x.textContent || ''));
      return r && r.textContent !== b && /RSI\s*5 close/.test(r.textContent || '');
    }, before, { timeout: 20000 });
    check(true, 'changing an input recomputes the indicator');
    await shot('08-rsi5');
  },
  async editor() {
    console.log('scenario: editor');
    await page.keyboard.press('Control+k');
    await page.waitForSelector('.palette input');
    await page.fill('.palette input', 'Add Script Editor');
    await page.keyboard.press('Enter');
    await page.waitForSelector('.script-editor .cm-content', { timeout: 15000 });
    await page.waitForFunction(() => document.querySelector('.script-editor .cm-content')?.textContent?.includes('indicator('), null, { timeout: 15000 });
    check(true, 'editor opens with a template');
    const typeCode = async (code) => {
      await page.click('.script-editor .cm-content');
      await page.keyboard.press('Control+a');
      await page.keyboard.press('Delete');
      for (const line of code.split('\n')) {
        await page.keyboard.type(line);
        await page.keyboard.press('Enter');
        await page.keyboard.press('Home');
      }
    };
    await typeCode('//@version=6\nindicator("E2E test", overlay=false)\nx = ta.rsi(close, 14)\nplot(y)');
    await page.waitForFunction(() => [...document.querySelectorAll('.problem')].some((p) => /line 4/.test(p.textContent || '')), null, { timeout: 20000 });
    check(true, 'undefined variable reported on line 4');
    await shot('09-editor-error');
    await typeCode('//@version=6\nindicator("E2E test", overlay=false)\nx = ta.rsi(close, 14)\nplot(x, "x")');
    await page.waitForFunction(() => /No problems/.test(document.querySelector('.se-panel-body')?.textContent || ''), null, { timeout: 20000 });
    check(true, 'diagnostics clear after the fix');
    await page.keyboard.press('Control+s');
    await page.waitForFunction(() => /E2E test/.test(document.querySelector('.se-title')?.textContent || '') && !document.querySelector('.dirty-dot'), null, { timeout: 15000 });
    check(true, 'saved with the title from indicator()');
    await page.click('.stack-head button[data-tip^="Add to chart"]');
    await page.waitForFunction(() => [...document.querySelectorAll('.ind-item')].some((r) => /E2E test/.test(r.textContent || '') && /\d+\.\d+/.test(r.textContent || '')), null, { timeout: 30000 });
    check(true, 'saved script added to the chart and computing');
    await page.click('.stack-head button[data-tip^="Bar inspector"]');
    await page.waitForSelector('.insp-table td.mono', { timeout: 30000 });
    const vars = await page.$$eval('.insp-table tbody td.mono:first-child', (t) => t.map((x) => x.textContent));
    check(vars.includes('x'), `inspector shows variables (${vars.join(', ')})`);
    await shot('10-editor-inspector');
  },
  async backtest() {
    console.log('scenario: backtest');
    await page.keyboard.press('Control+k');
    await page.waitForSelector('.palette input');
    await page.fill('.palette input', 'Add Strategy Tester');
    await page.keyboard.press('Enter');
    await page.waitForSelector('.tester', { timeout: 15000 });
    const sel = page.locator('.tester-bar select').first();
    await page.waitForFunction(() => [...document.querySelectorAll('.tester-bar select option')].some((o) => /MA Crossover Strategy/.test(o.textContent || '')), null, { timeout: 15000 });
    const value = await page.$$eval('.tester-bar select option', (os) => os.find((o) => /MA Crossover Strategy/.test(o.textContent || ''))?.getAttribute('value'));
    await sel.selectOption(value);
    await page.click('.tester-bar .seg button:has-text("3M")');
    await page.click('.stack-head button[data-tip="Run backtest"]');
    await page.waitForSelector('.kpis .kpi', { timeout: 180000 });
    const kpis = await page.$$eval('.kpi', (k) => k.map((x) => x.textContent || ''));
    check(kpis.length >= 8, `KPIs shown (${kpis.slice(0, 3).join(' | ')})`);
    // a few seconds later: the live replay confirms the backtest is reproducible
    const replayed = await page.waitForSelector('.replay-note:has-text("Reproducible live")', { timeout: 90000 }).then(() => true).catch(() => false);
    if (!replayed) {
      const list = await page.evaluate(() => window.fufu.invoke('backtests:list'));
      const recd = await page.evaluate((id) => window.fufu.invoke('backtests:get', id), list[0]?.id);
      console.log('    debug replay:', JSON.stringify(recd?.replay), 'created', recd?.created, 'now', Date.now(), 'notes', await page.$$eval('.replay-note', (n) => n.map((x) => x.textContent)));
    }
    check(replayed, `the backtest replays live (${((await page.textContent('.overview').catch(() => '')) || '').match(/Reproducible live[^.]*\./)?.[0] || 'no verdict'})`);
    await wait(500);
    await shot('11-backtest-overview');
    await page.click('.results .tabs .tab:has-text("Trades")');
    const rows = await page.$$eval('.trades-table tbody tr.clickable', (r) => r.length);
    check(rows > 0, `trades listed (${rows})`);
    await page.click('.results .tabs .tab:has-text("Returns")');
    const months = await page.$$eval('.monthly-table td.heat', (c) => c.filter((x) => (x.textContent || '').trim()).length);
    check(months >= 3, `monthly returns (${months} months)`);
    await page.click('.results .tabs .tab:has-text("Analysis")');
    const regimes = await page.$$eval('.analysis table:nth-of-type(2) tbody tr', (r) => r.length);
    check(regimes >= 2, `regime breakdown rows (${regimes})`);
    await shot('12-backtest-analysis');
    // the strategy against 1,000 random twins, and its Greeks
    await page.click('.results .tabs .tab:has-text("vs Random")');
    await page.waitForSelector('.random-view .callout', { timeout: 10000 });
    const verdict = await page.textContent('.random-view .callout');
    const rbRows = await page.$$eval('.random-view .rb-table tbody tr', (r) => r.length);
    check(/random twins/.test(verdict || '') && rbRows >= 5, `random counterparts: ${(verdict || '').replace(/\s+/g, ' ').slice(0, 110)}`);
    const mcText = await page.textContent('.random-view');
    check(/Trade-order Monte Carlo/.test(mcText || '') && /Chance of a loss/.test(mcText || ''), 'trade-order Monte Carlo shown');
    await shot('12b-backtest-random');
    await page.click('.results .tabs .tab:has-text("Greeks")');
    await page.waitForSelector('.greek-card', { timeout: 10000 });
    const greeks = await page.$$eval('.greek-card', (c) => c.map((x) => x.querySelector('.greek-sym')?.textContent).join(' '));
    check(/α β ρ R² σ Ω/.test(greeks), `Greeks shown (${greeks})`);
    await shot('12c-backtest-greeks');
    // futures with leverage: funding + mark prices
    await page.click('.tester-bar button[data-tip^="Backtest settings"]');
    await page.waitForSelector('.tester-settings');
    await page.keyboard.press('Escape');
    await page.click('.results .tabs .tab:has-text("Assumptions")');
    const info = await page.textContent('.info');
    check(/Bars tested/.test(info || ''), 'assumptions documented');
  },
  async optimizer() {
    console.log('scenario: optimizer');
    await page.keyboard.press('Control+k');
    await page.waitForSelector('.palette input');
    await page.fill('.palette input', 'Add Optimizer');
    await page.keyboard.press('Enter');
    await page.waitForSelector('.optimizer .opt-params tbody tr', { timeout: 20000 });
    await page.waitForFunction(() => document.querySelectorAll('.optimizer .opt-params input[type=checkbox]:checked').length >= 2, null, { timeout: 20000 });
    check(true, 'parameters pre-selected from the strategy inputs');
    const budget = page.locator('.optimizer .set-row', { hasText: 'Trials' }).locator('input');
    await budget.fill('24');
    await budget.press('Enter');
    await page.click('.optimizer .tester-bar .seg button:has-text("6M")');
    await shot('13-optimizer-setup');
    await page.click('.stack-head button[data-tip="Start optimization"]');
    await page.waitForSelector('.optimizer .opt-table tbody tr', { timeout: 300000 });
    const rows = await page.$$eval('.optimizer .opt-table tbody tr', (r) => r.length);
    check(rows >= 10, `ranked results (${rows} rows)`);
    await shot('14-optimizer-results');
    await page.click('.optimizer .tabs .tab:has-text("Landscape")');
    await page.waitForSelector('.optimizer canvas', { timeout: 10000 });
    check(true, 'heatmap rendered');
    await shot('15-optimizer-heatmap');
    await page.click('.optimizer .tabs .tab:has-text("Validation")');
    const val = await page.textContent('.optimizer .results-body');
    check(/Out-of-sample/.test(val || ''), 'holdout validation shown');
    await page.click('.optimizer .tabs .tab:has-text("Overfitting")');
    const cards = await page.$$eval('.stat-card', (c) => c.length);
    check(cards >= 3, `statistics cards (${cards})`);
    await shot('16-optimizer-stats');
  },
  async experiments() {
    console.log('scenario: experiments (run after optimizer)');
    // save the optimizer's best as a parameter set
    await page.click('.optimizer .tabs .tab:has-text("Results")');
    await page.click('.optimizer button:has-text("Save set")');
    await page.waitForSelector('.modal input');
    await page.fill('.modal input', 'E2E best set');
    await page.click('.modal button:has-text("OK")');
    await page.waitForFunction(() => [...document.querySelectorAll('.toast')].some((t) => /Parameter set saved/.test(t.textContent || '')), null, { timeout: 10000 });
    check(true, 'parameter set saved from the optimizer');
    await page.keyboard.press('Control+k');
    await page.waitForSelector('.palette input');
    await page.fill('.palette input', 'Add Experiments');
    await page.keyboard.press('Enter');
    await page.waitForSelector('.experiments', { timeout: 15000 });
    await page.click('.stack-head button:has-text("New experiment")');
    await page.waitForSelector('.exp-title', { timeout: 10000 });
    await page.fill('.exp-title', 'MA cross on BTC 1h');
    await page.fill('.exp-notes', 'Hypothesis: trend following works on 1h.');
    await wait(900);
    await page.click('.exp-activity .act-row button[data-tip^="Link"]');
    await page.waitForFunction(() => document.querySelectorAll('.exp-editor .act-row').length >= 2, null, { timeout: 10000 });
    const linked = await page.$$eval('.exp-editor .act-row', (r) => r.map((x) => x.textContent || ''));
    check(linked.some((t) => /optimization|backtest/.test(t)), 'run linked to the experiment');
    check(linked.some((t) => /E2E best set/.test(t)), 'parameter set listed');
    const items = await page.$$eval('.exp-item', (r) => r.map((x) => x.textContent || ''));
    check(items.some((t) => /MA cross on BTC 1h/.test(t)), 'experiment saved with its title');
    await shot('17-experiments');
  },
  async bots() {
    console.log('scenario: bots');
    await page.keyboard.press('Control+k');
    await page.waitForSelector('.palette input');
    await page.fill('.palette input', 'Add Bots');
    await page.keyboard.press('Enter');
    await page.waitForSelector('.bots', { timeout: 15000 });
    await page.click('.bots button:has-text("Create a bot")');
    await page.waitForSelector('.modal:has-text("New paper account")');
    await page.click('.modal button:has-text("Perpetual futures")');
    await page.click('.modal button:has-text("Create account")');
    await page.waitForSelector('.bot-setup', { timeout: 15000 });
    check(true, 'bot account created; setup shown');
    // default strategy is the MA crossover; trade it on 1m with fast parameters
    await page.waitForFunction(() => document.querySelectorAll('.bot-setup .bs-inputs .set-row').length >= 3, null, { timeout: 20000 });
    check(true, 'strategy parameters loaded');
    const verdict = await page.waitForFunction(() => /Reproducible live|Not reproducible live|not checked/.test(document.querySelector('.bot-setup')?.textContent || ''), null, { timeout: 60000 }).then(() => page.$eval('.bot-setup', (e) => (e.textContent || '').match(/(Reproducible live[^.]*|Not reproducible live|Live replay not checked[^.]*)/)?.[0])).catch(() => null);
    check(/^Reproducible live/.test(verdict || ''), `the setup replays the strategy as the bot would see it (${verdict})`);
    await page.click('.bot-setup button.tab:has-text("1m")');
    const inputs = await page.$$('.bot-setup .bs-inputs .set-row input');
    await inputs[0].fill('5');
    await inputs[0].press('Tab');
    await inputs[1].fill('13');
    await inputs[1].press('Tab');
    await shot('18-bot-setup');
    await page.click('.bot-setup button:has-text("Start bot")');
    await page.waitForSelector('.bot-head .status-pill:has-text("Running")', { timeout: 15000 });
    check(true, 'bot running');
    await page.waitForFunction(() => [...document.querySelectorAll('.bot-stats .stat .k')].some((k) => /Last evaluation/.test(k.textContent || '')), null, { timeout: 60000 });
    check(true, 'first evaluation finished');
    const head = await page.textContent('.bot-head');
    check(/Waiting for the 1m bar to close|next evaluation/i.test(head || ''), `phase shows the next evaluation (${(head || '').replace(/\s+/g, ' ').slice(0, 100)})`);
    const act = await page.textContent('.bot-detail .mod-scroll');
    check(/Bot started/.test(act || ''), 'activity log shows the start');
    await page.click('.bot-detail .tabs .tab:has-text("State")');
    await page.waitForSelector('.bot-state .bot-card');
    const state = await page.textContent('.bot-state');
    check(/Fast/.test(state || '') && /Slow/.test(state || ''), 'indicator values of the last closed bar shown');
    check(/Last decision/.test(state || ''), 'last decision shown');
    await shot('19-bot-state');
    await page.click('.bot-detail .tabs .tab:has-text("Signals")');
    await page.waitForSelector('.bot-signals');
    // manual trading is locked while the bot runs
    const locked = await page.evaluate(async () => {
      const list = await window.fufu.invoke('trading:list');
      const bot = list.find((a) => a.config.kind === 'bot');
      try {
        await window.fufu.invoke('trading:place', bot.config.id, { symbol: 'BTCUSDT', side: 'buy', type: 'market', qty: 0.01 });
        return 'placed';
      } catch (e) {
        return String(e.message || e);
      }
    });
    check(/running bot controls this account/.test(locked), 'manual orders are rejected while the bot runs');
    await page.click('.bot-head button:has-text("Pause")');
    await page.waitForSelector('.bot-head .status-pill:has-text("Paused")', { timeout: 10000 });
    check(true, 'bot paused');
    await page.click('.bot-head button:has-text("Resume")');
    await page.waitForSelector('.bot-head .status-pill:has-text("Running")', { timeout: 10000 });
    check(true, 'bot resumed');
    await page.click('.bot-head button:has-text("Stop")');
    await page.click('.menu-item:has-text("Stop and close the position")');
    await page.waitForSelector('.bot-head .status-pill:has-text("Stopped")', { timeout: 10000 });
    check(await page.isVisible('.bot-setup'), 'bot stopped; setup editable again');
    // join mode takes the strategy's current position right away
    await page.click('.bot-setup .seg button:has-text("Join current position")');
    await page.click('.bot-setup button:has-text("Start bot")');
    await page.waitForSelector('.bot-head .status-pill:has-text("Running")', { timeout: 15000 });
    await page.waitForFunction(() => [...document.querySelectorAll('.bot-stats .stat')].some((s) => /Strategy/.test(s.textContent || '') && /in sync|holding/.test(s.textContent || '')), null, { timeout: 60000 });
    const stats = await page.textContent('.bot-stats');
    check(true, `join mode in sync with the strategy (${(stats || '').replace(/\s+/g, ' ').slice(0, 160)})`);
    await shot('20-bot-running');
    const items = await page.$$eval('.bot-item', (r) => r.length);
    check(items === 1, 'bot listed in the sidebar');
    // mute this bot's notifications with the bell (works while it runs)
    await page.click('.bot-head button[data-tip^="Notifications about this bot"]');
    await page.waitForFunction(async () => (await window.fufu.invoke('trading:list')).some((a) => a.config.bot && a.config.bot.notify === false), null, { timeout: 10000, polling: 300 });
    await page.waitForSelector('.bot-head .muted-bell', { timeout: 10000 });
    check(true, 'bot muted with the bell (its log keeps everything)');
    await page.click('.bot-head .muted-bell');
    await page.waitForFunction(async () => (await window.fufu.invoke('trading:list')).some((a) => a.config.bot && a.config.bot.notify === true), null, { timeout: 10000, polling: 300 });
  },
  async botlive() {
    console.log('scenario: botlive (1s bars, a strategy that trades every other bar)');
    const code = ['//@version=6', 'strategy("Flip test", overlay=true, default_qty_type=strategy.fixed, default_qty_value=0.001)', 'if bar_index % 2 == 0', '    strategy.entry("L", strategy.long)', 'else', '    strategy.close("L")', ''].join('\n');
    const id = await page.evaluate(async (code) => {
      const f = window.fufu.invoke;
      const doc = await f('scripts:importText', 'Flip test', code, 'pine');
      const acct = await f('trading:create', { name: 'Flip bot', kind: 'bot', market: 'spot', initialBalance: 10000, costPreset: 'binance-spot', bot: { scriptId: '', language: 'pine', params: {}, symbol: 'BTCUSDT', market: 'spot', tf: '1s', chartType: 'candles', status: 'stopped', sizing: { mode: 'strategy', value: 1 }, autostart: false } });
      await f('bots:configure', acct.id, { scriptId: doc.id, symbol: 'BTCUSDT', tf: '1s', chartType: 'candles', sizing: { mode: 'strategy', value: 1 }, warmupBars: 50 });
      await f('bots:start', acct.id, { mode: 'next' });
      return acct.id;
    }, code);
    check(!!id, 'flip bot created and started via the API');
    await wait(30000);
    const v = await page.evaluate((id) => window.fufu.invoke('bots:get', id), id);
    console.log(`    status=${v.config.status} phase=${v.phase} trades=${v.account.trades} simTrades=${v.sim?.trades.length} steps=${v.config.state?.steps} lastErr=${v.config.lastError || ''}`);
    check(v.config.status === 'running', `bot still running (${v.phaseText})`);
    check(v.config.state.steps >= 20, `evaluated every second (${v.config.state.steps} steps in 30 s)`);
    check(v.account.trades >= 8, `account traded (${v.account.trades} closed trades)`);
    const sim = v.sim.trades.length;
    check(Math.abs(sim - v.account.trades) <= 1, `account trades match the strategy (${v.account.trades} vs ${sim} simulated)`);
    const hist = await page.evaluate((id) => window.fufu.invoke('trading:history', id), id);
    const errs = hist.events.filter((e) => e.kind === 'error' || e.kind === 'reject');
    check(errs.length === 0, `no order errors (${errs.map((e) => e.message).slice(0, 3).join(' | ')})`);
    const notes = hist.events.filter((e) => /outside the strategy|below the minimum/.test(e.message));
    check(notes.length === 0, `no drift between account and strategy (${notes.map((e) => e.message).slice(0, 2).join(' | ')})`);
    await page.evaluate((id) => window.fufu.invoke('bots:stop', id, { close: true }), id);
    const after = await page.evaluate((id) => window.fufu.invoke('bots:get', id), id);
    check(after.config.status === 'stopped' && after.account.position === 0 && after.account.openOrders === 0, 'stopped flat without orders');
  },
  async replay() {
    console.log('scenario: replay');
    const iso = (t) => (t ? new Date(t).toISOString().slice(0, 19) : String(t));
    // an indicator and a strategy on the chart must run on replay data only
    await page.locator('button:has-text("Indicators")').first().click();
    await page.waitForSelector('.picker-row', { timeout: 15000 });
    for (const q of ['Relative Strength', 'MA Crossover Strategy']) {
      await page.fill('.picker-main input', q);
      await wait(150);
      await page.keyboard.press('Enter');
      await wait(150);
    }
    // open interest follows the replay clock too
    await page.fill('.picker-main input', 'Open Interest');
    await page.locator('.picker-row .picker-name', { hasText: /^Open Interest$/ }).click();
    await wait(150);
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => [...document.querySelectorAll('.pane-legend .ind-item')].some((r) => /RSI/.test(r.textContent || '') && /\d+\.\d+/.test(r.textContent || '')), null, { timeout: 30000 });
    const ids = await page.evaluate(() => Object.keys(window.__charts || {}));
    const id = ids[0];
    const before = await page.evaluate((id) => window.__charts[id].bars(), id);
    await page.locator('.stack-head button:has-text("Replay")').first().click();
    const box = await page.locator('.chart-host').first().boundingBox();
    await wait(300);
    await page.mouse.click(box.x + box.width * 0.45, box.y + box.height * 0.45);
    await page.waitForSelector('.replay-bar', { timeout: 20000 });
    check(true, 'replay started from a picked bar');
    const v0 = await page.evaluate(() => window.fufu.invoke('replay:get'));
    await page.waitForFunction(([id, last]) => { const b = window.__charts[id].bars(); return b.n > 50 && b.last < last; }, [id, before.last], { timeout: 30000 });
    const b0 = await page.evaluate((id) => window.__charts[id].bars(), id);
    check(b0.last < v0.cursor && b0.last < before.last, `chart cut at the replay point (last bar ${iso(b0.last)} < cursor ${iso(v0.cursor)}, live last ${iso(before.last)})`);
    await page.click('.replay-bar button[data-tip^="Forward one"]');
    await page.waitForFunction(([id, last]) => window.__charts[id].bars().last > last, [id, b0.last], { timeout: 20000 });
    const b1 = await page.evaluate((id) => window.__charts[id].bars(), id);
    const v1 = await page.evaluate(() => window.fufu.invoke('replay:get'));
    check(b1.last < v1.cursor, `step revealed one more bar (${iso(b1.last)}), cursor ${iso(v1.cursor)}`);
    // trade on the replayed prices
    await page.click('.replay-bar .btn.buy');
    await page.waitForFunction(() => /L [\d.]/.test(document.querySelector('.replay-pnl')?.textContent || ''), null, { timeout: 15000 });
    check(true, 'replay buy filled; position shown in the replay bar');
    // play at 15 min/s
    await page.click('.replay-bar button[data-tip^="Playback speed"]');
    await page.click('.menu-item:has-text("15 min / s")');
    await page.click('.replay-bar button[data-tip^="Play"]');
    await wait(4000);
    await page.click('.replay-bar button[data-tip^="Pause"]');
    const v2 = await page.evaluate(() => window.fufu.invoke('replay:get'));
    const b2 = await page.evaluate((id) => window.__charts[id].bars(), id);
    check(v2.cursor - v1.cursor > 20 * 60000, `played forward ${Math.round((v2.cursor - v1.cursor) / 60000)} min in 4 s (interval ${v2.interval})`);
    check(b2.last < v2.cursor && b2.last > b1.last, `chart follows the replay without future bars (${iso(b2.last)} < ${iso(v2.cursor)})`);
    const acct = await page.evaluate((v) => window.fufu.invoke('trading:snapshot', v.accounts.spot), v2);
    check(acct.positions.length === 1 && Math.abs(acct.positions[0].mark - b2.close) / b2.close < 0.01, `replay position marked at replay prices (mark ${acct.positions[0]?.mark}, chart close ${b2.close})`);
    const lv = await page.evaluate(() => [...document.querySelectorAll('.ind-item')].map((x) => x.textContent || '').join(' | '));
    const errs = await page.$$eval('.ind-err', (e) => e.map((x) => x.textContent));
    check(errs.length === 0 && /RSI/.test(lv) && /trades/.test(lv), `indicator and strategy run on replay data (${lv.replace(/\s+/g, ' ').slice(0, 140)})`);
    await page.waitForFunction(() => [...document.querySelectorAll('.ind-item')].some((r) => /Open Interest/.test(r.textContent || '') && /C \d+(\.\d+)?K/.test(r.textContent || '')), null, { timeout: 60000 });
    check(true, 'open interest runs on the replay clock');
    const notice = await page.textContent('.ob .replay-notice').catch(() => '');
    check(/Live/.test(notice || ''), 'order book is marked as live data during the replay');
    // the trade panel trades the replay account at replay prices: a limit order below the replay price
    check(await page.isVisible('.badge:has-text("Replay account")'), 'trade panel switched to the replay account');
    await shot('21-replay');
    await page.click('.replay-bar button:has-text("Close")');
    await page.waitForFunction(() => !/L [\d.]/.test(document.querySelector('.replay-pnl')?.textContent || ''), null, { timeout: 15000 });
    const hist = await page.evaluate((v) => window.fufu.invoke('trading:history', v.accounts.spot), v2);
    check(hist.trades.length >= 1 && hist.trades.at(-1).closedAt <= v2.cursor + 1000, `replay trade closed at replay time (${iso(hist.trades.at(-1)?.closedAt)})`);
    // live accounts are not affected and replay accounts are hidden from account lists
    const list = await page.evaluate(() => window.fufu.invoke('trading:list'));
    check(!list.some((a) => a.config.replay), 'replay accounts are not listed with live accounts');
    // the session report lists the replay trade
    await page.click('.replay-bar button[data-tip^="Session report"]');
    await page.waitForSelector('.modal .replay-report', { timeout: 15000 });
    const rr = await page.textContent('.modal .replay-report');
    check(/Win rate/.test(rr || '') && /Trades/.test(rr || ''), `replay session report (${(rr || '').replace(/\s+/g, ' ').slice(0, 90)})`);
    await wait(400);
    await shot('21b-replay-report');
    await page.keyboard.press('Escape');
    await page.click('.replay-bar button[data-tip^="Exit replay"]');
    await page.waitForSelector('.replay-bar', { state: 'detached', timeout: 10000 });
    // the report appears again when leaving a replay with trades
    await page.waitForSelector('.modal .replay-report', { timeout: 15000 });
    check(true, 'leaving the replay shows the session report');
    await page.keyboard.press('Escape');
    await page.waitForFunction(([id, last]) => window.__charts[id].bars().last >= last, [id, before.last], { timeout: 30000 });
    check(true, 'exit replay returns the chart to live data');
  },
  async alerts() {
    console.log('scenario: alerts');
    await page.keyboard.press('Control+k');
    await page.waitForSelector('.palette input');
    await page.fill('.palette input', 'Add Alerts');
    await page.keyboard.press('Enter');
    await page.waitForSelector('.alerts', { timeout: 15000 });
    // price alert via the editor: "is above" a level below the market fires on the next trade
    await page.click('.stack-head button:has-text("New alert")');
    await page.click('.menu-item:has-text("Price level")');
    await page.waitForSelector('.alert-editor');
    await page.waitForFunction(() => [...document.querySelectorAll('.alert-editor button')].some((b) => /^now /.test(b.textContent || '')), null, { timeout: 15000 });
    const last = await page.evaluate(() => window.fufu.invoke('market:lastPrice', 'BTCUSDT', 'spot'));
    await page.selectOption('.alert-editor .ae-row:has-text("Condition") select', 'above').catch(async () => {
      await page.click('.alert-editor .ae-row:has-text("Condition") .select');
    });
    const price = page.locator('.alert-editor .ae-row:has-text("Price") input').first();
    await price.fill(String(Math.round(last - 500)));
    await price.press('Tab');
    await shot('22-alert-editor');
    await page.click('.modal button:has-text("Create alert")');
    await page.waitForFunction(() => [...document.querySelectorAll('.toast')].some((t) => /🔔/.test(t.textContent || '')), null, { timeout: 30000 });
    check(true, 'price alert fired on live trades (toast)');
    // indicator and order-book alerts through the API
    const res = await page.evaluate(async () => {
      const f = window.fufu.invoke;
      const scripts = await f('scripts:list');
      const rsi = scripts.find((s) => /Relative Strength/.test(s.name));
      const doc = await f('scripts:get', rsi.id);
      const an = await f('scripts:analyze', doc.language, doc.code, { symbol: 'BTCUSDT', market: 'spot', tf: '1m', chartType: 'candles' });
      const base = { name: '', symbol: 'BTCUSDT', market: 'spot', enabled: true, cooldownSec: 0, notify: { desktop: false, sound: false }, triggerCount: 0, status: 'active' };
      await f('alerts:save', { ...base, kind: 'indicator', frequency: 'once', scriptId: rsi.id, inputs: {}, tf: '1m', chartType: 'candles', onBarClose: false, plot: an.plots[0].id, plotTitle: an.plots[0].title, condition: 'above', target: { type: 'value', value: 1 } });
      await f('alerts:save', { ...base, kind: 'book', frequency: 'once', metric: 'spreadBps', condition: 'above', value: 0, rangePct: 1, sustainSec: 0 });
      return an.plots.length;
    });
    check(res > 0, 'RSI plots known from the script analysis');
    let log = [];
    for (let k = 0; k < 60; k++) {
      log = await page.evaluate(() => window.fufu.invoke('alerts:log'));
      if (log.some((e) => e.kind === 'indicator') && log.some((e) => e.kind === 'book')) break;
      await wait(1000);
    }
    check(log.some((e) => e.kind === 'indicator' && /RSI/.test(e.message)), `indicator alert fired (${log.find((e) => e.kind === 'indicator')?.message})`);
    check(log.some((e) => e.kind === 'book' && /spread/.test(e.message)), `order-book alert fired (${log.find((e) => e.kind === 'book')?.message})`);
    // futures data: funding above -1% holds at once and fires from the live feed
    const fut = await page.evaluate(() =>
      window.fufu.invoke('alerts:save', { id: '', name: '', kind: 'futures', symbol: 'BTCUSDT', market: 'futures', enabled: true, frequency: 'once', cooldownSec: 60, expiresAt: null, message: '', notify: { desktop: false, sound: false }, created: 0, updated: 0, triggerCount: 0, status: 'active', metric: 'funding', condition: 'above', value: -1, minutes: 5 }),
    );
    let futEv = null;
    for (let k = 0; k < 60 && !futEv; k++) {
      await wait(500);
      futEv = (await page.evaluate(() => window.fufu.invoke('alerts:log'))).find((e) => e.alertId === fut.id);
    }
    check(!!futEv && /funding/.test(futEv.message), `futures-data alert fired (${futEv?.message})`);
    // chart right-click: alert at a price, drawn on the chart
    const box = await page.locator('.chart-host').first().boundingBox();
    await page.mouse.click(box.x + box.width * 0.5, box.y + box.height * 0.3, { button: 'right' });
    await page.click('.menu-item:has-text("Add alert at")');
    await page.waitForFunction(() => [...document.querySelectorAll('.toast')].some((t) => /Alert created/.test(t.textContent || '')), null, { timeout: 10000 });
    const list = await page.evaluate(() => window.fufu.invoke('alerts:list'));
    const fromChart = list.find((a) => a.kind === 'price' && a.enabled);
    check(!!fromChart, `alert created from the chart (${fromChart ? fromChart.condition + ' ' + fromChart.level : 'none'})`);
    await page.click('.alerts .tabs .tab:has-text("Log")');
    await page.waitForSelector('.alert-log-row');
    const rows = await page.$$eval('.alert-log-row', (r) => r.length);
    check(rows >= 3, `alert log lists triggers (${rows})`);
    await shot('23-alerts-log');
    await page.click('.alerts .tabs .tab:has-text("Alerts")');
    await page.waitForSelector('.alert-row');
    const n0 = await page.$$eval('.alert-row', (r) => r.length);
    check(n0 === 5, `five alerts listed (${n0})`);
    await page.locator('.alert-row').first().locator('.toggle').click();
    await wait(400);
    const states = await page.evaluate(() => window.fufu.invoke('alerts:list').then((l) => l.map((a) => a.enabled)));
    check(states.filter(Boolean).length === 0, 'switching an alert off works (all off now)');
    await shot('24-alerts');
  },
  async ai() {
    console.log('scenario: ai (Claude Code with a small model)');
    await page.keyboard.press('Control+k');
    await page.waitForSelector('.palette input');
    await page.fill('.palette input', 'Add AI Studio');
    await page.keyboard.press('Enter');
    await page.waitForSelector('.ai-studio', { timeout: 15000 });
    await page.waitForSelector('.ai-new .ai-input', { timeout: 15000 });
    const missing = await page.$('.ai-missing');
    check(!missing, 'Claude Code CLI detected');
    await shot('25-ai-new');
    // small model, low effort, build mode
    await page.selectOption('.ai-composer select[data-tip="Model"], .ai-composer select', 'haiku').catch(() => {});
    const sels = await page.$$('.ai-composer select');
    if (sels[0]) await sels[0].selectOption('haiku');
    if (sels[1]) await sels[1].selectOption('low');
    await page.fill('.ai-input', 'Create a Pine Script v5 indicator named "AI SMA Test" that plots a 20-period SMA of close. Check it compiles, save it with save_script, then add it to the chart with show_in_app. Keep the final answer to one sentence.');
    await page.keyboard.press('Enter');
    await page.waitForSelector('.ai-chat', { timeout: 20000 });
    check(true, 'chat started');
    // wait for Claude to finish (meta line appears when done)
    await page.waitForFunction(() => !!document.querySelector('.ai-msg.assistant .ai-meta') || !!document.querySelector('.ai-msg.assistant .ai-error'), null, { timeout: 240000, polling: 1000 });
    const err = await page.$eval('.ai-msg.assistant .ai-error', (e) => e.textContent).catch(() => null);
    check(!err, `Claude finished without error ${err || ''}`);
    const tools = await page.$$eval('.ai-tool', (els) => els.map((e) => e.textContent || ''));
    console.log('    tools:', tools.map((t) => t.replace(/\s+/g, ' ').slice(0, 60)).join(' | '));
    check(tools.some((t) => /Compiles|Checking/.test(t)), 'Claude checked the code with the app tool');
    check(tools.some((t) => /Saved/.test(t)), 'Claude saved the script to the library');
    const scripts = await page.evaluate(() => window.fufu.invoke('scripts:list'));
    const made = scripts.find((x) => /AI SMA Test/i.test(x.name));
    check(!!made, `script saved in the library (${made?.name})`);
    await wait(1500);
    const legend = await page.evaluate(() => [...document.querySelectorAll('.ind-item')].map((x) => x.textContent || '').join(' | '));
    check(/SMA/i.test(legend), `script shown on the chart (${legend.slice(0, 80)})`);
    await shot('26-ai-chat');
    // second turn (resumes the Claude session): a real backtest through the app
    const n0 = await page.$$eval('.ai-msg.assistant', (e) => e.length);
    await page.fill('.ai-input', 'Now backtest the built-in "MA Crossover Strategy" on ETHUSDT spot 4h over the last 180 days and give me its net profit and buy & hold in one sentence.');
    await page.keyboard.press('Enter');
    await page.waitForFunction((n) => document.querySelectorAll('.ai-msg.assistant').length > n && !!document.querySelectorAll('.ai-msg.assistant')[n].querySelector('.ai-meta, .ai-error'), n0, { timeout: 300000, polling: 1000 });
    const err2 = await page.$$eval('.ai-msg.assistant', (e) => e[e.length - 1].querySelector('.ai-error')?.textContent || null);
    check(!err2, `second turn finished ${err2 || ''}`);
    const kpis = await page.$$eval('.ai-kpis', (e) => e.map((x) => x.textContent || ''));
    check(kpis.some((t) => /Net profit/.test(t) && /Buy & hold/.test(t)), `backtest card with KPIs (${(kpis[0] || '').replace(/\s+/g, ' ').slice(0, 90)})`);
    const runs = await page.evaluate(() => window.fufu.invoke('backtests:list'));
    check(runs.some((r) => r.request.symbol === 'ETHUSDT' && r.request.tf === '4h'), 'backtest recorded in the Strategy Tester history');
    await shot('27-ai-backtest');
  },
  async aitools() {
    console.log('scenario: AI tools (called directly, without Claude)');
    const call = (name, args) => page.evaluate(([n, a]) => window.fufu.invoke('ai:testTool', n, a), [name, args]);
    const bt = await call('backtest', { id: 'builtin:strat_ma_cross', symbol: 'BTCUSDT', tf: '4h', days: 365 });
    const m = bt.result.metrics;
    check(bt.result.ok && m.exposurePct >= 0 && m.exposurePct <= 100 && Math.abs(m.cagrPct) < 1000, `backtest units (exposure ${m.exposurePct}%, CAGR ${m.cagrPct}%)`);
    check(!!m.greeks && typeof m.greeks.beta === 'number', `Greeks for the AI (alpha ${m.greeks?.alphaPctPerYear}%/yr, beta ${m.greeks?.beta})`);
    check(bt.result.liveReplay?.reproducibleLive === true && bt.result.liveReplay.replayedRecentBars > 20, `live replay for the AI: reproducible ${bt.result.liveReplay?.reproducibleLive} (${bt.result.liveReplay?.replayedRecentBars} bars)`);
    check(!!m.vsRandom && m.vsRandom.twins >= 200, `random twins for the AI: ${m.vsRandom?.verdict} (beats ${m.vsRandom?.timing.beatsReturnPct}%, p ${m.vsRandom?.timing.pReturn})`);
    const run = await call('run_script', { id: 'builtin:rsi', symbol: 'BTCUSDT', tf: '1h', bars: 2000 });
    check(run.result.ok && run.result.plots.some((p) => typeof p.icNext5Bars === 'number'), `information coefficient (${run.result.plots.map((p) => `${p.title}: ${p.icNext5Bars}`).join(', ')})`);
    const rb = await call('robustness_test', { id: 'builtin:strat_ma_cross', symbol: 'BTCUSDT', tf: '4h', days: 365 });
    const s = rb.result.summary;
    check(rb.result.runs.length === 8 && s.runs >= 6, `robustness: ${s.verdict}, ${s.runs} runs, profitable ${s.profitablePct}%, beat random ${s.beatRandomPct}%, median Sharpe ${s.medianSharpe}`);
    console.log('    ' + rb.result.runs.map((r) => `${r.label}: ${r.error || `${r.returnPct}% (B&H ${r.buyHoldPct}%)`}`).join(' | '));
    const hist = await page.evaluate(() => window.fufu.invoke('backtests:list'));
    check(!hist.some((h) => h.label === 'robustness'), 'robustness runs stay out of the Strategy Tester history');
    const accts = await call('review_trades', {});
    check(Array.isArray(accts.result.accounts), `Claude lists paper accounts for a review (${accts.result.accounts.length})`);
    if (accts.result.accounts.length) {
      const rv = await call('review_trades', { accountId: accts.result.accounts[0].id });
      check(!!rv.result.overall && !!rv.result.bySide && 'within30minAfterALoss' in rv.result, `trade review data (${rv.result.overall.trades} trades)`);
    }
    // open interest as script data in a backtest: 400 days span Binance's REST window and its daily archives
    const t0 = Date.now();
    const oiBt = await call('backtest', { id: 'builtin:strat_oi_breakout', symbol: 'BTCUSDT', market: 'futures', tf: '1h', days: 400 });
    check(oiBt.result.ok && oiBt.result.metrics.trades > 0 && !oiBt.result.warnings.some((w) => /No open interest/.test(w)), `OI Breakout backtest on BINANCE:BTCUSDT.P_OI (${oiBt.result.ok ? `${oiBt.result.metrics.trades} trades, ${oiBt.result.metrics.netProfitPct}%` : oiBt.result.error}, ${Math.round((Date.now() - t0) / 1000)} s)`);
    const pyOi = await call('run_script', {
      language: 'python',
      code: ['# @name OI check', 'from fufu import *', '', '', "@indicator('OI check')", 'def main(data):', "    oi = data.security('BTCUSDT.P_OI', '1h')", "    plot(oi, 'Open interest')", ''].join(String.fromCharCode(10)),
      symbol: 'BTCUSDT',
      market: 'futures',
      tf: '1h',
      bars: 500,
    });
    const pyLast = pyOi.result.plots?.[0]?.last?.slice(-1)[0];
    check(pyOi.result.ok && pyLast > 1000, `Python reads open interest with data.security('BTCUSDT.P_OI') (last ${pyLast})`);
    const fr = await call('run_script', { id: 'builtin:funding_rate', symbol: 'ETHUSDT', market: 'futures', tf: '1h', bars: 1000 });
    const frLast = fr.result.plots?.find((p) => p.title === 'Funding')?.last?.slice(-1)[0];
    check(fr.result.ok && Math.abs(frLast) > 0 && Math.abs(frLast) < 1, `Funding Rate indicator on BINANCE:ETHUSDT.P_FUNDING (last ${frLast}% per 8 h)`);
    const fs30 = await call('futures_snapshot', { symbol: 'BTCUSDT' });
    const h30 = fs30.result.history30d;
    check(typeof h30?.openInterestValueBnUsdt?.changePct === 'number' && h30?.fundingPctPer8h?.percentileNow >= 0 && h30?.longShortRatio?.max >= h30?.longShortRatio?.min, `futures snapshot with 30-day positioning (OI ${h30?.openInterestValueBnUsdt?.changePct}% in 30 d, funding at the ${h30?.fundingPctPer8h?.percentileNow}th percentile)`);
    const saved = await call('get_backtest', { id: bt.result.recordId });
    check(saved.result.ok && saved.result.metrics?.vsRandom && saved.result.request?.tf === '4h', `Claude can read a saved backtest (${saved.result.label})`);
    // Claude prepares a paper bot: the dialog opens prefilled, the bot is set up with the strategy
    await call('show_in_app', { action: 'create_bot', id: 'builtin:strat_ma_cross', symbol: 'ETHUSDT', market: 'spot', tf: '4h', inputs: {} });
    await page.waitForSelector('.modal:has-text("New paper account")', { timeout: 10000 });
    const nameVal = await page.inputValue('.modal input[type=text], .modal input:not([type])').catch(() => '');
    check(/MA Crossover Strategy bot/.test(nameVal), `bot dialog prefilled (${nameVal})`);
    await page.click('.modal button:has-text("Create account")');
    await page.waitForSelector('.bot-setup', { timeout: 15000 });
    const setup = await page.textContent('.bot-setup');
    check(/MA Crossover/.test(setup || '') && /ETH/.test(setup || ''), 'bot set up with the strategy and instrument from Claude');
    await shot('28b-ai-bot');
  },
  async footprint() {
    console.log('scenario: footprint');
    const id = await page.evaluate(() => Object.keys(window.__charts || {})[0]);
    await page.locator('.stack-head button.tab:has-text("1m")').first().click();
    await page.locator('.stack-head button[data-tip^="Chart type"]').first().click();
    await page.click('.menu-item:has-text("Footprint")');
    await page.waitForFunction((id) => window.__charts[id].footprint() > 5, id, { timeout: 120000, polling: 1000 });
    const n = await page.evaluate((id) => window.__charts[id].footprint(), id);
    check(n > 5, `footprint bars built from aggregate trades (${n})`);
    await wait(2500);
    await shot('28-footprint');
    const n2 = await page.evaluate((id) => window.__charts[id].footprint(), id);
    check(n2 >= n, 'footprint keeps updating live');
  },
  async news() {
    console.log('scenario: news & data');
    await page.keyboard.press('Control+k');
    await page.waitForSelector('.palette input');
    await page.fill('.palette input', 'Add News');
    await page.keyboard.press('Enter');
    await page.waitForSelector('.news', { timeout: 15000 });
    await page.waitForFunction(() => document.querySelectorAll('.news-item').length > 5, null, { timeout: 45000 });
    const n = await page.$$eval('.news-item', (e) => e.length);
    check(n > 5, `headlines loaded from the feeds (${n})`);
    await page.click('.stack-head .seg button:has-text("BTC")');
    await wait(300);
    const btc = await page.$$eval('.news-item', (e) => e.map((x) => x.querySelector('.coin-chip.btc') !== null));
    check(btc.length > 0 && btc.every(Boolean), `BTC filter shows only BTC headlines (${btc.length})`);
    await shot('29-news');
    await page.keyboard.press('Control+k');
    await page.waitForSelector('.palette input');
    await page.fill('.palette input', 'Add Data');
    await page.keyboard.press('Enter');
    await page.waitForSelector('.data-mod', { timeout: 15000 });
    await page.waitForSelector('.data-row', { timeout: 15000 });
    const rows = await page.$$eval('.data-row', (e) => e.length);
    check(rows > 0, `cached data listed (${rows} rows)`);
    await shot('30-data');
  },
  async drawings() {
    console.log('scenario: drawings');
    const id = await page.evaluate(() => Object.keys(window.__charts || {})[0]);
    const before = await page.evaluate((id) => window.__charts[id].drawings().length, id);
    const box = await page.locator('.chart-host').first().boundingBox();
    // a ray with two clicks (it continues to the right, so an alert can follow it)
    await page.locator('button[data-tip^="Ray"]').first().click();
    const a = { x: box.x + box.width * 0.35, y: box.y + box.height * 0.62 };
    const b = { x: box.x + box.width * 0.6, y: box.y + box.height * 0.42 };
    await page.mouse.click(a.x, a.y);
    await page.mouse.click(b.x, b.y);
    await page.waitForFunction(([id, n]) => window.__charts[id].drawings().length === n + 1, [id, before], { timeout: 5000 });
    const d = (await page.evaluate((id) => window.__charts[id].drawings(), id)).at(-1);
    check(d.type === 'ray', 'ray drawn with two clicks');
    await shot('47-drawing');
    // right-click on the line: alert that follows it
    const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    await page.mouse.click(mid.x, mid.y, { button: 'right' });
    await page.click('.menu-item:has-text("Add alert on this line")');
    await page.waitForSelector('.alert-editor .ae-row:has-text("Trendline")', { timeout: 10000 });
    check(true, 'the alert editor opens on the trendline');
    await wait(500);
    await shot('48-trendline-alert');
    await page.click('.modal button:has-text("Create alert")');
    await page.waitForSelector('.modal', { state: 'detached', timeout: 10000 });
    const alerts = await page.evaluate(() => window.fufu.invoke('alerts:list'));
    const la = alerts.find((x) => x.kind === 'price' && x.line);
    check(!!la && la.line.extend === 'right' && la.level > 0, `trendline alert saved (${la ? `${la.line.p1.toFixed(0)} → ${la.line.p2.toFixed(0)}, now at ${la.level.toFixed(0)}` : 'missing'})`);
    // lock, duplicate and delete through the context menu
    await page.mouse.click(mid.x, mid.y, { button: 'right' });
    await page.click('.menu-item:has-text("Lock")');
    await page.waitForFunction((id) => window.__charts[id].drawings().at(-1).locked, id, { timeout: 5000 });
    await page.mouse.click(mid.x, mid.y, { button: 'right' });
    check(await page.isVisible('.menu-item.disabled:has-text("Delete")'), 'a locked drawing cannot be deleted');
    await page.click('.menu-item:has-text("Duplicate")');
    await page.waitForFunction(([id, n]) => window.__charts[id].drawings().length === n + 2, [id, before], { timeout: 5000 });
    check(true, 'drawing duplicated');
    await page.mouse.click(mid.x, mid.y, { button: 'right' });
    await page.click('.menu-item:has-text("Unlock")');
    await page.mouse.click(mid.x, mid.y, { button: 'right' });
    await page.click('.menu-item:has-text("Delete")');
    await page.waitForFunction(([id, n]) => window.__charts[id].drawings().length === n + 1, [id, before], { timeout: 5000 });
    check(true, 'drawing deleted after unlocking');
    await page.evaluate((aid) => window.fufu.invoke('alerts:delete', aid), la?.id);
    // the "+" beside the price axis follows the crosshair: orders, an alert or a line at that price
    await page.mouse.move(box.x + box.width * 0.5, box.y + box.height * 0.3);
    await page.waitForSelector('.chart-plus', { timeout: 5000 });
    await page.click('.chart-plus');
    await page.waitForSelector('.menu-item:has-text("Horizontal line at")', { timeout: 5000 });
    const plusItems = await page.$$eval('.menu-item', (e) => e.map((x) => (x.textContent || '').trim()));
    check(plusItems.some((t) => /Add alert at/.test(t)) && plusItems.some((t) => /Buy|Sell|paper account|trades/.test(t)), `"+" offers trading, an alert and a line (${plusItems.join(' | ').slice(0, 140)})`);
    const n0 = await page.evaluate((id) => window.__charts[id].drawings().length, id);
    await page.click('.menu-item:has-text("Horizontal line at")');
    await page.waitForFunction(([id, n]) => window.__charts[id].drawings().length === n + 1, [id, n0], { timeout: 5000 });
    check(true, 'horizontal line added from the "+" menu');
    // drag into the past: a button brings the chart back to the latest bar
    await page.mouse.move(box.x + box.width * 0.2, box.y + box.height * 0.55);
    await page.mouse.down();
    for (let k = 1; k <= 12; k++) await page.mouse.move(box.x + box.width * (0.2 + k * 0.05), box.y + box.height * 0.55);
    await page.mouse.up();
    await page.waitForSelector('.chart-latest', { timeout: 5000 });
    await shot('49-chart-navigation');
    await page.click('.chart-latest');
    await page.waitForSelector('.chart-latest', { state: 'detached', timeout: 5000 });
    check(true, 'dragged into the past and back to the latest bar with one click');
    // candlestick patterns from the command palette; running it again opens the pattern choice
    const palette = async (q) => {
      await page.keyboard.press('Control+k');
      await page.waitForSelector('.palette input');
      await page.fill('.palette input', q);
      await wait(150);
      await page.keyboard.press('Enter');
    };
    await palette('candlestick patterns');
    await page.waitForFunction(() => [...document.querySelectorAll('.ind-item')].some((r) => /Patterns/.test(r.textContent || '') && !r.querySelector('.spinner')), null, { timeout: 30000 });
    const pErr = await page.$$eval('.ind-err', (e) => e.map((x) => x.textContent));
    check(!pErr.length, `candlestick patterns run on the chart ${pErr.length ? JSON.stringify(pErr) : ''}`);
    await palette('candlestick patterns');
    await page.waitForSelector('.modal:has-text("Engulfing (EG)")', { timeout: 10000 });
    const choice = await page.textContent('.modal');
    check(/Spinning top/.test(choice || '') && /Prior trend/.test(choice || ''), 'pattern settings: choose the patterns and the trend filter');
    await shot('50-candlestick-patterns');
    await page.keyboard.press('Escape');
  },
  async derivatives() {
    console.log('scenario: derivatives');
    await page.keyboard.press('Control+k');
    await page.waitForSelector('.palette input');
    await page.fill('.palette input', 'Add Derivatives');
    await page.keyboard.press('Enter');
    await page.waitForSelector('.deriv', { timeout: 15000 });
    await page.waitForFunction(() => document.querySelectorAll('.deriv-card .dc-value').length >= 4, null, { timeout: 45000 });
    const vals = await page.$$eval('.deriv-card .dc-value', (e) => e.map((x) => x.textContent || ''));
    check(/\$\d/.test(vals[0]) && /%/.test(vals[1]), `open interest, funding, long/short and taker data (${vals.join(' | ')})`);
    await page.waitForFunction(() => !!document.querySelector('.deriv-card .spark path'), null, { timeout: 30000 });
    check(true, 'open interest history drawn');
    await wait(1500);
    await shot('29b-derivatives');
    // positioning history from the futures data series (price vs open interest, ratios, funding)
    await page.waitForFunction(() => (document.querySelector('.deriv-history')?.getAttribute('data-loaded') || '').split(' ').length === 5, null, { timeout: 120000, polling: 500 });
    await page.evaluate(() => document.querySelector('.deriv-history')?.scrollIntoView());
    await wait(1500);
    check((await page.$$eval('.deriv-history canvas', (c) => c.length)) === 3, 'positioning history: price vs open interest, long/short ratios and funding');
    await shot('29d-positioning-history');
    // open interest as script data: the TradingView-style built-in reads BINANCE:<symbol>.P_OI
    await page.locator('button:has-text("Indicators")').first().click();
    await page.waitForSelector('.picker-row', { timeout: 15000 });
    await page.fill('.picker-main input', 'Open Interest');
    await page.locator('.picker-row .picker-name', { hasText: /^Open Interest$/ }).click();
    await wait(200);
    await page.keyboard.press('Escape');
    // the legend shows the open interest value (about 90K BTC), not just the MA length input
    await page.waitForFunction(() => [...document.querySelectorAll('.ind-item')].some((r) => /Open Interest/.test(r.textContent || '') && /\d\d(\.\d+)?\s?K/.test(r.textContent || '')), null, { timeout: 120000, polling: 500 });
    const oi = await page.$$eval('.ind-item', (rows) => rows.map((r) => r.textContent || '').filter((t) => /Open Interest/.test(t)));
    const oiErr = await page.$$eval('.ind-err', (e) => e.map((x) => x.textContent));
    // the newest one (the replay scenario may have added another); no zeros where the script plots na
    const last = oi[oi.length - 1] || '';
    check(!oiErr.length && /\d\d(\.\d+)?\s?K/.test(last) && !/0\.000/.test(last), `Open Interest indicator runs on the perpetual's statistics (${last.slice(0, 80)}${oiErr.length ? ` errors ${JSON.stringify(oiErr)}` : ''})`);
    await wait(800);
    await shot('29c-open-interest');
    // the Data Manager lists the futures statistics and funding caches next to the candles
    await page.keyboard.press('Control+k');
    await page.waitForSelector('.palette input');
    await page.fill('.palette input', 'Add Data');
    await page.keyboard.press('Enter');
    await page.waitForSelector('.data-mod .data-row', { timeout: 15000 });
    const kinds = await page.$$eval('.data-mod .data-row', (e) => e.map((x) => x.textContent || '').join(' | '));
    check(/futures statistics/.test(kinds) && /funding rates/.test(kinds), 'Data Manager lists futures statistics and funding rates');
  },
  async prop() {
    console.log('scenario: prop challenges');
    await page.keyboard.press('Control+k');
    await page.waitForSelector('.palette input');
    await page.fill('.palette input', 'Add Prop Challenges');
    await page.keyboard.press('Enter');
    await page.waitForSelector('.prop-mod', { timeout: 15000 });
    await page.click('.prop-mod button:has-text("Start a challenge")');
    await page.waitForSelector('.modal');
    check(await page.isVisible('.modal .seg button.on:has-text("Prop-firm rules")'), 'prop template preselected');
    await page.click('.modal button:has-text("Create account")');
    await page.waitForSelector('.prop-card', { timeout: 15000 });
    const card = await page.textContent('.prop-card');
    check(/FTMO|LUCID/.test(card || '') && /Active/.test(card || ''), `challenge card shows firm and status (${(card || '').replace(/\s+/g, ' ').slice(0, 90)})`);
    // the new challenge is selected right away and shows every rule
    await page.waitForSelector('.prop-detail .progress', { timeout: 10000 });
    check(await page.isVisible('.prop-card.on'), 'new challenge selected with its rule detail');
    await page.click('.prop-card');
    await page.waitForSelector('.prop-detail', { state: 'detached', timeout: 5000 });
    check(true, 'clicking the card again collapses the detail');
    await page.click('.prop-mod .tabs .tab:has-text("Programs")');
    const programs = await page.$$eval('.prop-programs .card', (e) => e.length);
    check(programs >= 3, `supported programs listed (${programs})`);
    await shot('31-prop');
  },
  async builder() {
    console.log('scenario: strategy builder');
    await page.keyboard.press('Control+k');
    await page.waitForSelector('.palette input');
    await page.fill('.palette input', 'Add Strategy Builder');
    await page.keyboard.press('Enter');
    await page.waitForSelector('.builder', { timeout: 15000 });
    await page.click('.builder-bar button:has-text("Templates")');
    await page.click('.menu-item:has-text("RSI mean reversion")');
    await page.waitForFunction(() => /ta\.rsi/.test(document.querySelector('.code-pre')?.textContent || ''), null, { timeout: 10000 });
    check(true, 'template loaded; Pine code generated');
    await page.waitForFunction(() => /compiles/.test(document.querySelector('.code-head')?.textContent || ''), null, { timeout: 20000 });
    check(true, 'generated Pine compiles');
    // edit: change the RSI entry level from 30 to 25
    await page.locator('.flow-node.t-long .operand.value').first().click();
    const val = page.locator('.popover input').first();
    await val.fill('25');
    await val.press('Tab');
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => /crossover\(x_rsi_14_close, 25\)/.test(document.querySelector('.code-pre')?.textContent || ''), null, { timeout: 10000 });
    check(true, 'editing a condition updates the code');
    // Python output compiles too
    await page.click('.builder-bar .seg button:has-text("Python")');
    await page.waitForFunction(() => /class .*\(Strategy\)/.test(document.querySelector('.code-pre')?.textContent || ''), null, { timeout: 10000 });
    await page.waitForFunction(() => /compiles/.test(document.querySelector('.code-head')?.textContent || ''), null, { timeout: 120000 });
    check(true, 'generated Python compiles');
    await page.click('.builder-bar .seg button:has-text("Pine Script")');
    await shot('32-builder');
    await page.click('.builder-bar button:has-text("Backtest")');
    await page.waitForSelector('.tester', { timeout: 15000 });
    await page.waitForFunction(() => document.querySelectorAll('.tester .kpi, .tester .stat').length > 3, null, { timeout: 180000 });
    check(true, 'builder strategy saved and backtested in the Strategy Tester');
    await shot('33-builder-backtest');
  },
  async help() {
    console.log('scenario: help');
    await page.click('.titlebar button[data-tip^="Help"], button[data-tip^="Help: documentation"]');
    await page.click('.menu-item:has-text("Pine Script built-ins")');
    await page.waitForFunction(() => /ta\.sma\(source, length\)/.test(document.querySelector('.doc-body')?.textContent || ''), null, { timeout: 10000 });
    check(true, 'generated Pine reference opens from the help menu');
    await page.keyboard.press('Escape');
    await page.keyboard.press('Control+k');
    await page.waitForSelector('.palette input');
    await page.fill('.palette input', 'Help: Python');
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => /class SmaCross\(Strategy\)/.test(document.querySelector('.doc-body')?.textContent || ''), null, { timeout: 10000 });
    check(true, 'Python API doc opens from the command palette');
    await shot('34-help');
    await page.keyboard.press('Escape');
  },
  async repaint() {
    console.log('scenario: repainting & lookahead');
    const spec = { symbol: 'BTCUSDT', market: 'spot', tf: '1h', chartType: 'candles' };
    // a script that reads the 4-hour close before the 4-hour bar has closed
    const code = '//@version=6\nindicator("E2E lookahead", overlay=true)\nplot(request.security(syminfo.tickerid, "240", close, lookahead = barmerge.lookahead_on), "HTF close")\n';
    const meta = await page.evaluate((c) => window.fufu.invoke('scripts:save', { name: 'E2E lookahead', code: c, language: 'pine' }), code);
    const rep = await page.evaluate(([id, sp]) => window.fufu.invoke('scripts:repaintCheck', { scriptId: id, spec: sp }), [meta.id, spec]);
    check(rep.ok && rep.diffs.some((d) => d.title === 'HTF close') && rep.badTimes.length > rep.checked * 0.5, `lookahead caught on real data (${rep.badTimes.length} of ${rep.checked} replayed bars differ, ${rep.ms} ms)`);
    const mtf = await page.evaluate((sp) => window.fufu.invoke('scripts:repaintCheck', { scriptId: 'builtin:mtf_trend', spec: sp }), spec);
    check(mtf.ok && mtf.diffs.length === 0 && mtf.checked >= 50, `the higher-timeframe trend script replays identically (${mtf.checked} bars, ${mtf.ms} ms)`);
    const st = await page.evaluate((sp) => window.fufu.invoke('scripts:repaintCheck', { scriptId: 'builtin:strat_ma_cross', spec: { ...sp, tf: '15m' } }), spec);
    check(st.ok && st.isStrategy && st.diffs.length === 0, `a strategy matches what a bot had at every replayed bar close (${st.checked} bars)`);
    // on the chart: a red ⚠ in the legend opens the dialog with the code's finding and the replay
    await page.locator('button:has-text("Indicators")').first().click();
    await page.waitForSelector('.picker-row', { timeout: 15000 });
    await page.fill('.picker-main input', 'E2E lookahead');
    await wait(200);
    await page.keyboard.press('Enter');
    await page.keyboard.press('Escape');
    const warnBtn = (await legendRow('E2E lookahead')).locator('.ind-warn.lookahead');
    await warnBtn.waitFor({ timeout: 30000 });
    check(true, 'the legend marks the lookahead in red');
    await warnBtn.click();
    await page.waitForSelector('.repaint-dlg .rp-warning:has-text("Lookahead")', { timeout: 10000 });
    await page.waitForSelector('.repaint-dlg .rp-diffs', { timeout: 60000 });
    const txt = await page.textContent('.repaint-dlg');
    check(/not known at the time/.test(txt) && /HTF close/.test(txt) && /line 3/.test(txt), 'the dialog shows the replay differences and the line in the code');
    await shot('49-repaint-dialog');
    await page.click('.repaint-dlg .rp-line:has-text("line 3")');
    await page.waitForSelector('.script-editor .cm-content', { timeout: 15000 });
    await page.waitForFunction(() => /E2E lookahead/.test(document.querySelector('.se-title')?.textContent || ''), null, { timeout: 10000 });
    check(true, 'the line link opens the script in the editor');
    // the editor's replay button checks the code in the editor
    await page.click('.stack-head button[data-tip^="Repainting & lookahead"]');
    await page.waitForSelector('.repaint-dlg .rp-diffs', { timeout: 60000 });
    check(true, 'the editor runs the same check');
    await page.click('.modal button:has-text("Close")');
    // a strategy that trades on the future: the Strategy Tester says so above the results
    const sc = '//@version=6\nstrategy("E2E future strategy", overlay=true)\nh = request.security(syminfo.tickerid, "240", close, lookahead = barmerge.lookahead_on)\nif close < h\n    strategy.entry("L", strategy.long)\nif close > h\n    strategy.close("L")\n';
    const sm = await page.evaluate((c) => window.fufu.invoke('scripts:save', { name: 'E2E future strategy', code: c, language: 'pine' }), sc);
    void sm;
    await page.locator('button:has-text("Indicators")').first().click();
    await page.waitForSelector('.picker-row', { timeout: 15000 });
    await page.fill('.picker-main input', 'E2E future strategy');
    await wait(200);
    await page.keyboard.press('Enter');
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => window.__charts && [...document.querySelectorAll('.ind-item, .ind-more')].length > 0, null, { timeout: 30000 });
    const srow = await legendRow('E2E future strategy', 60000);
    await page.waitForFunction(() => [...document.querySelectorAll('.ind-item')].some((r) => /E2E future strategy/.test(r.textContent || '') && /trades/.test(r.textContent || '')), null, { timeout: 60000 });
    await srow.hover();
    await srow.locator('button[data-tip="More"]').click();
    await page.click('.menu-item:has-text("Open in Strategy Tester")');
    const opened = await page.waitForSelector('.lookahead-banner', { timeout: 120000 }).then(() => true).catch(() => false);
    check(opened, 'the Strategy Tester warns about the lookahead above the results');
    const notLive = await page.waitForSelector('.lookahead-banner:has-text("Confirmed by the live replay")', { timeout: 90000 }).then(() => true).catch(() => false);
    check(notLive, 'the live replay confirms it: a bot would have traded differently');
    if (opened) await shot('50-tester-lookahead');
  },
  async options() {
    console.log('scenario: options & Greeks');
    await page.keyboard.press('Control+k');
    await page.waitForSelector('.palette input');
    await page.fill('.palette input', 'Add Options');
    await page.keyboard.press('Enter');
    await page.waitForSelector('.opt-mod .oc-table tbody tr td.oc-strike', { timeout: 90000 });
    const rows = await page.$$eval('.opt-mod .oc-table tbody tr td.oc-strike', (r) => r.length);
    check(rows >= 8, `the BTC option chain lists strikes (${rows})`);
    await page.waitForFunction(() => [...document.querySelectorAll('.opt-mod .ot-tile')].some((t) => /IV 30 days/.test(t.textContent || '') && /\d+\.\d%/.test(t.textContent || '')), null, { timeout: 30000 });
    const tiles = await page.$$eval('.opt-mod .ot-tile', (t) => t.map((x) => x.textContent?.replace(/\s+/g, ' ').trim()));
    check(tiles.length >= 6, `summary: ${tiles.join(' | ')}`);
    check(await page.$('.opt-mod .oc-index') !== null, 'the index price sits between the strikes');
    await shot('51-options-chain');
    // maximize the panel (double-click its tab), look at it big, restore with Esc
    await page.locator('.stack:has(.opt-mod) .stack-tab.on').dblclick();
    await page.waitForSelector('.stack.maximized .opt-mod', { timeout: 5000 });
    const mw = await page.$eval('.stack.maximized', (e) => e.getBoundingClientRect().width);
    check(mw > 1300, `the options panel maximizes over the workspace (${Math.round(mw)} px wide)`);
    await wait(700);
    await shot('51b-options-maximized');
    await page.keyboard.press('Escape');
    await page.waitForSelector('.stack.maximized', { state: 'detached', timeout: 5000 });
    check(true, 'Esc restores the layout');
    await page.click('.opt-mod .ot-tile >> nth=0');
    await page.keyboard.press('Alt+Enter');
    await page.waitForSelector('.stack.maximized .opt-mod', { timeout: 5000 });
    await page.keyboard.press('Alt+Enter');
    await page.waitForSelector('.stack.maximized', { state: 'detached', timeout: 5000 });
    check(true, 'Alt+Enter maximizes and restores the focused panel');
    await page.click('.opt-mod .seg button:has-text("Greeks")');
    const greeks = await page.$$eval('.opt-mod .oc-table thead tr:nth-child(2) th', (t) => t.map((x) => x.textContent).join(' '));
    check(/Δ Γ Θ ν Strike Δ Γ Θ ν/.test(greeks.split(' ').reverse().join(' ')) || /ν Θ Γ Δ Strike Δ Γ Θ ν/.test(greeks), `Greeks columns (${greeks})`);
    const deltas = await page.$$eval('.opt-mod .oc-table tbody tr', (rows) => rows.map((r) => [...r.querySelectorAll('td')].map((td) => td.textContent)).filter((c) => c.length > 4));
    const callD = deltas.map((c) => parseFloat(c[3])).filter(Number.isFinite);
    check(callD.length > 4 && callD.every((d) => d >= -0.001 && d <= 1.001) && callD[0] >= callD[callD.length - 1], `call deltas fall from ${callD[0]} to ${callD[callD.length - 1]} with the strike`);
    await shot('52-options-greeks');
    // add a straddle from the builder's strategy menu
    await page.click('.opt-mod .tabs .tab:has-text("Builder")');
    await page.click('.opt-mod button:has-text("Strategy")');
    await page.click('.menu-item:has-text("Long straddle")');
    await page.waitForSelector('.opt-mod .ot-table.legs tbody tr', { timeout: 10000 });
    const legs = await page.$$eval('.opt-mod .ot-table.legs tbody tr', (r) => r.length);
    check(legs === 2, `a straddle has two legs (${legs})`);
    const bstats = await page.$$eval('.opt-mod .ot-tile', (t) => Object.fromEntries(t.map((x) => [x.querySelector('.ot-label')?.textContent, x.querySelector('.ot-value')?.textContent])));
    check(/^\$/.test(bstats['Theta'] || '') === false && /−\$/.test(bstats['Theta'] || '') && /^\$/.test(bstats['Vega'] || ''), `a long straddle pays theta and is long vega (theta ${bstats['Theta']}, vega ${bstats['Vega']})`);
    check((bstats['Break-even'] || '').split('·').length === 2, `two break-evens (${bstats['Break-even']})`);
    await page.waitForSelector('.opt-mod .ox-chart svg path.ox-series', { timeout: 10000 });
    await shot('53-options-builder');
    await page.click('.opt-mod .tabs .tab:has-text("Smile")');
    await page.waitForSelector('.opt-mod .ox-chart svg path.ox-series', { timeout: 10000 });
    const smile = await page.$$eval('.opt-mod .ox-chart svg path.ox-series', (p) => p.filter((x) => (x.getAttribute('d') || '').length > 20).length);
    check(smile >= 3, `volatility smiles of several expiries (${smile})`);
    const surface = await page.$$eval('.opt-mod .ot-surface td:not(.blank)', (c) => c.map((x) => parseFloat(x.textContent || '')).filter(Number.isFinite));
    check(surface.length >= 20 && surface.every((v) => v > 5 && v < 400), `volatility surface (${surface.length} cells, ${Math.min(...surface)}–${Math.max(...surface)}%)`);
    await page.locator('.stack:has(.opt-mod) .stack-tab.on').dblclick();
    await page.waitForSelector('.stack.maximized .opt-mod', { timeout: 5000 });
    await wait(600);
    await shot('54-options-smile');
    await page.keyboard.press('Escape');
    await page.waitForSelector('.stack.maximized', { state: 'detached', timeout: 5000 });
    await page.click('.opt-mod .tabs .tab:has-text("Exposure")');
    await page.waitForSelector('.opt-mod .ox-bar path[d^="M"]', { timeout: 60000 });
    const bars = await page.$$eval('.opt-mod .ox-bar path[d^="M"]', (b) => b.length);
    check(bars > 8, `open interest and gamma by strike (${bars} bars)`);
    const mp = await page.$$eval('.opt-mod .ot-tile', (t) => t.find((x) => /Max pain/.test(x.textContent || ''))?.querySelector('.ot-value')?.textContent);
    check(/\d/.test(mp || ''), `max pain from the open interest (${mp})`);
    await shot('55-options-exposure');
    // the chart's options levels: walls, gamma flip, max pain and the expected move
    await page.locator('button[data-tip^="Volume profile, higher-timeframe"]').first().click();
    await page.locator('.popover .row:has-text("Options levels") [role=switch]').click();
    await page.keyboard.press('Escape');
    const cid = await page.evaluate(() => Object.keys(window.__charts || {})[0]);
    await page.waitForFunction((id) => (window.__charts[id].levels() || []).length >= 4, cid, { timeout: 30000 });
    const levels = await page.evaluate((id) => window.__charts[id].levels(), cid);
    check(['cw', 'pw', 'mp', 'em+'].every((k) => levels.some((l) => l.id === k)), `options levels on the chart (${levels.map((l) => l.label).join(' | ')})`);
    await shot('56-options-levels');
    const ai = await page.evaluate(() => window.fufu.invoke('ai:testTool', 'options_snapshot', { symbol: 'ETHUSDT' }));
    const r = ai.result;
    check(r && r.iv30Pct > 5 && r.iv30Pct < 300 && r.expiries.length >= 3 && Number.isFinite(r.putCallOpenInterest), `options data for Claude: ETH IV30 ${r?.iv30Pct}%, P/C ${r?.putCallOpenInterest}, ${r?.expiries?.length} expiries, gamma ${r?.dealerGamma?.regime}`);
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
