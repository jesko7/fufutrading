import { useEffect, useMemo, useState } from 'react';
import { HeadControls, type ModuleProps } from '../../app/WorkspaceView';
import { api, errorMessage } from '../../api';
import { useApp, toast } from '../../state/store';
import { Icon } from '../../components/Icon';
import { Segmented, Spinner, Empty, Popover, usePopover, Toggle, Select } from '../../components/ui';
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
type Sentiment = 'bullish' | 'bearish' | 'neutral';
interface NewsAi {
  enabled: boolean;
  model: string;
  effort: string;
  thinking: boolean;
}
interface NewsData {
  items: Item[];
  feeds: Feed[];
  status: Record<string, { ok: boolean; at: number; error?: string; count: number }>;
  updated: number;
  /** Claude's rating of each headline (by id), its settings and progress. */
  sentiment?: Record<string, { s: Sentiment; why: string; model: string; t: number }>;
  ai?: NewsAi;
  aiStatus?: { running: boolean; error?: string; rated: number; cost: number };
}

type Filter = 'all' | 'BTC' | 'ETH' | 'SOL' | 'chart';
type SentFilter = 'all' | 'bullish' | 'bearish';

const AI_MODELS = [
  { value: 'haiku', label: 'Haiku' },
  { value: 'sonnet', label: 'Sonnet' },
  { value: 'opus', label: 'Opus' },
  { value: 'fable', label: 'Fable' },
];
const AI_EFFORTS = [
  { value: 'low', label: 'Low effort' },
  { value: 'medium', label: 'Medium effort' },
  { value: 'high', label: 'High effort' },
  { value: 'xhigh', label: 'Extra-high effort' },
  { value: 'max', label: 'Max effort' },
];

export function NewsModule({ module }: ModuleProps) {
  const cfg = module.config as { filter?: Filter; seen?: number; sent?: SentFilter };
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

  const ai = data?.ai;
  const sentOn = !!ai?.enabled;
  const sentFilter: SentFilter = sentOn ? cfg.sent || 'all' : 'all';
  const items = useMemo(() => {
    if (!data) return [];
    const coin = filter === 'chart' ? chartCoin : filter === 'all' ? null : filter;
    const s = q.trim().toLowerCase();
    return data.items.filter((it) => (!coin || it.coins.includes(coin)) && (!s || `${it.title} ${it.summary} ${it.source}`.toLowerCase().includes(s)) && (sentFilter === 'all' || data.sentiment?.[it.id]?.s === sentFilter));
  }, [data, filter, q, chartCoin, sentFilter]);
  const setAi = (p: Partial<NewsAi>) => void api.call('news:ai', p).catch((e) => toast({ title: 'Setting not saved', body: errorMessage(e), kind: 'error' }));
  const rated = data ? data.items.filter((it) => data.sentiment?.[it.id]).length : 0;
  // the mood of what is listed (coin and search filters applied)
  const mood = useMemo(() => {
    const out = { bullish: 0, bearish: 0 };
    if (!data?.sentiment || !sentOn) return out;
    for (const it of items) {
      const s = data.sentiment[it.id]?.s;
      if (s === 'bullish' || s === 'bearish') out[s]++;
    }
    return out;
  }, [items, data, sentOn]);

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
      {ai && (
        <div className="news-ai">
          <label className="row" style={{ gap: 6 }} data-tip="Claude rates each headline: green for likely bullish, red for likely bearish. It uses your Claude Code plan, like AI Studio.">
            <Toggle value={ai.enabled} onChange={(v) => setAi({ enabled: v })} />
            <span>AI sentiment</span>
          </label>
          {ai.enabled && (
            <>
              <Select value={ai.model} options={AI_MODELS} onChange={(m) => setAi({ model: m })} title="Claude model that rates the headlines" />
              <Select value={ai.effort} options={AI_EFFORTS} onChange={(v) => setAi({ effort: v })} title="How much effort Claude spends (more is slower and uses more of your plan)" />
              <label className="row" style={{ gap: 6 }} data-tip="Let Claude think before it rates (slower, more thorough)">
                <Toggle value={ai.thinking} onChange={(v) => setAi({ thinking: v })} />
                <span>Thinking</span>
              </label>
              <Segmented
                size="sm"
                value={sentFilter}
                onChange={(v) => set({ sent: v })}
                options={[
                  { value: 'all', label: 'All' },
                  { value: 'bullish', label: 'Bullish', cls: 'sent-opt bullish' },
                  { value: 'bearish', label: 'Bearish', cls: 'sent-opt bearish' },
                ]}
              />
              <span className="spacer" />
              {mood.bullish + mood.bearish > 0 && (
                <span className="news-mood" data-tip="Bullish and bearish headlines among those listed">
                  <span className="up">▲ {mood.bullish}</span>
                  <span className="down">▼ {mood.bearish}</span>
                </span>
              )}
              <span className={clsx('small', data?.aiStatus?.error ? 'warn-text' : 'faint')} data-tip={data?.aiStatus?.error}>
                {data?.aiStatus?.running ? (
                  <>
                    <Spinner size={10} /> rating…
                  </>
                ) : data?.aiStatus?.error ? (
                  `Not rated: ${data.aiStatus.error.slice(0, 60)}`
                ) : (
                  `${rated} of ${data?.items.length || 0} rated`
                )}
              </span>
              <button className="icon-btn small" onClick={() => void api.call('news:rerate')} data-tip="Rate all headlines again with these settings">
                <Icon name="refresh" size={12} />
              </button>
            </>
          )}
        </div>
      )}
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
            {items.map((it) => {
              const sent = sentOn ? data.sentiment?.[it.id] : undefined;
              return (
                <button key={it.id} className={clsx('news-item', it.t > seen && seen > 0 && 'fresh', sent && `sent-${sent.s}`)} onClick={() => void api.call('news:open', it.link).catch(() => {})} data-tip="Open in your browser">
                  <div className="news-meta">
                    <span className="news-src">{it.source}</span>
                    <span className="faint">{it.t ? fmtAgo(it.t) : ''}</span>
                    {sent && sent.s !== 'neutral' && (
                      <span className={clsx('sent-badge', sent.s)} data-tip={`Claude (${sent.model}): ${sent.why || sent.s}`}>
                        {sent.s === 'bullish' ? '▲ Bullish' : '▼ Bearish'}
                      </span>
                    )}
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
              );
            })}
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
