import { registerModule } from '../registry';
import { AlertsModule } from './AlertsModule';
import { api } from '../../api';
import { useApp, toast } from '../../state/store';
import { openModule } from '../../app/moduleOps';
import type { Alert, AlertEvent, AlertKind } from '../../../shared/alerts';
import { bus } from '../../lib/bus';
import { quickPriceAlert, openAlertEditor } from './editor';
import type { Market, SymbolId } from '../../../shared/symbols';

registerModule('alerts', AlertsModule);

// indicator legend: "Add alert…"
bus.on('alerts:new', (d: { kind: AlertKind; symbol: SymbolId; market: Market; patch?: Partial<Alert> }) => openAlertEditor(d));

// chart context menu: "Add alert at <price>"
bus.on('alerts:create', (d: { symbol: SymbolId; market: Market; price: number }) => {
  void api
    .call<number>('market:lastPrice', d.symbol, d.market)
    .catch(() => NaN)
    .then((last) => quickPriceAlert(d.symbol, d.market, d.price, last));
});

let audio: AudioContext | null = null;

/** A soft two-tone chime (no audio files needed). */
export function chime(): void {
  try {
    audio ||= new AudioContext();
    const ctx = audio;
    const t0 = ctx.currentTime;
    [880, 1318.5].forEach((f, k) => {
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      const at = t0 + k * 0.13;
      o.type = 'sine';
      o.frequency.value = f;
      g.gain.setValueAtTime(0.0001, at);
      g.gain.exponentialRampToValueAtTime(0.16, at + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, at + 0.7);
      o.connect(g).connect(ctx.destination);
      o.start(at);
      o.stop(at + 0.75);
    });
  } catch {
    /* audio unavailable */
  }
}

// fired alerts: toast + sound in the main window (desktop notifications come from the main process)
if (api.windowId === 'main') {
  api.on<{ event: AlertEvent; sound: boolean }>('alert:fired', ({ event, sound }) => {
    toast({ title: `🔔 ${event.name}`, body: event.message, kind: 'warn', timeout: 12000, action: { label: 'Alerts', run: () => void openModule('alerts', { tab: 'log' }) } });
    if (sound && useApp.getState().settings.notifications.sound) chime();
  });
}
