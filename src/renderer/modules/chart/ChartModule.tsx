import { useEffect, useMemo, useRef, useState, useCallback } from 'react';
import { api, errorMessage } from '../../api';
import { useApp, toast } from '../../state/store';
import { HeadControls, type ModuleProps } from '../../app/WorkspaceView';
import { ChartEngine } from '../../chart/engine';
import { BarStore } from '../../chart/barStore';
import { chartTheme } from '../../chart/theme';
import type { Drawing, DrawingType, IndicatorOutput, MtfSeries, SeriesStyle, TradeLine, Execution, FootprintBar } from '../../chart/types';
import type { ChartModuleConfig } from '../../../shared/workspace';
import type { SeriesInfo, SeriesStatus, ChartType } from '../../../shared/marketTypes';
import { SYMBOL_SPECS, SYMBOLS, priceDecimals, type Market, type SymbolId } from '../../../shared/symbols';
import { parseTimeframe, tfDurationMs, bucketEnd, isFixedDuration } from '../../../shared/timeframes';
import { Icon, CoinIcon } from '../../components/Icon';
import { SymbolPicker, TimeframePicker, Menu, usePopover, Popover, Segmented, NumberField, Toggle, promptDialog, type MenuItemSpec } from '../../components/ui';
import { clsx, fmtNum, fmtPct, fmtDateTime } from '../../lib/format';
import { priceLevelAt, type AlertLine } from '../../../shared/alerts';
import { formatVolume } from '../../chart/scale';
import { bus } from '../../lib/bus';
import { usePersistentState } from '../../lib/hooks';
import { DrawingToolbar, DrawingEditor } from './DrawingTools';
import { useChartIndicators, IndicatorLegend, PaneLegends, openIndicatorPicker, openIndicatorSettings, addIndicator, type PaneGeo } from './indicators';
import { useChartTrading } from './trading';
import { useAccounts, openCreateAccount } from '../trading/accounts';
import { useFootprint } from './footprint';
import { useReplayForChart, ReplayButton } from './replay';
import { useAlertLines } from '../alerts/chartLines';
import './chart.css';

const CHART_TYPES: { value: ChartType; label: string; icon: string }[] = [
  { value: 'candles', label: 'Candles', icon: 'candles' },
  { value: 'hollow', label: 'Hollow candles', icon: 'candles' },
  { value: 'heikinashi', label: 'Heikin-Ashi', icon: 'candles' },
  { value: 'renko', label: 'Renko', icon: 'grid' },
  { value: 'bars', label: 'Bars (OHLC)', icon: 'chart' },
  { value: 'line', label: 'Line', icon: 'log' },
  { value: 'area', label: 'Area', icon: 'log' },
  { value: 'footprint', label: 'Footprint', icon: 'heat' },
];

const COMPARE_COLORS = ['#f59e0b', '#a855f7', '#10b981', '#ec4899'];

/**
 * A chart only shows positions of its own market. When the coin's position lives in the other
 * market (e.g. a perpetual position on a spot chart) this pill says so and switches the chart.
 */
function OtherMarketPosition({ symbol, market, onSwitch }: { symbol: SymbolId; market: Market; onSwitch: (m: Market) => void }) {
  const accounts = useAccounts();
  const live = accounts.filter((a) => !a.config.archived && !a.config.replay);
  if (live.some((a) => a.config.market === market && a.positions.some((p) => p.symbol === symbol))) return null;
  const other: Market = market === 'spot' ? 'futures' : 'spot';
  const acct = live.find((a) => a.config.market === other && a.positions.some((p) => p.symbol === symbol));
  const pos = acct?.positions.find((p) => p.symbol === symbol);
  if (!acct || !pos) return null;
  const what = other === 'futures' ? `Perp ${pos.side === 1 ? 'long' : 'short'}` : 'Spot holding';
  return (
    <button className={clsx('btn tiny other-pos', pos.uPnl >= 0 ? 'up' : 'down')} onClick={() => onSwitch(other)} data-tip={`${acct.config.name}: ${what.toLowerCase()} of ${+pos.qty.toFixed(5)} ${SYMBOL_SPECS[symbol].base}. Positions show on the chart of their own market. Click to switch this chart to ${other === 'futures' ? 'the perpetual' : 'spot'}.`}>
      {what} · {fmtNum(pos.uPnl, 2)} <Icon name="chevRight" size={11} />
    </button>
  );
}
let drawingClipboard: Drawing[] = [];

function seriesChartType(ct: ChartType): ChartType {
  return ct === 'heikinashi' || ct === 'renko' ? ct : 'candles';
}

function engineStyle(ct: ChartType): SeriesStyle {
  switch (ct) {
    case 'hollow':
      return 'hollow';
    case 'bars':
      return 'bars';
    case 'line':
      return 'line';
    case 'area':
      return 'area';
    case 'footprint':
      return 'footprint';
    default:
      return 'candles';
  }
}

interface LegendState {
  index: number;
  hover: boolean;
}

