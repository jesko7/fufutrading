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
    await page.click('.replay-bar button[data-tip^="Exit replay"]');
    await page.waitForSelector('.replay-bar', { state: 'detached', timeout: 10000 });
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
    check(n0 === 4, `four alerts listed (${n0})`);
    await page.locator('.alert-row').first().locator('.toggle').click();
    await wait(400);
    const states = await page.evaluate(() => window.fufu.invoke('alerts:list').then((l) => l.map((a) => a.enabled)));
    check(states.filter(Boolean).length === 0, 'switching an alert off works (all off now)');
    await shot('24-alerts');
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
