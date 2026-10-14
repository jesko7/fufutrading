import { useEffect, useMemo, useState } from 'react';
import { HeadControls, type ModuleProps } from '../../app/WorkspaceView';
import { api, errorMessage } from '../../api';
import { useApp, toast } from '../../state/store';
import { Icon } from '../../components/Icon';
import { Segmented, Spinner, Empty, Popover, usePopover, Toggle } from '../../components/ui';
import { useNow } from '../../lib/hooks';
import { clsx, fmtAgo } from '../../lib/format';
import { isSymbol, SYMBOL_SPECS } from '../../../shared/symbols';
import './news.css';

interface Item {
  id: string;
  title: string;
  link: string;
  source: string;
  feedId: string;
  t: number;
  summary: string;
  coins: string[];
}
interface Feed {
  id: string;
  name: string;
  url: string;
  enabled: boolean;
  builtin?: boolean;
}
interface NewsData {
  items: Item[];
  feeds: Feed[];
  status: Record<string, { ok: boolean; at: number; error?: string; count: number }>;
  updated: number;
}

type Filter = 'all' | 'BTC' | 'ETH' | 'SOL' | 'chart';

export function NewsModule({ module }: ModuleProps) {
  const cfg = module.config as { filter?: Filter; seen?: number };
  const set = (p: Record<string, unknown>) => useApp.getState().setModuleConfig(module.id, p);
  const [data, setData] = useState<NewsData | null>(null);
  const [q, setQ] = useState('');
  const [refreshing, setRefreshing] = useState(false);
  const feedsPop = usePopover();
  useNow(30000);
  useEffect(() => api.sub<NewsData>('news', {}, setData), []);
  // the coin of the focused chart (for "Follow chart")
  const focused = useApp((s) => s.focusedModule);
  const ws = useApp((s) => s.workspace);
  const chartCoin = useMemo(() => {
    const id = (window as any).__lastChartModule || focused;
    const m = id ? ws?.modules[id] : null;
    return m && isSymbol(m.config.symbol) ? SYMBOL_SPECS[m.config.symbol].base : 'BTC';
  }, [focused, ws]);
  const filter: Filter = cfg.filter || 'all';
  const seen = cfg.seen || 0;
  // remember what was seen when leaving the module
  useEffect(() => () => set({ seen: Date.now() }), []); // eslint-disable-line react-hooks/exhaustive-deps

  const items = useMemo(() => {
    if (!data) return [];
    const coin = filter === 'chart' ? chartCoin : filter === 'all' ? null : filter;
    const s = q.trim().toLowerCase();
    return data.items.filter((it) => (!coin || it.coins.includes(coin)) && (!s || `${it.title} ${it.summary} ${it.source}`.toLowerCase().includes(s)));
  }, [data, filter, q, chartCoin]);

  const refresh = () => {
    setRefreshing(true);
    void api
      .call('news:refresh')
      .catch((e) => toast({ title: 'News not refreshed', body: errorMessage(e), kind: 'error' }))
      .finally(() => setRefreshing(false));
  };

  return (
    <div className="news">
      <HeadControls>
        <Segmented
          size="sm"
          value={filter}
          onChange={(f) => set({ filter: f })}
          options={[
            { value: 'all', label: 'All' },
            { value: 'BTC', label: 'BTC' },
            { value: 'ETH', label: 'ETH' },
            { value: 'SOL', label: 'SOL' },
            { value: 'chart', label: `Chart · ${chartCoin}`, title: 'Follow the coin of the focused chart' },
          ]}
        />
        <span className="spacer" />
        <button className="icon-btn" onClick={refresh} data-tip={data?.updated ? `Updated ${fmtAgo(data.updated)}` : 'Refresh'}>
          {refreshing ? <Spinner size={12} /> : <Icon name="refresh" size={14} />}
        </button>
        <button className="icon-btn" onClick={(e) => feedsPop.toggle(e.currentTarget)} data-tip="News sources">
          <Icon name="gear" size={14} />
        </button>
      </HeadControls>
      <div className="news-search">
        <Icon name="search" size={13} />
        <input className="news-q" placeholder="Search headlines…" value={q} onChange={(e) => setQ(e.target.value)} />
      </div>
      <div className="mod-scroll">
        {!data ? (
          <div className="empty">
            <Spinner />
          </div>
        ) : !items.length ? (
          <Empty icon="news" title={data.items.length ? 'No matching headlines' : 'Loading headlines…'}>
            {data.items.length ? 'Try another filter.' : 'Fetching the news feeds.'}
          </Empty>
        ) : (
          <div className="news-list">
            {items.map((it) => (
              <button key={it.id} className={clsx('news-item', it.t > seen && seen > 0 && 'fresh')} onClick={() => void api.call('news:open', it.link).catch(() => {})} data-tip="Open in your browser">
                <div className="news-meta">
                  <span className="news-src">{it.source}</span>
                  <span className="faint">{it.t ? fmtAgo(it.t) : ''}</span>
                  <span className="spacer" />
                  {it.coins.map((c) => (
                    <span key={c} className={clsx('coin-chip', c.toLowerCase())}>
                      {c}
                    </span>
                  ))}
                </div>
                <div className="news-title">{it.title}</div>
                {it.summary && <div className="news-sum">{it.summary}</div>}
              </button>
            ))}
          </div>
        )}
      </div>
      {feedsPop.anchor && data && (
        <Popover anchor={feedsPop.anchor} onClose={feedsPop.close} width={340} align="end">
          <FeedSettings data={data} />
        </Popover>
      )}
    </div>
  );
}

function FeedSettings({ data }: { data: NewsData }) {
  const [url, setUrl] = useState('');
  const save = (feeds: Feed[]) => void api.call('news:feeds', feeds).catch((e) => toast({ title: 'Sources not saved', body: errorMessage(e), kind: 'error' }));
  return (
    <div className="pop-pad">
      <div className="set-group-title">News sources</div>
      {data.feeds.map((f) => {
        const st = data.status[f.id];
        return (
          <div key={f.id} className="row" style={{ gap: 8, padding: '3px 0' }}>
            <Toggle value={f.enabled} onChange={(v) => save(data.feeds.map((x) => (x.id === f.id ? { ...x, enabled: v } : x)))} />
            <div className="col grow" style={{ minWidth: 0 }}>
              <span className="ellipsis">{f.name}</span>
              <span className={clsx('small ellipsis', st && !st.ok ? 'danger-text' : 'faint')}>{st ? (st.ok ? `${st.count} items` : st.error) : f.enabled ? 'not loaded yet' : 'off'}</span>
            </div>
            {!f.builtin && (
              <button className="icon-btn small" onClick={() => save(data.feeds.filter((x) => x.id !== f.id))} data-tip="Remove">
                <Icon name="trash" size={12} />
              </button>
            )}
          </div>
        );
      })}
      <div className="row" style={{ gap: 6, marginTop: 6 }}>
        <input className="input grow" placeholder="https://…/feed (RSS or Atom)" value={url} onChange={(e) => setUrl(e.target.value)} />
        <button
          className="btn small"
          disabled={!/^https?:\/\/\S+$/.test(url.trim())}
          onClick={() => {
            save([...data.feeds, { id: '', name: '', url: url.trim(), enabled: true }]);
            setUrl('');
          }}
        >
          Add
        </button>
      </div>
    </div>
  );
}
