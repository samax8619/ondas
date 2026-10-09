// Fuentes de datos. Todas emiten muestras con la MISMA forma normalizada:
//
//   { t, tech, dbm, rsrq, snr, level, channel, channelType, freqMhz, band, pci,
//     operator, simulated, limited, rttMs, downlinkMbps, effectiveType, connType, saveData }
//
// tech: 'LTE' | 'NR' | 'WCDMA' | 'GSM' | 'CDMA' | 'NONE' | 'WEB'
//
//  - NativeAndroidSource : lectura real del módem vía plugin Capacitor (único modo con dBm reales).
//  - WebNetworkSource    : lo máximo que expone un navegador (Network Information API). SIN dBm.
//  - SimulatedSource     : datos sintéticos para desarrollar la interfaz sin teléfono.

import { resolveChannel } from './arfcn.js';
import { classify } from './quality.js';

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

export function normalize(raw) {
  const s = {
    t: num(raw.t) ?? Date.now(),
    tech: raw.tech ?? 'NONE',
    dbm: num(raw.dbm),
    rsrq: num(raw.rsrq),
    snr: num(raw.snr),
    level: num(raw.level),
    channel: num(raw.channel),
    channelType: raw.channelType ?? null,
    freqMhz: null,
    band: raw.band ?? null,
    pci: num(raw.pci),
    operator: raw.operator || null,
    simulated: !!raw.simulated,
    limited: !!raw.limited,
    rttMs: num(raw.rttMs),
    downlinkMbps: num(raw.downlinkMbps),
    effectiveType: raw.effectiveType ?? null,
    connType: raw.connType ?? null,
    saveData: raw.saveData ?? null,
  };
  if (s.channel != null && s.channelType) {
    const r = resolveChannel(s.channelType, s.channel);
    if (r) {
      s.freqMhz = r.mhz;
      if (s.band == null) s.band = r.band;
    }
  }
  return s;
}

class BaseSource {
  constructor() {
    this._onSample = () => {};
    this._onError = () => {};
  }
  onSample(cb) { this._onSample = cb; return this; }
  onError(cb) { this._onError = cb; return this; }
  emit(raw) { this._onSample(normalize(raw)); }
  fail(code, message) { this._onError({ code, message }); }
}

/* ------------------------------------------------------------------ */
/* 1. Android nativo (Capacitor + plugin SignalMonitor)                 */
/* ------------------------------------------------------------------ */

let _plugin = null;
export function getNativePlugin() {
  const cap = window.Capacitor;
  if (!cap?.isNativePlatform?.() || cap.getPlatform?.() !== 'android') return null;
  if (!cap.isPluginAvailable?.('SignalMonitor')) return null;
  return (_plugin ??= cap.registerPlugin('SignalMonitor'));
}

export class NativeAndroidSource extends BaseSource {
  static isAvailable() { return getNativePlugin() !== null; }

  constructor() {
    super();
    this.plugin = getNativePlugin();
    this.handles = [];
  }

  async start({ intervalMs = 1000 } = {}) {
    this.handles.push(
      await this.plugin.addListener('signal', (raw) => this.emit(raw)),
      await this.plugin.addListener('error', (e) => this.fail(e.code, e.message)),
    );
    await this.plugin.start({ intervalMs });
  }

  async stop() {
    try { await this.plugin.stop(); } catch { /* ya detenido */ }
    await Promise.all(this.handles.map((h) => h.remove()));
    this.handles = [];
  }
}

/* ------------------------------------------------------------------ */
/* 2. Navegador (Network Information API) - datos LIMITADOS             */
/* ------------------------------------------------------------------ */

export class WebNetworkSource extends BaseSource {
  static isAvailable() { return typeof navigator !== 'undefined' && 'connection' in navigator; }

  async start({ intervalMs = 1000 } = {}) {
    this.timer = setInterval(() => this._read(), intervalMs);
    this._read();
  }

