/** Minimal stroke icon set (24x24 grid, rendered at 16px). */
const P: Record<string, string> = {
  chart: 'M4 19V5 M4 19h16 M8 15v-4 M8 11h0 M12 14V7 M16 16v-6 M7 11h2 M11 7h2 M15 10h2',
  candles: 'M7 4v3 M7 15v5 M5 7h4v8H5z M17 3v5 M17 16v4 M15 8h4v8h-4z',
  book: 'M4 6h7 M4 10h5 M4 14h8 M4 18h4 M20 6h-6 M20 10h-8 M20 14h-5 M20 18h-9',
  depth: 'M3 19h18 M3 19l4-3 3-4 2-6 M21 19l-4-2-3-5-2-6',
  heat: 'M3 5h4v3H3z M9 5h4v3H9z M15 5h6v3h-6z M3 10h6v4H3z M11 10h4v4h-4z M17 10h4v4h-4z M3 16h3v3H3z M8 16h7v3H8z M17 16h4v3h-4z',
  list: 'M8 6h12 M8 12h12 M8 18h12 M4 6h0.01 M4 12h0.01 M4 18h0.01',
  star: 'M12 3l2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1L3.2 9.5l6.1-.9z',
  wallet: 'M3 7a2 2 0 0 1 2-2h13v4 M3 7v10a2 2 0 0 0 2 2h15V9H5a2 2 0 0 1-2-2z M16 14h.01',
  trade: 'M7 17L17 7 M9 7h8v8',
  code: 'M9 7l-5 5 5 5 M15 7l5 5-5 5',
  flask: 'M9 3h6 M10 3v6L4.5 18.5A1.5 1.5 0 0 0 5.8 21h12.4a1.5 1.5 0 0 0 1.3-2.5L14 9V3 M7 15h10',
  grid: 'M4 4h7v7H4z M13 4h7v7h-7z M4 13h7v7H4z M13 13h7v7h-7z',
  notebook: 'M6 3h12a1 1 0 0 1 1 1v16a1 1 0 0 1-1 1H6z M6 3v18 M3 7h3 M3 12h3 M3 17h3 M10 8h6 M10 12h6',
  bell: 'M6 16V11a6 6 0 1 1 12 0v5l2 2H4z M10 20a2 2 0 0 0 4 0',
  news: 'M4 5h13v14H6a2 2 0 0 1-2-2z M17 9h3v8a2 2 0 0 1-2 2 M7 9h7 M7 12h7 M7 15h4',
  spark: 'M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z M19 16l.8 2.2L22 19l-2.2.8L19 22l-.8-2.2L16 19l2.2-.8z',
  bot: 'M5 9h14v10H5z M12 4v5 M9 13h.01 M15 13h.01 M9 16h6 M3 13v3 M21 13v3 M12 4h0',
  database: 'M4 6c0-1.7 3.6-3 8-3s8 1.3 8 3-3.6 3-8 3-8-1.3-8-3z M4 6v6c0 1.7 3.6 3 8 3s8-1.3 8-3V6 M4 12v6c0 1.7 3.6 3 8 3s8-1.3 8-3v-6',
  shield: 'M12 3l8 3v6c0 4.5-3.4 8.3-8 9-4.6-.7-8-4.5-8-9V6z M9 12l2 2 4-4',
  plus: 'M12 5v14 M5 12h14',
  x: 'M6 6l12 12 M18 6L6 18',
  more: 'M5 12h.01 M12 12h.01 M19 12h.01',
  chevDown: 'M6 9l6 6 6-6',
  chevRight: 'M9 6l6 6-6 6',
  chevLeft: 'M15 6l-6 6 6 6',
  chevUp: 'M6 15l6-6 6 6',
  gear: 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z',
  sun: 'M12 16a4 4 0 1 0 0-8 4 4 0 0 0 0 8z M12 2v2 M12 20v2 M4.9 4.9l1.4 1.4 M17.7 17.7l1.4 1.4 M2 12h2 M20 12h2 M4.9 19.1l1.4-1.4 M17.7 6.3l1.4-1.4',
  moon: 'M20 14.5A8 8 0 0 1 9.5 4 8 8 0 1 0 20 14.5z',
  search: 'M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14z M20 20l-4-4',
  play: 'M7 5l12 7-12 7z',
  pause: 'M8 5v14 M16 5v14',
  step: 'M6 5l9 7-9 7z M18 5v14',
  stop: 'M6 6h12v12H6z',
  replay: 'M3 12a9 9 0 1 0 3-6.7 M3 4v5h5 M10 9l5 3-5 3z',
  detach: 'M14 4h6v6 M20 4l-8 8 M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5',
  attach: 'M10 14L4 20 M4 14v6h6 M14 4h5a1 1 0 0 1 1 1v12a1 1 0 0 1-1 1h-5 M10 4H6',
  copy: 'M9 9h10v11H9z M5 15V4h10',
  link: 'M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1 M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1',
  lock: 'M6 11h12v9H6z M8 11V8a4 4 0 0 1 8 0v3',
  unlock: 'M6 11h12v9H6z M8 11V8a4 4 0 0 1 7.5-2',
  eye: 'M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z',
  eyeOff: 'M3 3l18 18 M10.6 5.1A10 10 0 0 1 12 5c6.5 0 10 7 10 7a17 17 0 0 1-3.2 4 M6.6 6.6A17 17 0 0 0 2 12s3.5 7 10 7a9.6 9.6 0 0 0 5.4-1.6 M9.9 9.9a3 3 0 0 0 4.2 4.2',
  trash: 'M4 7h16 M10 11v6 M14 11v6 M6 7l1 13h10l1-13 M9 7V4h6v3',
  edit: 'M4 20h4L19 9l-4-4L4 16z M14 6l4 4',
  save: 'M5 3h11l3 3v15H5z M8 3v6h8 M8 21v-7h8v7',
  folder: 'M3 6a1 1 0 0 1 1-1h5l2 2h9a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1z',
  check: 'M5 12l5 5 9-10',
  alert: 'M12 4L2.5 20h19z M12 10v4 M12 17h.01',
  info: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z M12 11v5 M12 8h.01',
  keyboard: 'M3 6h18v12H3z M7 10h.01 M11 10h.01 M15 10h.01 M7 14h10',
  cursor: 'M5 3l14 7-6 2-2 6z',
  cross: 'M12 3v18 M3 12h18',
  hline: 'M3 12h18 M3 12h0',
  vline: 'M12 3v18',
  trend: 'M4 19L20 5 M4 19h.01 M20 5h.01',
  ray: 'M4 18L21 6 M4 18h.01',
  channel: 'M3 15L17 5 M7 19L21 9',
  fib: 'M3 5h18 M3 10h18 M3 14h18 M3 19h18 M5 19L19 5',
  fibExt: 'M3 5h18 M3 12h18 M3 19h18 M5 19l5-7 4 4 5-11',
  fibTime: 'M4 4v16 M8 4v16 M12 4v16 M18 4v16',
  text: 'M5 6V4h14v2 M12 4v16 M9 20h6',
  rect: 'M4 6h16v12H4z',
  magnet: 'M6 4v8a6 6 0 0 0 12 0V4 M6 8h4 M14 8h4 M10 4v8a2 2 0 0 0 4 0V4',
  percent: 'M19 5L5 19 M7 9a2 2 0 1 0 0-4 2 2 0 0 0 0 4z M17 19a2 2 0 1 0 0-4 2 2 0 0 0 0 4z',
  layers: 'M12 3l9 5-9 5-9-5z M3 13l9 5 9-5',
  camera: 'M4 8h3l2-3h6l2 3h3v11H4z M12 17a4 4 0 1 0 0-8 4 4 0 0 0 0 8z',
  download: 'M12 4v12 M7 11l5 5 5-5 M5 20h14',
  upload: 'M12 20V8 M7 13l5-5 5 5 M5 4h14',
  refresh: 'M20 11a8 8 0 0 0-14.9-3 M4 4v4h4 M4 13a8 8 0 0 0 14.9 3 M20 20v-4h-4',
  filter: 'M4 5h16l-6 8v6l-4-2v-4z',
  arrowUp: 'M12 19V5 M6 11l6-6 6 6',
  arrowDown: 'M12 5v14 M6 13l6 6 6-6',
  pin: 'M15 4l5 5-3 1-4 4 1 4-2 2-4-4-5 5 5-5-4-4 2-2 4 1 4-4z',
  home: 'M3 11l9-7 9 7 M5 10v10h14V10',
  sliders: 'M4 6h10 M18 6h2 M4 12h4 M12 12h8 M4 18h12 M20 18h0 M16 4v4 M10 10v4 M18 16v4',
  zap: 'M13 2L4 14h7l-1 8 9-12h-7z',
  target: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z M12 16a4 4 0 1 0 0-8 4 4 0 0 0 0 8z M12 12h.01',
  max: 'M4 9V4h5 M20 9V4h-5 M4 15v5h5 M20 15v5h-5',
  layout: 'M3 4h18v16H3z M3 9h18 M9 9v11',
  log: 'M4 20c4-1 6-5 8-9s5-7 8-7',
  flow: 'M5 4h6v4H5z M13 16h6v4h-6z M8 8v4h8v4 M5 16h4v4H5z M7 12v4',
  bug: 'M8 9h8v7a4 4 0 0 1-8 0z M9 9V7a3 3 0 0 1 6 0v2 M4 12h4 M16 12h4 M5 7l3 2 M19 7l-3 2 M5 19l3-2 M19 19l-3-2',
  stepInto: 'M12 4v10 M8 10l4 4 4-4 M6 20h12',
  stepOver: 'M4 14a8 8 0 0 1 15-4 M20 6v4h-4 M12 18h.01',
  fastFwd: 'M4 6l7 6-7 6z M13 6l7 6-7 6z',
  slow: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z M12 7v5l3 3',
  send: 'M4 12l16-8-6 16-3-7z',
  user: 'M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8z M4 21a8 8 0 0 1 16 0',
  history: 'M3 12a9 9 0 1 0 3-6.7 M3 4v5h5 M12 7v5l4 2',
  measure: 'M3 17L17 3l4 4L7 21z M7 13l2 2 M10 10l2 2 M13 7l2 2',
  undo: 'M9 14L4 9l5-5 M4 9h10a6 6 0 0 1 0 12h-3',
  external: 'M14 4h6v6 M20 4l-9 9 M18 14v5H5V6h5',
};

export type IconName = keyof typeof P;

export function Icon({ name, size = 16, stroke = 1.7, className, style }: { name: IconName | string; size?: number; stroke?: number; className?: string; style?: React.CSSProperties }) {
  const d = P[name] || P.info;
  return (
    <svg className={className} style={style} width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={stroke} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d={d} />
    </svg>
  );
}

export function CoinIcon({ symbol, size = 16 }: { symbol: string; size?: number }) {
  const map: Record<string, [string, string]> = {
    BTCUSDT: ['#F7931A', '₿'],
    ETHUSDT: ['#627EEA', 'Ξ'],
    SOLUSDT: ['#9945FF', 'S'],
  };
  const [bg, ch] = map[symbol] || ['#666', '?'];
  const g = symbol === 'SOLUSDT' ? 'linear-gradient(135deg,#9945FF,#14F195)' : bg;
  return (
    <span className="coin" style={{ width: size, height: size, background: g, fontSize: size * 0.58 }}>
      {ch}
    </span>
  );
}