export function ChartModule({ module }: ModuleProps) {
  const cfg = module.config as ChartModuleConfig;
  const settings = useApp((s) => s.settings);
  const update = useCallback((patch: Partial<ChartModuleConfig>) => useApp.getState().setModuleConfig(module.id, patch as Record<string, unknown>), [module.id]);
  const hostRef = useRef<HTMLDivElement>(null);
  const engRef = useRef<ChartEngine | null>(null);
  const storeRef = useRef(new BarStore());
  const keyRef = useRef<string>('');
  const [eng, setEng] = useState<ChartEngine | null>(null);
  const [status, setStatus] = useState<SeriesStatus>('loading');
  const [info, setInfo] = useState<SeriesInfo | null>(null);
  const [legend, setLegend] = useState<LegendState>({ index: -1, hover: false });
  // the "+" at the crosshair price (orders, alert, line) and the "back to the latest bar" button
  const [plus, setPlus] = useState<{ y: number; price: number } | null>(null);
  const plusRef = useRef<{ hovered: boolean; timer: number }>({ hovered: false, timer: 0 });
  const [latestHidden, setLatestHidden] = useState(false);
  const [dataVersion, setDataVersion] = useState(0);
  const [tool, setTool] = useState<DrawingType | null>(null);
  const [selectedDrawing, setSelectedDrawing] = useState<string | null>(null);
  const [showTools, setShowTools] = usePersistentState('chart.showTools', true);
  const [magnet, setMagnet] = usePersistentState('chart.magnet', false);
  const ctxMenu = usePopover();
  const [ctxItems, setCtxItems] = useState<MenuItemSpec[]>([]);
  const spec = useMemo(() => ({ symbol: cfg.symbol, market: cfg.market, tf: cfg.tf, chartType: seriesChartType(cfg.chartType), renko: cfg.chartType === 'renko' ? cfg.renko || { atrLength: 14 } : undefined }), [cfg.symbol, cfg.market, cfg.tf, cfg.chartType, JSON.stringify(cfg.renko)]);
  const tf = parseTimeframe(cfg.tf);
  const replay = useReplayForChart(module.id, cfg);

  // ---------------------------------------------------------------- engine lifecycle
  useEffect(() => {
    const e = new ChartEngine(hostRef.current!, chartTheme(useApp.getState().settings));
    engRef.current = e;
    setEng(e);
    // test/diagnostics hook: last bar time and count of each chart
    ((window as any).__charts ||= {})[module.id] = {
      bars: () => {
        const b = storeRef.current;
        return { n: b.length, last: b.length ? b.t[b.length - 1] : null, close: b.length ? b.c[b.length - 1] : null };
      },
      footprint: () => e.footprint?.bars.size ?? 0,
      drawings: () => ((useApp.getState().workspace?.modules[module.id]?.config.drawings || []) as Drawing[]).map((d) => ({ id: d.id, type: d.type, locked: !!d.locked, hidden: !!d.hidden })),
    };
    const onTheme = () => e.setTheme(chartTheme(useApp.getState().settings));
    window.addEventListener('fufu-theme', onTheme);
    return () => {
      window.removeEventListener('fufu-theme', onTheme);
      e.destroy();
      engRef.current = null;
      delete (window as any).__charts?.[module.id];
    };
  }, []);

  useEffect(() => {
    eng?.setTheme(chartTheme(settings));
  }, [eng, settings.chart, settings.accent, settings.theme]);

  useEffect(() => {
    if (!eng) return;
    eng.setStyle(engineStyle(cfg.chartType));
    eng.setScaleMode(cfg.scale || 'linear');
    eng.setShowVolume(cfg.showVolume !== false);
    eng.setMagnet(magnet);
  }, [eng, cfg.chartType, cfg.scale, cfg.showVolume, magnet]);

  useEffect(() => {
    if (!eng || !tf) return;
    eng.setInstrument({ priceDecimals: priceDecimals(cfg.symbol, cfg.market), tick: SYMBOL_SPECS[cfg.symbol][cfg.market].tickSize, tfMs: cfg.chartType === 'renko' ? tfDurationMs(tf) : tfDurationMs(tf) });
  }, [eng, cfg.symbol, cfg.market, cfg.tf, cfg.chartType]);

  // ---------------------------------------------------------------- data subscription
  useEffect(() => {
    if (!eng) return;
    const store = storeRef.current;
    store.reset();
    eng.setData(store.bars());
    setStatus('loading');
    setInfo(null);
    if (replay.active) return; // replay feeds data itself
    const unsub = api.sub<any>('series', spec, (msg) => {
      if (msg.__error) {
        setStatus('error');
        setInfo({ key: '', baseInterval: null, construction: '', error: msg.__error });
        return;
      }
      if (msg.type === 'snapshot') {
        keyRef.current = msg.key;
        store.setPacked(msg.packed);
        eng.setData(store.bars(), { keepView: true });
        setStatus(msg.status);
        setInfo(msg.info);
        setDataVersion((v) => v + 1);
      } else {
        if (msg.packed.length || msg.length !== store.length) {
          const added = store.apply(msg.index, msg.packed, msg.length);
          eng.dataUpdated(store.bars(), added);
          if (added) setDataVersion((v) => v + 1);
          else bumpLive();
        }
        if (msg.status) setStatus(msg.status);
      }
      if (tf && isFixedDuration(tf) && store.length) eng.setBarCloseTime(bucketEnd(tf, store.t[store.length - 1]));
    });
    eng.setCallbacks(callbacksRef.current);
    return unsub;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [eng, spec, replay.active]);

  // throttle "live tick" re-renders of legend/indicators to animation frames
  const [liveTick, setLiveTick] = useState(0);
  const liveRaf = useRef(0);
  const bumpLive = () => {
    if (liveRaf.current) return;
    liveRaf.current = requestAnimationFrame(() => {
      liveRaf.current = 0;
      setLiveTick((x) => x + 1);
    });
  };

  // replay data source
  useEffect(() => {
    if (!eng || !replay.active) return;
    return replay.attach(eng, storeRef.current, (s, inf) => {
      setStatus(s);
      if (inf) setInfo(inf);
      setDataVersion((v) => v + 1);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [eng, replay.active, replay.sessionId, spec]);

  // replay start-bar picking
  useEffect(() => {
    eng?.setPickBarMode(replay.picking);
  }, [eng, replay.picking]);

  // countdown refresh
  useEffect(() => {
    if (!eng) return;
    const id = setInterval(() => eng.invalidate(), 1000);
    return () => clearInterval(id);
  }, [eng]);

  // ---------------------------------------------------------------- drawings
  useEffect(() => {
    eng?.setDrawings((cfg.drawings || []) as Drawing[]);
  }, [eng, cfg.drawings]);
  useEffect(() => {
    eng?.setDrawingTool(tool);
  }, [eng, tool]);

  // ---------------------------------------------------------------- compare & MTF overlays
  useCompareAndMtf(eng, cfg, dataVersion);

  // ---------------------------------------------------------------- indicators
  const indicators = useChartIndicators(module.id, cfg, storeRef, dataVersion, liveTick, replay);
  const [panes, setPanes] = useState<PaneGeo[]>([]);
  useEffect(() => {
    eng?.setIndicators(indicators.outputs);
  }, [eng, indicators.outputs]);

  // ---------------------------------------------------------------- volume profile & footprint
  useEffect(() => {
    eng?.setVolumeProfile({ mode: cfg.volumeProfile?.mode || 'off', rows: cfg.volumeProfile?.rows || 24, valueArea: cfg.volumeProfile?.valueArea || 70, from: cfg.volumeProfile?.from, to: cfg.volumeProfile?.to });
  }, [eng, JSON.stringify(cfg.volumeProfile)]);
  const fp = useFootprint(cfg, storeRef, dataVersion, eng, replay.active);
  useEffect(() => {
    if (!eng) return;
    eng.setFootprint(fp.bars ? { bars: fp.bars as Map<number, FootprintBar>, opts: { group: cfg.footprint?.group || 0, mode: cfg.footprint?.mode || 'bidask', imbalanceRatio: cfg.footprint?.imbalanceRatio || 3 } } : null);
  }, [eng, fp.bars, fp.version, JSON.stringify(cfg.footprint)]);

  // ---------------------------------------------------------------- trading overlays
  const trading = useChartTrading(cfg, replay);
  const alertLines = useAlertLines(cfg.symbol, cfg.market);
  useEffect(() => {
    eng?.setTradeLines([...(trading.lines as TradeLine[]), ...(replay.active ? [] : alertLines.lines)]);
    eng?.setExecutions(cfg.showExecutions !== false ? (trading.executions as Execution[]) : []);
  }, [eng, trading.lines, trading.executions, cfg.showExecutions, alertLines.lines, replay.active]);

  // ---------------------------------------------------------------- navigation requests (Strategy Tester)
  useEffect(() => {
    if (!eng) return;
    const offTrade = bus.on('chart:showTrade', (d: { symbol: string; market: string; from: number; to: number }) => {
      if (d.symbol !== cfg.symbol || d.market !== cfg.market) return;
      const pad = Math.max((d.to - d.from) * 0.6, tf ? tfDurationMs(tf) * 20 : 3600000);
      eng.showTimeRange(d.from - pad, d.to + pad);
    });
    const offTime = bus.on('chart:showTime', (d: { symbol: string; market: string; time: number }) => {
      if (d.symbol !== cfg.symbol || d.market !== cfg.market || !tf) return;
      const w = tfDurationMs(tf) * 60;
      eng.showTimeRange(d.time - w, d.time + w);
    });
    return () => {
      offTrade();
      offTime();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [eng, cfg.symbol, cfg.market, cfg.tf]);

  // ---------------------------------------------------------------- crosshair sync
  useEffect(() => {
    if (!eng) return;
    return bus.on('crosshair', (d: { time: number | null; from: string }) => {
      if (d.from === module.id) return;
      eng.setSyncedCrosshair(d.time);
    });
  }, [eng, module.id]);

  // ---------------------------------------------------------------- commands (shortcuts / palette)
  const cmdRef = useRef<(cmd: string, arg?: unknown) => void>(() => {});
  cmdRef.current = (cmd, arg) => {
    const e = engRef.current;
    switch (cmd) {
      case 'reset':
        e?.resetView();
        break;
      case 'tool':
        setShowTools(true);
        setTool(arg as DrawingType);
        e?.focus();
        break;
      case 'indicators':
        openIndicatorPicker(module.id, cfg);
        break;
      case 'addScript': {
        // add a script once (e.g. candlestick patterns from the command palette), then open its settings
        const id = String(arg);
        const have = (cfg.indicators || []).find((x) => x.scriptId === id);
        if (have) openIndicatorSettings(module.id, have.id);
        else addIndicator(module.id, id);
        break;
      }
      case 'snapshot': {
        const url = e?.snapshot();
        if (url) void api.call('clipboard:image', url).then(() => toast({ title: 'Chart snapshot copied', kind: 'ok' }));
        break;
      }
      case 'replay':
        replay.toggle?.();
        break;
    }
  };
  useEffect(() => bus.on('chart:cmd', (d: { moduleId: string; cmd: string; arg?: unknown }) => d.moduleId === module.id && cmdRef.current(d.cmd, d.arg)), [module.id]);

  // ---------------------------------------------------------------- engine callbacks
  const callbacksRef = useRef<import('../../chart/engine').EngineCallbacks>({});
  callbacksRef.current = {
    onCrosshair: (c) => {
      const pr = plusRef.current;
      if (!c) {
        setLegend({ index: -1, hover: false });
        bus.emit('crosshair', { time: null, from: module.id });
        // keep the "+" while the pointer moves onto it
        window.clearTimeout(pr.timer);
        pr.timer = window.setTimeout(() => !plusRef.current.hovered && setPlus(null), 250);
        return;
      }
      setLegend({ index: c.index, hover: true });
      bus.emit('crosshair', { time: c.time, from: module.id });
      const e = engRef.current;
      if (c.pane === 0 && e && c.y < e.plotH && Number.isFinite(c.price) && !replay.picking) {
        window.clearTimeout(pr.timer);
        setPlus((p) => (p && Math.abs(p.y - c.y) < 0.5 ? p : { y: c.y, price: c.price }));
      } else setPlus(null);
    },
    onViewChange: () => {
      const hidden = !!engRef.current?.latestHidden();
      setLatestHidden((h) => (h === hidden ? h : hidden));
    },
    onNeedHistory: () => {
      if (replay.active || !keyRef.current) return;
      void api.call('series:loadMore', keyRef.current, 2000).catch(() => {});
    },
    onDrawingsChange: (d) => update({ drawings: d }),
    onDrawingSelect: (id) => setSelectedDrawing(id),
    onToolDone: () => setTool(null),
    onTradeLineDrag: (id, price) => {
      if (!alertLines.onDrag(id, price)) trading.onDrag(id, price);
    },
    onTradeLineCancel: (id) => {
      if (!alertLines.onCancel(id)) trading.onCancel(id);
    },
    onBracketCreate: (posId, kind, price) => trading.onBracket(posId, kind, price),
    onPickBar: (time) => replay.onPickBar(time),
    onLayout: (geo) => setPanes(geo),
    onContextMenu: (info) => {
      const items: MenuItemSpec[] = [];
      const price = info.price;
      const pd = priceDecimals(cfg.symbol, cfg.market);
      if (info.drawingId) {
        const d = (cfg.drawings || []).find((x: Drawing) => x.id === info.drawingId) as Drawing | undefined;
        if (d) {
          const set = (patch: Partial<Drawing>) => update({ drawings: (cfg.drawings as Drawing[]).map((x) => (x.id === d.id ? { ...x, ...patch } : x)) });
          items.push(
            { title: 'Drawing' },
            { label: 'Edit…', icon: 'edit', onClick: () => setSelectedDrawing(d.id) },
            { label: d.locked ? 'Unlock' : 'Lock', icon: d.locked ? 'unlock' : 'lock', onClick: () => set({ locked: !d.locked }) },
            { label: 'Hide', icon: 'eyeOff', onClick: () => set({ hidden: true }) },
            { label: 'Duplicate', icon: 'copy', onClick: () => update({ drawings: [...(cfg.drawings as Drawing[]), { ...JSON.parse(JSON.stringify(d)), id: `d${Date.now().toString(36)}`, points: d.points.map((p) => ({ t: p.t, p: p.p * 1.002 })) }] }) },
            { label: 'Copy', icon: 'copy', hint: 'Paste on any chart', onClick: () => (drawingClipboard = [JSON.parse(JSON.stringify(d))]) },
            { label: 'Bring to front', icon: 'layers', onClick: () => update({ drawings: [...(cfg.drawings as Drawing[]).filter((x) => x.id !== d.id), d] }) },
            ...lineAlertItems(d, cfg),
            { label: 'Delete', icon: 'trash', danger: true, disabled: d.locked, onClick: () => update({ drawings: (cfg.drawings as Drawing[]).filter((x) => x.id !== d.id) }) },
            { sep: true },
          );
        }
      }
      items.push(...trading.contextItems(price, lastClose()));
      items.push(
        { label: `Add alert at ${fmtNum(price, pd)}`, icon: 'bell', onClick: () => bus.emit('alerts:create', { symbol: cfg.symbol, market: cfg.market, price }, false) },
        { label: `Horizontal line at ${fmtNum(price, pd)}`, icon: 'hline', onClick: () => update({ drawings: [...(cfg.drawings || []), { id: `d${Date.now().toString(36)}`, type: 'hline', points: [{ t: info.time, p: price }], color: settings.accent, width: 1.5, dash: 'solid' }] }) },
      );
      if (drawingClipboard.length) items.push({ label: 'Paste drawing', icon: 'copy', onClick: () => update({ drawings: [...(cfg.drawings || []), ...drawingClipboard.map((d) => ({ ...d, id: `d${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}` }))] }) });
      items.push({ sep: true }, { label: 'Reset chart view', icon: 'refresh', hint: 'Dbl-click axis', onClick: () => engRef.current?.resetView() }, { label: 'Scroll to latest', icon: 'chevRight', hint: 'End', onClick: () => engRef.current?.scrollToLatest() });
      setCtxItems(items);
      ctxMenu.open(null);
      setCtxAnchor({ x: info.clientX, y: info.clientY });
    },
  };
  const [ctxAnchor, setCtxAnchor] = useState<{ x: number; y: number } | null>(null);
  const lastClose = () => {
    const s = storeRef.current;
    return s.length ? s.c[s.length - 1] : NaN;
  };
  /** The "+" menu: orders at the price for the chart's account, an alert, a horizontal line. */
  const plusMenu = (price: number): MenuItemSpec[] => {
    const pd = priceDecimals(cfg.symbol, cfg.market);
    const items: MenuItemSpec[] = [...trading.contextItems(price, lastClose())];
    if (!items.length)
      items.push(
        { title: 'Trade' },
        trading.accountId && !trading.matches
          ? { label: `${trading.accountName || 'The selected account'} trades ${cfg.market === 'futures' ? 'spot' : 'futures'}`, disabled: true }
          : { label: 'New paper account to trade…', icon: 'plus', onClick: () => openCreateAccount(undefined, { market: cfg.market }) },
        { sep: true },
      );
    items.push(
      { label: `Add alert at ${fmtNum(price, pd)}`, icon: 'bell', onClick: () => bus.emit('alerts:create', { symbol: cfg.symbol, market: cfg.market, price }, false) },
      { label: `Horizontal line at ${fmtNum(price, pd)}`, icon: 'hline', onClick: () => update({ drawings: [...(cfg.drawings || []), { id: `d${Date.now().toString(36)}`, type: 'hline', points: [{ t: Date.now(), p: price }], color: settings.accent, width: 1.5, dash: 'solid' }] }) },
    );
    return items;
  };
  useEffect(() => {
    eng?.setCallbacks(callbacksRef.current);
  });

  // ---------------------------------------------------------------- legend data
  const store = storeRef.current;
  const li = legend.index >= 0 && legend.index < store.length ? legend.index : store.length - 1;
  void liveTick;
  const changeSymbol = (s: SymbolId, m: Market) => update({ symbol: s, market: m });

  const typeMenu = usePopover();
  const scaleBtn = (mode: 'linear' | 'log' | 'percent', label: string, tip: string) => (
    <button className={clsx('axis-btn', cfg.scale === mode && 'on')} onClick={() => update({ scale: cfg.scale === mode ? 'linear' : mode })} data-tip={tip}>
      {label}
    </button>
  );

  return (
    <div className={clsx('chart-module', replay.picking && 'picking')}>
      <HeadControls>
        <SymbolPicker symbol={cfg.symbol} market={cfg.market} onChange={changeSymbol} />
        <div className="vsep" />
        <TimeframePicker tf={cfg.tf} onChange={(t) => update({ tf: t })} />
        <div className="vsep" />
        <button className="icon-btn" onClick={(e) => typeMenu.toggle(e.currentTarget)} data-tip={`Chart type: ${CHART_TYPES.find((c) => c.value === cfg.chartType)?.label}`}>
          <Icon name={CHART_TYPES.find((c) => c.value === cfg.chartType)?.icon || 'candles'} />
        </button>
        {typeMenu.anchor && (
          <Menu
            anchor={typeMenu.anchor}
            onClose={typeMenu.close}
            items={[
              ...CHART_TYPES.map((c) => ({ label: c.label, checked: cfg.chartType === c.value, onClick: () => update({ chartType: c.value }) })),
              ...(cfg.chartType === 'renko'
                ? [
                    { sep: true },
                    {
                      label: `Renko box: ${cfg.renko?.boxSize ? fmtNum(cfg.renko.boxSize, 2) : `ATR(${cfg.renko?.atrLength || 14})`}…`,
                      onClick: async () => {
                        const v = await promptDialog({ title: 'Renko box size', label: 'Fixed box size in price units, or "atr14" for ATR-based', initial: cfg.renko?.boxSize ? String(cfg.renko.boxSize) : `atr${cfg.renko?.atrLength || 14}` });
                        if (!v) return;
                        const m = /^atr(\d+)$/i.exec(v.trim());
                        if (m) update({ renko: { ...(cfg.renko || {}), boxSize: undefined, atrLength: +m[1] } });
                        else if (+v > 0) update({ renko: { ...(cfg.renko || {}), boxSize: +v, atrLength: undefined } });
                      },
                    },
                    { label: `Source: ${cfg.renko?.source === 'hl' ? 'High/Low' : 'Close'}`, onClick: () => update({ renko: { ...(cfg.renko || {}), source: cfg.renko?.source === 'hl' ? 'close' : 'hl' } }) },
                  ]
                : []),
              ...(cfg.chartType === 'footprint'
                ? (() => {
                    const fpc = { group: 0, mode: 'bidask' as const, imbalanceRatio: 3, ...(cfg.footprint || {}) };
                    const setFp = (patch: Partial<typeof fpc>) => update({ footprint: { ...fpc, ...patch } });
                    return [
                      { title: 'Footprint cells' },
                      { label: 'Sell × Buy volume', checked: fpc.mode === 'bidask', onClick: () => setFp({ mode: 'bidask' }) },
                      { label: 'Delta (buy − sell)', checked: fpc.mode === 'delta', onClick: () => setFp({ mode: 'delta' }) },
                      { label: 'Total volume', checked: fpc.mode === 'volume', onClick: () => setFp({ mode: 'volume' }) },
                      { title: 'Stacked imbalance ratio' },
                      ...[2, 3, 4].map((r) => ({ label: `${r}× (diagonal)`, checked: fpc.imbalanceRatio === r, onClick: () => setFp({ imbalanceRatio: r }) })),
                      {
                        label: `Row size: ${fpc.group ? fmtNum(fpc.group, 2) : 'auto'}…`,
                        onClick: async () => {
                          const v = await promptDialog({ title: 'Footprint row size', label: 'Price step per row (empty = automatic, adapts to zoom)', initial: fpc.group ? String(fpc.group) : '' });
                          if (v === null) return;
                          setFp({ group: +v > 0 ? +v : 0 });
                        },
                      },
                    ];
                  })()
                : []),
            ]}
          />
        )}
        <button className="btn ghost small" onClick={() => openIndicatorPicker(module.id, cfg)} data-tip="Indicators & strategies (/)">
          <Icon name="flow" size={15} /> Indicators
        </button>
        <CompareButton cfg={cfg} update={update} />
        <OverlaysButton cfg={cfg} update={update} />
        <ReplayButton replay={replay} />
        {!replay.active && <OtherMarketPosition symbol={cfg.symbol} market={cfg.market} onSwitch={(m) => changeSymbol(cfg.symbol, m)} />}
        <div className="spacer" />
        <StatusBadge status={replay.active ? 'replay' : status} info={info} />
      </HeadControls>
      <div className="chart-body">
        {showTools && <DrawingToolbar tool={tool} setTool={setTool} magnet={magnet} setMagnet={setMagnet} onClear={() => update({ drawings: [] })} hidden={(cfg.drawings || []).every((d: Drawing) => d.hidden) && (cfg.drawings || []).length > 0} onToggleHidden={() => {
          const all = (cfg.drawings || []) as Drawing[];
          const anyVisible = all.some((d) => !d.hidden);
          update({ drawings: all.map((d) => ({ ...d, hidden: anyVisible })) });
        }} />}
        <div className="chart-host-wrap">
          <div ref={hostRef} className="chart-host" />
          <div className="chart-legend">
            <div className="legend-row">
              <button className="legend-title" onClick={() => setShowTools(!showTools)} data-tip="Toggle drawing tools">
                <CoinIcon symbol={cfg.symbol} size={14} />
                {SYMBOL_SPECS[cfg.symbol].base}/{SYMBOL_SPECS[cfg.symbol].quote}
                {cfg.market === 'futures' ? ' Perp' : ''} · {cfg.tf}
                {cfg.chartType === 'heikinashi' ? ' · HA' : cfg.chartType === 'renko' ? ` · Renko ${info?.renkoBox ? fmtNum(info.renkoBox, 2) : ''}` : ''}
              </button>
              {li >= 0 && store.length > 0 && <OhlcLegend store={store} i={li} symbol={cfg.symbol} market={cfg.market} />}
            </div>
            {info?.error && <div className="legend-error">{info.error}</div>}
            <IndicatorLegend moduleId={module.id} cfg={cfg} outputs={indicators.outputs} lives={indicators.lives} index={li} store={store} update={update} />
          </div>
          <PaneLegends moduleId={module.id} cfg={cfg} outputs={indicators.outputs} lives={indicators.lives} index={li} store={store} update={update} panes={panes} />
          {replay.overlay}
          {fp.overlay}
          <div className="axis-btns">
            {scaleBtn('percent', '%', 'Percentage scale')}
            {scaleBtn('log', 'log', 'Logarithmic scale')}
            <button className="axis-btn" onClick={() => engRef.current?.resetView()} data-tip="Auto-fit (reset view)">
              auto
            </button>
          </div>
          {plus && eng && !replay.picking && (
            <button
              className="chart-plus"
              style={{ left: eng.plotW - 22, top: plus.y - 9 }}
              data-tip="Order, alert or line at this price"
              onMouseEnter={() => {
                plusRef.current.hovered = true;
                window.clearTimeout(plusRef.current.timer);
              }}
              onMouseLeave={() => {
                plusRef.current.hovered = false;
                plusRef.current.timer = window.setTimeout(() => setPlus(null), 250);
              }}
              onClick={(ev) => {
                const r = ev.currentTarget.getBoundingClientRect();
                setCtxItems(plusMenu(plus.price));
                setCtxAnchor({ x: r.right + 4, y: r.top });
              }}
            >
              <Icon name="plus" size={12} />
            </button>
          )}
          {latestHidden && eng && (
            <button className="chart-latest" style={{ left: eng.plotW - 62, top: eng.plotH - 36 }} onClick={() => engRef.current?.scrollToLatest(true)} data-tip="Back to the latest bar (End)">
              <Icon name="chevRight" size={13} />
              <Icon name="chevRight" size={13} style={{ marginLeft: -8 }} />
            </button>
          )}
          {selectedDrawing && (cfg.drawings || []).some((d: Drawing) => d.id === selectedDrawing) && (
            <DrawingEditor
              drawing={(cfg.drawings as Drawing[]).find((d) => d.id === selectedDrawing)!}
              onChange={(d) => update({ drawings: (cfg.drawings as Drawing[]).map((x) => (x.id === d.id ? d : x)) })}
              onDelete={() => {
                update({ drawings: (cfg.drawings as Drawing[]).filter((x) => x.id !== selectedDrawing) });
                setSelectedDrawing(null);
              }}
              onClose={() => setSelectedDrawing(null)}
            />
          )}
        </div>
      </div>
      {ctxAnchor && <Menu anchor={ctxAnchor} items={ctxItems} onClose={() => setCtxAnchor(null)} width={250} />}
    </div>
  );
}

function OhlcLegend({ store, i, symbol, market }: { store: BarStore; i: number; symbol: SymbolId; market: Market }) {
  const d = priceDecimals(symbol, market);
  const o = store.o[i];
  const c = store.c[i];
  const prev = i > 0 ? store.c[i - 1] : o;
  const ch = c - prev;
  const cls = c >= o ? 'up' : 'down';
  return (
    <span className="legend-ohlc num">
      <span>
        O<b className={cls}>{fmtNum(o, d)}</b>
      </span>
      <span>
        H<b className={cls}>{fmtNum(store.h[i], d)}</b>
      </span>
      <span>
        L<b className={cls}>{fmtNum(store.l[i], d)}</b>
      </span>
      <span>
        C<b className={cls}>{fmtNum(c, d)}</b>
      </span>
      <b className={ch >= 0 ? 'up' : 'down'}>
        {ch >= 0 ? '+' : ''}
        {fmtNum(ch, d)} ({fmtPct((ch / prev) * 100, 2)})
      </b>
      <span>
        Vol<b>{formatVolume(store.v[i])}</b>
      </span>
      <span className="faint">{fmtDateTime(store.t[i])}</span>
    </span>
  );
}

function StatusBadge({ status, info }: { status: SeriesStatus | 'replay'; info: SeriesInfo | null }) {
  const map: Record<string, [string, string]> = {
    live: ['ok', 'Live'],
    loading: ['', 'Loading'],
    syncing: ['', 'Syncing'],
    reconnecting: ['warn', 'Reconnecting'],
    degraded: ['warn', 'Healing gap'],
    error: ['danger', 'Error'],
    replay: ['warn', 'Replay'],
  };
  const [cls, label] = map[status] || ['', status];
  const tip = [info?.construction, info?.error, status === 'degraded' ? 'A trade-stream gap was detected. Candles are corrected automatically from authoritative Binance klines.' : ''].filter(Boolean).join('\n');
  return (
    <span className={clsx('badge', cls)} data-tip={tip || undefined}>
      {status === 'live' && <span className="dot" style={{ background: 'var(--ok)', width: 6, height: 6 }} />}
      {(status === 'loading' || status === 'syncing') && <span className="spinner" style={{ width: 10, height: 10, borderWidth: 1.5 }} />}
      {label}
    </span>
  );
}

function CompareButton({ cfg, update }: { cfg: ChartModuleConfig; update: (p: Partial<ChartModuleConfig>) => void }) {
  const pop = usePopover();
  const list = cfg.compare || [];
  const toggle = (symbol: SymbolId, market: Market) => {
    const exists = list.find((c) => c.symbol === symbol && c.market === market);
    const next = exists ? list.filter((c) => c !== exists) : [...list, { symbol, market, color: COMPARE_COLORS[list.length % COMPARE_COLORS.length] }];
    update({ compare: next, scale: next.length && !list.length ? 'percent' : !next.length && cfg.scale === 'percent' ? 'linear' : cfg.scale });
  };
  return (
    <>
      <button className={clsx('icon-btn', list.length > 0 && 'active')} onClick={(e) => pop.toggle(e.currentTarget)} data-tip="Compare / overlay symbols">
        <Icon name="plus" />
      </button>
      {pop.anchor && (
        <Popover anchor={pop.anchor} onClose={pop.close} width={250}>
          <div className="menu-title">Compare performance</div>
          {(['spot', 'futures'] as Market[]).flatMap((m) =>
            SYMBOLS.filter((s) => !(s === cfg.symbol && m === cfg.market)).map((s) => {
              const on = !!list.find((c) => c.symbol === s && c.market === m);
              return (
                <div key={`${m}${s}`} className="menu-item" onClick={() => toggle(s, m)}>
                  <Icon name="check" size={14} style={{ opacity: on ? 1 : 0 }} />
                  <CoinIcon symbol={s} size={14} />
                  {SYMBOL_SPECS[s].base}
                  <span className="menu-hint">{m === 'futures' ? 'PERP' : 'SPOT'}</span>
                </div>
              );
            }),
          )}
          <div className="hint" style={{ padding: '6px 9px' }}>
            Overlays are drawn on a percentage scale relative to the first visible bar, so assets with different prices are directly comparable.
          </div>
        </Popover>
      )}
    </>
  );
}

function OverlaysButton({ cfg, update }: { cfg: ChartModuleConfig; update: (p: Partial<ChartModuleConfig>) => void }) {
  const pop = usePopover();
  const vp = cfg.volumeProfile || { mode: 'off', rows: 24, valueArea: 70 };
  const mtf = cfg.mtf || [];
  const active = vp.mode !== 'off' || mtf.length > 0;
  return (
    <>
      <button className={clsx('icon-btn', active && 'active')} onClick={(e) => pop.toggle(e.currentTarget)} data-tip="Volume profile, higher-timeframe overlays, display">
        <Icon name="layers" />
      </button>
      {pop.anchor && (
        <Popover anchor={pop.anchor} onClose={pop.close} width={300}>
          <div style={{ padding: 8 }} className="col">
            <div className="section-title">Volume profile</div>
            <Segmented
              value={vp.mode}
              onChange={(m) => update({ volumeProfile: { ...vp, mode: m as any } })}
              options={[
                { value: 'off', label: 'Off' },
                { value: 'visible', label: 'Visible', title: 'Profile of the visible range' },
                { value: 'session', label: 'Session', title: 'One profile per UTC day' },
                { value: 'fixed', label: 'Fixed', title: 'A fixed time range' },
              ]}
            />
            {vp.mode !== 'off' && (
              <div className="row">
                <div className="field grow">
                  <label>Rows</label>
                  <NumberField value={vp.rows} min={6} max={200} onChange={(v) => update({ volumeProfile: { ...vp, rows: Math.round(v) } })} />
                </div>
                <div className="field grow">
                  <label>Value area %</label>
                  <NumberField value={vp.valueArea} min={10} max={99} onChange={(v) => update({ volumeProfile: { ...vp, valueArea: v } })} />
                </div>
              </div>
            )}
            {vp.mode === 'fixed' && (
              <button className="btn small" onClick={() => bus.emit('chart:pickRange', { moduleId: '' }, false)}>
                Use the visible range as fixed range
              </button>
            )}
            {vp.mode !== 'off' && <div className="hint">Uses trade-level data where loaded (exact); otherwise each candle's volume is spread over its high–low range and the profile is marked as approximate.</div>}
            <div className="menu-sep" />
            <div className="section-title">Higher-timeframe overlay</div>
            {mtf.map((m, k) => (
              <div key={k} className="row">
                <span className="badge accent">{m.tf}</span>
                <Segmented value={m.style} onChange={(s) => update({ mtf: mtf.map((x, j) => (j === k ? { ...x, style: s as 'boxes' | 'line' } : x)) })} options={[{ value: 'boxes', label: 'Boxes' }, { value: 'line', label: 'Close line' }]} />
                <div className="spacer" />
                <button className="icon-btn small" onClick={() => update({ mtf: mtf.filter((_, j) => j !== k) })}>
                  <Icon name="x" size={14} />
                </button>
              </div>
            ))}
            <div className="row" style={{ flexWrap: 'wrap', gap: 4 }}>
              {['15m', '1h', '4h', '1D', '1W'].map((t) => (
                <button key={t} className="btn small" onClick={() => update({ mtf: [...mtf, { tf: t, style: 'boxes' }] })}>
                  + {t}
                </button>
              ))}
            </div>
            <div className="menu-sep" />
            <div className="row">
              <span className="grow">Volume</span>
              <Toggle value={cfg.showVolume !== false} onChange={(v) => update({ showVolume: v })} />
            </div>
            <div className="row">
              <span className="grow">Paper-trade executions</span>
              <Toggle value={cfg.showExecutions !== false} onChange={(v) => update({ showExecutions: v })} />
            </div>
          </div>
        </Popover>
      )}
    </>
  );
}

/** Subscribe to compare and higher-timeframe series and feed them to the engine. */
function useCompareAndMtf(eng: ChartEngine | null, cfg: ChartModuleConfig, dataVersion: number) {
  const compareKey = JSON.stringify((cfg.compare || []).map((c) => [c.symbol, c.market, c.color]));
  const mtfKey = JSON.stringify(cfg.mtf || []);
  useEffect(() => {
    if (!eng) return;
    const list = cfg.compare || [];
    const stores = list.map(() => new BarStore());
    const push = () =>
      eng.setCompare(
        list.map((c, k) => ({ id: `${c.market}:${c.symbol}`, label: SYMBOL_SPECS[c.symbol].base + (c.market === 'futures' ? ' Perp' : ''), color: c.color || COMPARE_COLORS[k % COMPARE_COLORS.length], t: stores[k].t, c: stores[k].c, length: stores[k].length })).filter((x) => x.length > 0),
      );
    const unsubs = list.map((c, k) => subscribeBars({ symbol: c.symbol, market: c.market, tf: cfg.tf }, stores[k], push));
    if (!list.length) eng.setCompare([]);
    return () => unsubs.forEach((u) => u());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [eng, compareKey, cfg.tf]);

  useEffect(() => {
    if (!eng) return;
    const list = (cfg.mtf || []).filter((m) => parseTimeframe(m.tf));
    const stores = list.map(() => new BarStore());
    const push = () =>
      eng.setMtf(
        list.map((m, k) => {
          const tf = parseTimeframe(m.tf)!;
          const st = stores[k];
          const ends = new Float64Array(st.length);
          for (let j = 0; j < st.length; j++) ends[j] = bucketEnd(tf, st.t[j]);
          return { id: `mtf${k}`, tf: m.tf, style: m.style, color: m.color || '', bars: st.bars(), ends } as MtfSeries;
        }),
      );
    const unsubs = list.map((m, k) => subscribeBars({ symbol: cfg.symbol, market: cfg.market, tf: m.tf }, stores[k], push));
    if (!list.length) eng.setMtf([]);
    return () => unsubs.forEach((u) => u());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [eng, mtfKey, cfg.symbol, cfg.market]);
  void dataVersion;
}

/** Keep a BarStore in sync with a series subscription; calls onChange (rAF-throttled). */
/** "Add alert" items for line drawings: a trendline alert follows the line, a horizontal line is a price level. */
function lineAlertItems(d: Drawing, cfg: ChartModuleConfig): MenuItemSpec[] {
  const [a, b] = d.points;
  if (d.type === 'hline' && a) return [{ label: 'Add alert on this line…', icon: 'bell', onClick: () => bus.emit('alerts:create', { symbol: cfg.symbol, market: cfg.market, price: a.p }, false) }];
  if (!(d.type === 'trend' || d.type === 'ray' || d.type === 'extended') || !a || !b || a.t === b.t) return [];
  // a segment ends at its later point; rays continue in their direction, extended lines both ways
  const extend: AlertLine['extend'] = d.type === 'trend' || (d.type === 'ray' && b.t < a.t) ? 'none' : 'right';
  const line: AlertLine = { t1: a.t, p1: a.p, t2: b.t, p2: b.p, log: cfg.scale === 'log', extend };
  const level = priceLevelAt({ level: a.p, line }, Date.now());
  return [
    {
      label: 'Add alert on this line…',
      icon: 'bell',
      hint: extend === 'none' ? 'until its end' : undefined,
      disabled: level === null,
      onClick: () => bus.emit('alerts:new', { kind: 'price', symbol: cfg.symbol, market: cfg.market, patch: { condition: 'crosses', level: level ?? a.p, line } }, false),
    },
  ];
}

export function subscribeBars(spec: { symbol: SymbolId; market: Market; tf: string }, store: BarStore, onChange: () => void): () => void {
  let raf = 0;
  const changed = () => {
    if (raf) return;
    raf = requestAnimationFrame(() => {
      raf = 0;
      onChange();
    });
  };
  const unsub = api.sub<any>('series', { ...spec, chartType: 'candles' }, (msg) => {
    if (msg.__error) return;
    if (msg.type === 'snapshot') store.setPacked(msg.packed);
    else store.apply(msg.index, msg.packed, msg.length);
    changed();
  });
  return () => {
    cancelAnimationFrame(raf);
    unsub();
  };
}

export type { IndicatorOutput };
export { toast, errorMessage };
