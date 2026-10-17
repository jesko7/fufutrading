import type { ChartTheme } from './types';
import type { AppSettings } from '../../shared/settings';

function css(name: string, fallback: string): string {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v || fallback;
}

export function chartTheme(s: AppSettings): ChartTheme {
  const dark = document.documentElement.dataset.theme !== 'light';
  return {
    bg: css('--chart-bg', dark ? '#0d1016' : '#ffffff'),
    grid: s.chart.gridColor || css('--chart-grid', 'rgba(128,128,128,0.08)'),
    text: css('--chart-text', '#8b93a3'),
    textStrong: css('--text', '#e8eaef'),
    cross: css('--chart-cross', 'rgba(200,200,200,0.5)'),
    border: css('--border', 'rgba(128,128,128,0.15)'),
    up: s.chart.up,
    down: s.chart.down,
    wickUp: s.chart.wickUp,
    wickDown: s.chart.wickDown,
    accent: s.accent,
    labelBg: dark ? '#2a3140' : '#4b5563',
    font: getComputedStyle(document.body).fontFamily || 'system-ui',
    fontSize: s.chart.font,
    volumeOpacity: s.chart.volumeOpacity,
    hollowUp: s.chart.hollowUp,
    showGrid: s.chart.grid,
    reverseScroll: !!s.chart.reverseScroll,
    momentum: s.chart.momentum !== false,
  };
}
