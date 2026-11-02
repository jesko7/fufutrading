import { useEffect, useState } from 'react';
import { HeadControls, type ModuleProps } from '../../app/WorkspaceView';
import { api, errorMessage } from '../../api';
import { toast } from '../../state/store';
import { Icon, CoinIcon } from '../../components/Icon';
import { Select, SymbolPicker, Spinner, Empty, Toggle, confirmDialog } from '../../components/ui';
import { fmtDate, fmtDateTime } from '../../lib/format';
import { SYMBOLS, SYMBOL_SPECS, type Market, type SymbolId } from '../../../shared/symbols';
import { useApp } from '../../state/store';
import './data.css';

type Kind = 'klines' | 'mark' | 'metrics' | 'funding';

interface Entry {
  kind: Kind;
  market: Market;
  symbol: SymbolId;
  interval: string;
  ranges: [number, number][];
  bytes: number;
  gaps: number;
}
interface TradeStat {
  market: Market;
  symbol: SymbolId;
  bytes: number;
  days: number;
  coverage: [number, number][];
}
interface BookStat {
  market: Market;
  symbol: SymbolId;
  days: number;
  bytes: number;
  first: number;
  last: number;
}
interface Overview {
  root: string;
  entries: Entry[];
  trades: TradeStat[];
  books: { stats: BookStat[]; recording: Record<string, { status: string; saved: number }> };
  totalBytes: number;
}