  _read() {
    const c = navigator.connection;
    if (!c) return this.fail('UNSUPPORTED', 'Este navegador no expone navigator.connection.');
    this.emit({
      t: Date.now(),
      tech: 'WEB',
      limited: true,
      // Valores cuantizados por el navegador (RTT a múltiplos de 25 ms; downlink con tope ~10 Mbps).
      rttMs: c.rtt,
      downlinkMbps: c.downlink,
      effectiveType: c.effectiveType, // '4g' es una CATEGORÍA de rendimiento, no la tecnología de radio
      connType: c.type, // 'cellular' | 'wifi' | ... solo en algunos navegadores
      saveData: c.saveData,
    });
  }

  async stop() { clearInterval(this.timer); }
}

/* ------------------------------------------------------------------ */
/* 3. Simulación                                                        */
/* ------------------------------------------------------------------ */

const SIM_CELLS = [
  { tech: 'LTE', channelType: 'EARFCN', channel: 1500, pci: 101, mean: -88 }, // B3  1835.0 MHz
  { tech: 'LTE', channelType: 'EARFCN', channel: 3100, pci: 233, mean: -98 }, // B7  2655.0 MHz
  { tech: 'LTE', channelType: 'EARFCN', channel: 9435, pci: 57, mean: -92 }, // B28  780.5 MHz
  { tech: 'NR', channelType: 'NR-ARFCN', channel: 632628, pci: 412, mean: -94, band: 78 }, // 3489.42 MHz
  { tech: 'WCDMA', channelType: 'UARFCN', channel: 10700, pci: 88, mean: -84 }, // B1  2140.0 MHz
];

const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));
const gauss = () => Math.sqrt(-2 * Math.log(1 - Math.random())) * Math.cos(2 * Math.PI * Math.random());

export class SimulatedSource extends BaseSource {
  static isAvailable() { return true; }

  async start({ intervalMs = 1000 } = {}) {
    this.phase = Math.random() * Math.PI * 2;
    this._switchCell(null);
    this.timer = setInterval(() => this._step(), intervalMs);
    this._step();
  }

  _switchCell(prev) {
    const options = SIM_CELLS.filter((c) => c !== prev);
    this.cell = options[Math.floor(Math.random() * options.length)];
    this.handoverAt = Date.now() + 20_000 + Math.random() * 40_000; // "handover" cada 20–60 s
    this.x = this.cell.mean + (Math.random() - 0.5) * 8;
  }

  _step() {
    const now = Date.now();
    if (now >= this.handoverAt) this._switchCell(this.cell);
    const c = this.cell;
    // Ornstein–Uhlenbeck: vuelve hacia la media con ruido, más un desvanecimiento lento.
    const fading = 4 * Math.sin(now / 9000 + this.phase);
    this.x += 0.12 * (c.mean + fading - this.x) + 1.6 * gauss();
    const dbm = Math.round(clamp(this.x, -125, -55));
    const lteLike = c.tech === 'LTE' || c.tech === 'NR'; // 2G/3G no reportan RSRQ ni SINR
    this.emit({
      t: now,
      tech: c.tech,
      dbm,
      rsrq: lteLike ? Math.round(clamp(-11 + (dbm + 95) * 0.12 + gauss(), -20, -3)) : null,
      snr: lteLike ? Math.round(clamp((dbm + 112) * 0.7 + gauss() * 1.5, -10, 30)) : null,
      level: classify(dbm, c.tech)?.level ?? 0,
      channel: c.channel,
      channelType: c.channelType,
      band: c.band ?? null,
      pci: c.pci,
      operator: 'SIMULADO',
      simulated: true,
    });
  }

  async stop() { clearInterval(this.timer); }
}

/* ------------------------------------------------------------------ */

export const SOURCES = {
  native: { label: 'Módem Android (real)', Class: NativeAndroidSource },
  web: { label: 'Navegador (limitado)', Class: WebNetworkSource },
  sim: { label: 'Simulación', Class: SimulatedSource },
};

export function availableSourceIds() {
  return Object.keys(SOURCES).filter((id) => SOURCES[id].Class.isAvailable());
}

export function defaultSourceId() {
  const ids = availableSourceIds();
  return ['native', 'web', 'sim'].find((id) => ids.includes(id));
}

export function createSource(id) {
  return new SOURCES[id].Class();
}
