import type { Drawing, DrawingType } from '../../chart/types';
import { FIB_LEVELS, FIB_EXT_LEVELS, FIB_TIME } from '../../chart/types';
import { Icon } from '../../components/Icon';
import { Segmented, NumberField, Toggle } from '../../components/ui';
import { clsx } from '../../lib/format';

const TOOLS: { type: DrawingType; icon: string; label: string; key?: string }[] = [
  { type: 'trend', icon: 'trend', label: 'Trend line', key: 'Alt+T' },
  { type: 'ray', icon: 'ray', label: 'Ray' },
  { type: 'extended', icon: 'trend', label: 'Extended line' },
  { type: 'hline', icon: 'hline', label: 'Horizontal line', key: 'Alt+H' },
  { type: 'hray', icon: 'hline', label: 'Horizontal ray' },
  { type: 'vline', icon: 'vline', label: 'Vertical line', key: 'Alt+V' },
  { type: 'channel', icon: 'channel', label: 'Parallel channel' },
  { type: 'fib', icon: 'fib', label: 'Fib retracement', key: 'Alt+F' },
  { type: 'fibext', icon: 'fibExt', label: 'Trend-based Fib extension' },
  { type: 'fibtime', icon: 'fibTime', label: 'Fib time zones' },
  { type: 'rect', icon: 'rect', label: 'Rectangle' },
  { type: 'text', icon: 'text', label: 'Text' },
  { type: 'measure', icon: 'measure', label: 'Measure' },
];

export function DrawingToolbar({ tool, setTool, magnet, setMagnet, onClear, hidden, onToggleHidden }: { tool: DrawingType | null; setTool: (t: DrawingType | null) => void; magnet: boolean; setMagnet: (v: boolean) => void; onClear: () => void; hidden: boolean; onToggleHidden: () => void }) {
  return (
    <div className="draw-toolbar">
      <button className={clsx('icon-btn', !tool && 'active')} onClick={() => setTool(null)} data-tip="Cursor (Esc)">
        <Icon name="cursor" />
      </button>
      <div className="tb-sep" />
      {TOOLS.map((t) => (
        <button key={t.type} className={clsx('icon-btn', tool === t.type && 'active')} onClick={() => setTool(tool === t.type ? null : t.type)} data-tip={`${t.label}${t.key ? ` (${t.key})` : ''}`}>
          <Icon name={t.icon} style={t.type === 'extended' ? { transform: 'scaleX(1.2)' } : t.type === 'hray' ? { clipPath: 'inset(0 0 0 40%)' } : undefined} />
        </button>
      ))}
      <div className="tb-sep" />
      <button className={clsx('icon-btn', magnet && 'active')} onClick={() => setMagnet(!magnet)} data-tip="Magnet: snap to OHLC">
        <Icon name="magnet" />
      </button>
      <button className={clsx('icon-btn', hidden && 'active')} onClick={onToggleHidden} data-tip="Hide / show all drawings">
        <Icon name={hidden ? 'eyeOff' : 'eye'} />
      </button>
      <button className="icon-btn" onClick={onClear} data-tip="Remove all drawings">
        <Icon name="trash" />
      </button>
    </div>
  );
}

const SWATCHES = ['#2962ff', '#26a69a', '#ef5350', '#f59e0b', '#a855f7', '#ec4899', '#14b8a6', '#e5e7eb', '#787b86'];

export function DrawingEditor({ drawing, onChange, onDelete, onClose }: { drawing: Drawing; onChange: (d: Drawing) => void; onDelete: () => void; onClose: () => void }) {
  const d = drawing;
  const set = (p: Partial<Drawing>) => onChange({ ...d, ...p });
  const isFib = d.type === 'fib' || d.type === 'fibext' || d.type === 'fibtime';
  return (
    <div className="drawing-editor" onMouseDown={(e) => e.stopPropagation()}>
      <div className="row" style={{ gap: 4 }}>
        {SWATCHES.map((c) => (
          <button key={c} className={clsx('swatch', d.color === c && 'on')} style={{ background: c }} onClick={() => set({ color: c, fill: d.fill ? `${c}22` : d.fill })} />
        ))}
      </div>
      <div className="row">
        <Segmented value={String(d.width)} onChange={(v) => set({ width: +v })} options={[{ value: '1', label: '1px' }, { value: '1.5', label: '1.5' }, { value: '2', label: '2px' }, { value: '3', label: '3px' }]} />
        <Segmented value={d.dash} onChange={(v) => set({ dash: v as Drawing['dash'] })} options={[{ value: 'solid', label: '—' }, { value: 'dashed', label: '- -' }, { value: 'dotted', label: '···' }]} />
      </div>
      {d.type === 'text' && <input className="input" value={d.text || ''} onChange={(e) => set({ text: e.target.value })} placeholder="Text" />}
      {(d.type === 'trend' || d.type === 'fib' || d.type === 'fibext') && (
        <div className="row">
          {d.type === 'trend' && (
            <>
              <span className="muted">Extend left</span>
              <Toggle value={!!d.extendLeft} onChange={(v) => set({ extendLeft: v })} />
            </>
          )}
          <span className="muted">Extend right</span>
          <Toggle value={!!d.extendRight} onChange={(v) => set({ extendRight: v })} />
        </div>
      )}
      {isFib && (
        <div className="field">
          <label>Levels</label>
          <input
            className="input"
            defaultValue={(d.levels || (d.type === 'fib' ? FIB_LEVELS : d.type === 'fibext' ? FIB_EXT_LEVELS : FIB_TIME)).join(', ')}
            onBlur={(e) => {
              const lv = e.target.value
                .split(/[,\s]+/)
                .map(Number)
                .filter((x) => isFinite(x));
              if (lv.length) set({ levels: lv });
            }}
          />
        </div>
      )}
      {d.type === 'hline' && (
        <div className="field">
          <label>Price</label>
          <NumberField value={d.points[0].p} onChange={(v) => set({ points: [{ ...d.points[0], p: v }] })} />
        </div>
      )}
      <div className="row">
        <button className="btn small" onClick={() => set({ locked: !d.locked })}>
          <Icon name={d.locked ? 'unlock' : 'lock'} size={14} /> {d.locked ? 'Unlock' : 'Lock'}
        </button>
        <button className="btn small danger" onClick={onDelete} disabled={d.locked}>
          <Icon name="trash" size={14} /> Delete
        </button>
        <div className="spacer" />
        <button className="btn small" onClick={onClose}>
          Done
        </button>
      </div>
    </div>
  );
}