const KEEP = [7, 14, 30, 90, 365].map((d) => ({ value: String(d), label: d === 365 ? 'Keep 1 year' : `Keep ${d} days` }));

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(2)} GB`;
}

const fail = (title: string) => (e: unknown) => toast({ title, body: errorMessage(e).replace(/^Validation: /, ''), kind: 'error' });

const INTERVALS = ['1s', '1m', '5m', '15m', '1h', '4h', '1d'];
const RANGES = [
  { value: '30', label: 'Last 30 days' },
  { value: '90', label: 'Last 90 days' },
  { value: '365', label: 'Last year' },
  { value: '1095', label: 'Last 3 years' },
  { value: 'all', label: 'Everything since listing' },
];

function ins(symbol: SymbolId, market: Market): string {
  return `${SYMBOL_SPECS[symbol].base}${market === 'futures' ? ' Perp' : ''}`;
}

const KIND_LABEL: Record<Kind, string> = { klines: 'candles', mark: 'mark price', metrics: 'futures statistics', funding: 'funding rates' };
/** The download choices for open interest and long/short ratios (5-minute samples) and funding. */
const STATS = 'stats';
const FUNDING = 'funding';

export function DataModule(_p: ModuleProps) {
  const [data, setData] = useState<Overview | null>(null);
  const books = useApp((s) => s.settings.books);
  const [busy, setBusy] = useState<{ label: string; done: number; total: number } | null>(null);
  const [sym, setSym] = useState<{ symbol: SymbolId; market: Market }>({ symbol: 'BTCUSDT', market: 'spot' });
  const [interval, setIntervalV] = useState('1m');
  const [range, setRange] = useState('90');
  const load = () =>
    void api
      .call<Overview>('data:overview')
      .then(setData)
      .catch(fail('Could not read the cache'));
  useEffect(load, []);

  const download = (p: { market: Market; symbol: SymbolId; interval: string; from: number; to: number; kind?: Kind }, label: string) => {
    if (busy) return;
    setBusy({ label, done: 0, total: 1 });
    const unsub = api.sub<any>('data:download', p, (m) => {
      if (m.__error || m.type === 'error') {
        unsub();
        setBusy(null);
        fail('Download failed')(new Error(m.__error || m.message));
      } else if (m.type === 'progress') setBusy({ label, done: m.done, total: m.total || 1 });
      else if (m.type === 'done') {
        unsub();
        setBusy(null);
        toast({ title: 'Data downloaded', body: label, kind: 'ok' });
        load();
      }
    });
  };

  const prefetch = () => {
    const now = Date.now();
    const from = range === 'all' ? Date.UTC(2017, 6, 1) : now - +range * 86400000;
    const span = RANGES.find((r) => r.value === range)?.label.toLowerCase();
    if (interval === STATS) download({ kind: 'metrics', market: 'futures', symbol: sym.symbol, interval: '5m', from, to: now }, `${ins(sym.symbol, 'futures')} futures statistics · ${span}`);
    else if (interval === FUNDING) download({ kind: 'funding', market: 'futures', symbol: sym.symbol, interval: '8h', from, to: now }, `${ins(sym.symbol, 'futures')} funding rates · ${span}`);
    else download({ market: sym.market, symbol: sym.symbol, interval, from, to: now }, `${ins(sym.symbol, sym.market)} ${interval} · ${span}`);
  };

  return (
    <div className="data-mod">
      <HeadControls>
        <span className="faint small">{data ? `${fmtBytes(data.totalBytes)} on disk` : ''}</span>
        <span className="spacer" />
        <button className="btn small ghost" onClick={load} data-tip="Refresh">
          <Icon name="refresh" size={13} />
        </button>
        <button className="btn small ghost" onClick={() => void api.call('data:openFolder')} data-tip={data?.root}>
          <Icon name="folder" size={13} /> Open folder
        </button>
      </HeadControls>
      <div className="mod-scroll data-body">
        <section className="data-card">
          <div className="data-title">Download for offline use</div>
          <div className="faint small">Candles are cached automatically when charts, backtests and replays need them. Prefetch a range to make long backtests and replays start instantly.</div>
          <div className="row" style={{ gap: 8, flexWrap: 'wrap', marginTop: 6 }}>
            <SymbolPicker symbol={sym.symbol} market={sym.market} onChange={(s, m) => setSym({ symbol: s, market: m })} />
            <Select
              value={(interval === STATS || interval === FUNDING) && sym.market !== 'futures' ? '1m' : interval}
              onChange={setIntervalV}
              options={[...INTERVALS.filter((i) => !(i === '1s' && sym.market === 'futures')).map((i) => ({ value: i, label: `${i} candles` })), ...(sym.market === 'futures' ? [{ value: STATS, label: 'Open interest & long/short ratios' }, { value: FUNDING, label: 'Funding rates' }] : [])]}
            />
            <Select value={range} onChange={setRange} options={RANGES} />
            <button className="btn small primary" disabled={!!busy} onClick={prefetch}>
              <Icon name="download" size={13} /> Download
            </button>
          </div>
          {interval === '1s' && <div className="faint small">1-second candles are large: about 86,400 per day.</div>}
          {interval === STATS && sym.market === 'futures' && <div className="faint small">5-minute samples Binance publishes since September 2020: the last 30 days from its API, older ones as one small archive per day.</div>}
          {busy && (
            <div className="data-progress">
              <Spinner size={12} />
              <span className="grow ellipsis">{busy.label}</span>
              <div className="progress" style={{ width: 180 }}>
                <div style={{ width: `${Math.round((busy.done / Math.max(1, busy.total)) * 100)}%` }} />
              </div>
            </div>
          )}
        </section>
        <section className="data-card">
          <div className="data-title-row">
            <div className="data-title">Order books</div>
            <span className="spacer" />
            <Select value={String(books.keepDays)} title="How long recorded order books are kept" options={KEEP} onChange={(v) => void useApp.getState().updateSettings({ books: { ...books, keepDays: +v } })} />
          </div>
          <div className="faint small">
            Every price level of the book, saved once a minute for scripts (Pine <code>book.*</code>, Python <code>data.book</code>): backtests, bots and chart history read it. Binance publishes price levels, not single orders. About 30 MB a day for a spot book, 7 MB for a perpetual.
          </div>
          <div className="data-rows">
            {SYMBOLS.flatMap((symbol) => (['spot', 'futures'] as Market[]).map((market) => ({ symbol, market }))).map(({ symbol, market }) => {
              const key = `${market}:${symbol}`;
              const on = books.record.includes(key);
              const st = data?.books.stats.find((b) => b.market === market && b.symbol === symbol);
              const rec = data?.books.recording[key];
              return (
                <div className="data-row" key={key} data-book={key}>
                  <div className="data-ins">
                    <Toggle value={on} title={on ? 'Stop recording' : 'Record this order book'} onChange={(v) => void useApp.getState().updateSettings({ books: { ...books, record: v ? [...books.record.filter((k) => k !== key), key] : books.record.filter((k) => k !== key) } }).then(() => setTimeout(load, 300))} />
                    <CoinIcon symbol={symbol} size={13} />
                    <b>{ins(symbol, market)}</b>
                    {on && <span className={`book-rec ${rec?.status === 'live' ? 'live' : ''}`}>{rec?.status === 'live' ? 'Recording' : 'Connecting…'}</span>}
                  </div>
                  <div className="data-cov faint">{st ? `${fmtDateTime(st.first)} → ${fmtDateTime(st.last)} · ${st.days} day${st.days === 1 ? '' : 's'}` : on ? 'The first snapshot is saved at the next full minute' : '—'}</div>
                  <div className="data-size faint">{st ? fmtBytes(st.bytes) : ''}</div>
                  <div className="data-act">
                    {st && (
                      <button
                        className="icon-btn small"
                        data-tip="Delete the recorded order book"
                        onClick={async () => {
                          if (!(await confirmDialog({ title: `Delete the recorded ${ins(symbol, market)} order book?`, body: `${st.days} day${st.days === 1 ? '' : 's'}, ${fmtBytes(st.bytes)}. Backtests and charts lose its history.`, confirm: 'Delete', danger: true }))) return;
                          await api.call('books:clear', market, symbol).catch(fail('Not deleted'));
                          load();
                        }}
                      >
                        <Icon name="trash" size={13} />
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </section>
        <section className="data-card">
          <div className="data-title">Candle cache</div>
          {!data ? (
            <Spinner />
          ) : !data.entries.length ? (
            <Empty icon="database" title="Nothing cached yet" />
          ) : (
            <div className="data-rows">
              {data.entries.map((e) => {
                const first = e.ranges[0]?.[0];
                const last = e.ranges[e.ranges.length - 1]?.[1];
                return (
                  <div className="data-row" key={`${e.kind}${e.market}${e.symbol}${e.interval}`}>
                    <div className="data-ins">
                      <CoinIcon symbol={e.symbol} size={13} />
                      <b>{ins(e.symbol, e.market)}</b>
                      <span className="faint">
                        {e.interval} {KIND_LABEL[e.kind] || 'candles'}
                      </span>
                    </div>
                    <div className="data-cov faint">
                      {first ? `${fmtDate(first)} → ${fmtDate(last)}` : '—'}
                      {e.gaps > 0 && (
                        <span className="badge warn" style={{ marginLeft: 6 }} data-tip="Stretches inside this range that are not downloaded yet">
                          {e.gaps} gap{e.gaps > 1 ? 's' : ''}
                        </span>
                      )}
                    </div>
                    <div className="data-size faint">{fmtBytes(e.bytes)}</div>
                    <div className="data-act">
                      {e.gaps > 0 && (
                        <button className="btn small ghost" disabled={!!busy} onClick={() => download({ kind: e.kind, market: e.market, symbol: e.symbol, interval: e.interval, from: first!, to: last! }, `Fill gaps · ${ins(e.symbol, e.market)} ${e.interval}`)}>
                          Fill gaps
                        </button>
                      )}
                      <button
                        className="icon-btn small"
                        data-tip="Delete from the cache"
                        onClick={async () => {
                          if (await confirmDialog({ title: 'Delete cached data?', body: `${ins(e.symbol, e.market)} ${e.interval} ${KIND_LABEL[e.kind] || 'candles'} (${fmtBytes(e.bytes)}). It is downloaded again when needed.`, confirm: 'Delete', danger: true })) {
                            await api.call('data:clear', e.kind, e.market, e.symbol, e.interval).catch(fail('Not deleted'));
                            load();
                          }
                        }}
                      >
                        <Icon name="trash" size={13} />
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </section>
        <section className="data-card">
          <div className="data-title">Trades (footprints)</div>
          <div className="faint small">Aggregate trades with their aggressor side, downloaded for footprint charts. The newest days per instrument are kept.</div>
          {data && !data.trades.length && <div className="faint small" style={{ marginTop: 6 }}>No trades cached.</div>}
          {data && data.trades.length > 0 && (
            <div className="data-rows">
              {data.trades.map((t) => (
                <div className="data-row" key={`${t.market}${t.symbol}`}>
                  <div className="data-ins">
                    <CoinIcon symbol={t.symbol} size={13} />
                    <b>{ins(t.symbol, t.market)}</b>
                    <span className="faint">
                      {t.days} day{t.days === 1 ? '' : 's'}
                    </span>
                  </div>
                  <div className="data-cov faint">{t.coverage.length ? `${fmtDate(t.coverage[0][0])} → ${fmtDate(t.coverage[t.coverage.length - 1][1])}` : '—'}</div>
                  <div className="data-size faint">{fmtBytes(t.bytes)}</div>
                  <div className="data-act">
                    <button
                      className="icon-btn small"
                      data-tip="Delete cached trades"
                      onClick={async () => {
                        await api.call('trades:clear', t.market, t.symbol).catch(fail('Not deleted'));
                        load();
                      }}
                    >
                      <Icon name="trash" size={13} />
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
