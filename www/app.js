import { SignalChart } from './chart.js';
import { SOURCES, availableSourceIds, createSource, defaultSourceId } from './sources.js';
import { classify, scaleFor, thresholdsFor } from './quality.js';
import * as perms from './permissions.js';

const $ = (id) => document.getElementById(id);
const fmt = (v, d = 0) => v.toLocaleString('es', { maximumFractionDigits: d });
const INTERVAL_MS = 1000;
const SESSION_CAP = 20_000;

/* ---------------- configuraciones de gráfica por modo ---------------- */

function bandLabel(s) {
  if (s.band == null) return null;
  if (typeof s.band === 'string') return s.band;
  if (s.tech === 'NR') return `n${s.band}`;
  if (s.tech === 'WCDMA') return `UMTS B${s.band}`;
  return `B${s.band}`;
}

const CFG_SIGNAL = {
  main: { key: 'dbm', label: 'Intensidad de señal', unit: 'dBm', fixed: true, min: -130, max: -50, decimals: 0 },
  aux: { key: 'freqMhz', label: 'Frecuencia de bajada', unit: 'MHz', step: true, minSpan: 100, decimals: 1 },
  extra: (s) => [s.tech, bandLabel(s), s.simulated ? 'simulado' : null].filter(Boolean).join(' · '),
};

const CFG_WEB = {
  main: { key: 'rttMs', label: 'Latencia estimada (RTT)', unit: 'ms', fixed: false, minSpan: 50, decimals: 0 },
  aux: { key: 'downlinkMbps', label: 'Ancho de banda estimado', unit: 'Mbps', step: false, minSpan: 2, decimals: 1 },
  extra: (s) => `Tipo efectivo: ${s.effectiveType ?? '—'}`,
};

/* ---------------- estado ---------------- */

const chart = new SignalChart($('chart'));
let sourceId = null;
let source = null;
let running = false;
let session = [];
let stats = { n: 0, sum: 0, min: Infinity, max: -Infinity };
let scaleKey = null;
let lastAnnounce = '';

/* ---------------- fuentes ---------------- */

function fillSourceSelect() {
  const select = $('sourceSelect');
  select.innerHTML = '';
  for (const id of Object.keys(SOURCES)) {
    const opt = document.createElement('option');
    opt.value = id;
    const ok = availableSourceIds().includes(id);
    opt.textContent = SOURCES[id].label + (ok ? '' : ' — no disponible aquí');
    opt.disabled = !ok;
    select.append(opt);
  }
}

async function selectSource(id) {
  if (running) await stop();
  sourceId = id;
  source = createSource(id);
  source.onSample(handleSample).onError(handleError);
  $('sourceSelect').value = id;

  chart.setConfig(id === 'web' ? CFG_WEB : CFG_SIGNAL);
  resetSession();
  renderMode();
  renderStatic();
  clearNotice();
  if (id === 'web') {
    showNotice(
      'Modo navegador: la web no tiene acceso a dBm ni a la frecuencia del módem. Solo se muestran latencia y velocidad estimadas.',
      availableSourceIds().includes('sim') ? { label: 'Ver con datos simulados', run: () => selectSource('sim') } : null,
    );
  }
}

function renderMode() {
  const badge = $('modeBadge');
  badge.dataset.mode = sourceId;
  badge.textContent = { native: 'Real', sim: 'Simulado', web: 'Limitado' }[sourceId];
  $('sourceLabel').textContent = {
    native: 'Leyendo el módem del teléfono (TelephonyManager)',
    sim: 'Datos sintéticos: no son una medición',
    web: 'Network Information API del navegador',
  }[sourceId];
}

/* ---------------- ciclo de medición ---------------- */

async function start() {
  if (running) return;
  $('toggleBtn').disabled = true;
  clearNotice();
  try {
    if (sourceId === 'native') {
      let state = await perms.nativeState();
      if (state !== 'granted') state = await perms.requestNative();
      await refreshPermissions();
      if (state !== 'granted') {
        showNotice(
          state === 'denied'
            ? 'Sin permiso no se puede leer el módem. Si marcaste “No volver a preguntar”, actívalo en Ajustes de la app (Permisos → Teléfono y Ubicación precisa).'
            : 'Hace falta conceder los permisos para leer la señal.',
          state === 'denied' ? { label: 'Abrir ajustes', run: perms.openAppSettings } : null,
        );
        return;
      }
    }
    await perms.keepAwake(true);
    await source.start({ intervalMs: INTERVAL_MS });
    running = true;
    chart.unfreeze();
  } catch (err) {
    showNotice(`No se pudo iniciar: ${err?.message ?? err}`);
  } finally {
    $('toggleBtn').disabled = false;
    renderButtons();
  }
}

async function stop() {
  if (!running) return;
  running = false;
  chart.freeze();
  await source.stop();
  await perms.keepAwake(false);
  renderButtons();
}

function handleError({ code, message }) {
  const known = {
    PERMISSION_DENIED: 'Android revocó el permiso. Vuelve a concederlo.',
    NO_TELEPHONY: 'Este dispositivo no tiene módem celular (¿tablet sin SIM o emulador?).',
    LOCATION_OFF: 'El módem no devolvió celdas: activa la ubicación del sistema (Android la exige para leer datos de celda).',
  };
  showNotice(known[code] ?? message ?? 'Error desconocido al leer la señal.');
}

/* ---------------- muestras ---------------- */

function handleSample(s) {
  const fix = perms.lastFix;
  if (fix) { s.lat = fix.lat; s.lon = fix.lon; s.acc = fix.acc; }

  session.push(s);
  if (session.length > SESSION_CAP) session.splice(0, session.length - SESSION_CAP);
  chart.push(s);

  if (s.dbm != null) {
    stats.n++; stats.sum += s.dbm;
    stats.min = Math.min(stats.min, s.dbm);
    stats.max = Math.max(stats.max, s.dbm);
  }

  const key = scaleFor(s.tech) === scaleFor('LTE') ? 'lte' : 'legacy';
  if (key !== scaleKey) { scaleKey = key; chart.setThresholds(thresholdsFor(s.tech)); }

  renderSample(s);
  if ($('tableView').open) renderTable();
  $('exportBtn').disabled = $('clearBtn').disabled = false;
}

/* ---------------- render ---------------- */

const STAT_LABELS = {
  signal: ['Frecuencia (bajada)', 'Banda', 'Canal', 'Calidad (RSRQ)', 'Relación señal/ruido', 'ID de celda (PCI)'],
  web: ['Latencia (RTT)', 'Ancho de banda est.', 'Tipo efectivo', 'Tipo de enlace', 'Ahorro de datos', 'dBm'],
};

function setStats(labels, values) {
  [...$('stats').children].forEach((el, i) => {
    el.firstElementChild.textContent = labels[i];
    const v = el.lastElementChild;
    const val = values?.[i];
    v.textContent = val ?? '—';
    v.classList.toggle('na', val == null || val.startsWith?.('No '));
  });
}

function renderStatic() {
  const web = sourceId === 'web';
  document.querySelector('.hero').dataset.limited = String(web);
  $('dbmValue').textContent = '—';
  $('dbmUnit').textContent = web ? '' : 'dBm';
  $('techLabel').textContent = '—';
  $('operatorLabel').textContent = '';
  $('quality').dataset.status = '';
  $('qualityLabel').textContent = web ? 'No disponible en el navegador' : 'Sin datos';
  [...$('bars').children].forEach((b) => b.classList.remove('on'));
  setStats(web ? STAT_LABELS.web : STAT_LABELS.signal, null);
  $('sessionStats').textContent = 'Sin muestras todavía';
  $('tableBody').replaceChildren();
  $('chartTitle').textContent = web ? 'Latencia y velocidad en el tiempo' : 'Señal en el tiempo';
  $('chart').setAttribute('aria-label', web
    ? 'Gráfica de latencia y ancho de banda estimados en tiempo real'
    : 'Gráfica de intensidad de señal en dBm y frecuencia en MHz en tiempo real');
  $('exportBtn').disabled = $('clearBtn').disabled = true;
}

function renderSample(s) {
  if (s.limited) {
    $('dbmValue').textContent = '—';
    $('techLabel').textContent = s.effectiveType ? `≈ ${s.effectiveType}` : 'Web';
    $('qualityLabel').textContent = 'No disponible en el navegador';
    setStats(STAT_LABELS.web, [
      s.rttMs != null ? `${fmt(s.rttMs)} ms` : null,
      s.downlinkMbps != null ? `${fmt(s.downlinkMbps, 1)} Mbps` : null,
      s.effectiveType ?? null,
      s.connType ?? 'No expuesto',
      s.saveData == null ? null : s.saveData ? 'Activo' : 'Inactivo',
      'No expuesto por la web',
    ]);
    $('sessionStats').textContent = `${session.length} muestras · los valores del navegador son aproximados y cuantizados`;
    return;
  }

  const q = classify(s.dbm, s.tech);
  $('dbmValue').textContent = s.dbm != null ? fmt(s.dbm) : '—';
  $('techLabel').textContent = s.tech === 'NONE' ? 'Sin servicio' : s.tech === 'NR' ? '5G NR' : s.tech;
  $('operatorLabel').textContent = s.operator ?? '';
  $('quality').dataset.status = q?.status ?? '';
  $('qualityLabel').textContent = q ? q.label : 'Sin señal';
  const lit = s.level ?? q?.level ?? 0;
  [...$('bars').children].forEach((b, i) => b.classList.toggle('on', i < lit));

  const isNr = s.tech === 'NR';
  const lte = s.tech === 'LTE' || isNr;
  const qualityLabel = lte ? (isNr ? 'Calidad (SS-RSRQ)' : 'Calidad (RSRQ)') : 'Calidad (RSRQ)';
  const labels = [...STAT_LABELS.signal];
  labels[3] = qualityLabel;
  setStats(labels, [
    s.freqMhz != null ? `${fmt(s.freqMhz, 1)} MHz` : s.channel != null ? 'No resuelta' : null,
    bandLabel(s),
    s.channel != null ? `${s.channelType} ${s.channel}` : null,
    s.rsrq != null ? `${s.rsrq} dB` : null,
    s.snr != null ? `${s.snr} dB` : null,
    s.pci != null ? String(s.pci) : null,
  ]);

  if (stats.n) {
    $('sessionStats').textContent =
      `Mín ${fmt(stats.min)} · Prom ${fmt(stats.sum / stats.n, 1)} · Máx ${fmt(stats.max)} dBm · ${session.length} muestras`;
  }

  // Aviso accesible solo cuando cambia la categoría o la tecnología (no cada segundo)
  const announce = `${$('techLabel').textContent} ${$('qualityLabel').textContent}`;
  if (announce !== lastAnnounce) { lastAnnounce = announce; $('srStatus').textContent = `${announce}, ${s.dbm ?? 'sin'} dBm`; }
}

function renderTable() {
  const rows = session.slice(-40).reverse().map((s) => {
    const tr = document.createElement('tr');
    const cells = [
      new Date(s.t).toLocaleTimeString('es', { hour12: false }),
      s.dbm != null ? fmt(s.dbm) : '—',
      s.tech,
      bandLabel(s) ?? '—',
      s.channel ?? '—',
      s.freqMhz != null ? fmt(s.freqMhz, 1) : '—',
    ];
    cells.forEach((c) => { const td = document.createElement('td'); td.textContent = c; tr.append(td); });
    return tr;
  });
  $('tableBody').replaceChildren(...rows);
}

function renderButtons() {
  const b = $('toggleBtn');
  b.textContent = running ? 'Detener medición' : 'Iniciar medición';
  b.dataset.running = String(running);
}

/* ---------------- avisos ---------------- */

function showNotice(text, action) {
  const n = $('notice');
  n.replaceChildren(document.createTextNode(text));
  if (action) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'btn';
    btn.textContent = action.label;
    btn.addEventListener('click', action.run);
    n.append(btn);
  }
  n.hidden = false;
}
function clearNotice() { $('notice').hidden = true; $('notice').replaceChildren(); }

/* ---------------- permisos (UI) ---------------- */

const STATE_TEXT = { granted: 'Concedido', denied: 'Denegado', prompt: 'Pendiente', unsupported: 'No disponible' };
function setChip(id, state, textOverride) {
  const el = $(id);
  el.dataset.state = state;
  el.textContent = textOverride ?? STATE_TEXT[state];
}

async function refreshPermissions() {
  const native = await perms.nativeState();
  setChip('permNative', native, native === 'unsupported' ? 'No aplica aquí' : undefined);
  setChip('permGeo', await perms.geolocationState());
  setChip('permWake', perms.wakeLockSupported() ? 'granted' : 'unsupported', perms.wakeLockSupported() ? 'Disponible' : 'No soportado');

  const btn = $('permBtn');
  btn.hidden = native === 'unsupported' || native === 'granted';
  btn.textContent = native === 'denied' ? 'Abrir ajustes de la app' : 'Conceder permisos del módem';
}

async function onPermButton() {
  const state = await perms.nativeState();
  if (state === 'denied') {
    // Tras un "No volver a preguntar" Android ya no muestra el diálogo: solo queda Ajustes.
    const after = await perms.requestNative();
    if (after === 'denied') await perms.openAppSettings();
  } else {
    await perms.requestNative();
  }
  await refreshPermissions();
}

async function onGeoToggle(e) {
  if (e.target.checked) {
    const state = await perms.startGeolocation(() => refreshPermissions());
    if (state !== 'granted') {
      e.target.checked = false;
      showNotice(
        state === 'unsupported'
          ? 'La geolocalización requiere HTTPS o localhost y un navegador compatible.'
          : 'Permiso de ubicación denegado. Puedes cambiarlo en la configuración del sitio.',
      );
    }
  } else {
    perms.stopGeolocation();
  }
  await refreshPermissions();
}

/* ---------------- sesión / CSV ---------------- */

function resetSession() {
  session = [];
  stats = { n: 0, sum: 0, min: Infinity, max: -Infinity };
  scaleKey = null;
  lastAnnounce = '';
  chart.clear();
}

function toCsv() {
  const head = ['hora_iso', 'tecnologia', 'dbm', 'rsrq_db', 'sinr_db', 'nivel', 'banda', 'tipo_canal', 'canal', 'frecuencia_mhz', 'pci', 'operador', 'lat', 'lon', 'precision_m', 'simulado', 'rtt_ms', 'downlink_mbps'];
  const esc = (v) => (v == null ? '' : /[",\n]/.test(String(v)) ? `"${String(v).replaceAll('"', '""')}"` : String(v));
  const lines = session.map((s) => [
    new Date(s.t).toISOString(), s.tech, s.dbm, s.rsrq, s.snr, s.level, bandLabel(s), s.channelType, s.channel,
    s.freqMhz, s.pci, s.operator, s.lat, s.lon, s.acc, s.simulated ? 'si' : 'no', s.rttMs, s.downlinkMbps,
  ].map(esc).join(','));
  return [head.join(','), ...lines].join('\n');
}

async function exportCsv() {
  const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
  const file = new File([toCsv()], `senal-${stamp}.csv`, { type: 'text/csv' });
  try {
    if (navigator.canShare?.({ files: [file] })) { await navigator.share({ files: [file], title: file.name }); return; }
  } catch (err) {
    if (err?.name === 'AbortError') return; // el usuario cerró la hoja de compartir
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(file);
  a.download = file.name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
}

/* ---------------- arranque ---------------- */

function wire() {
  $('toggleBtn').addEventListener('click', () => (running ? stop() : start()));
  $('sourceSelect').addEventListener('change', (e) => selectSource(e.target.value));
  $('clearBtn').addEventListener('click', () => { resetSession(); renderStatic(); });
  $('exportBtn').addEventListener('click', exportCsv);
  $('permBtn').addEventListener('click', onPermButton);
  $('geoToggle').addEventListener('change', onGeoToggle);
  $('tableView').addEventListener('toggle', () => { if ($('tableView').open) renderTable(); });

  document.querySelectorAll('.seg button').forEach((btn) =>
    btn.addEventListener('click', () => {
      document.querySelectorAll('.seg button').forEach((b) => b.setAttribute('aria-pressed', String(b === btn)));
      chart.setWindow(Number(btn.dataset.window) * 1000);
    }));

  // Al volver de Ajustes del sistema, se vuelve a leer el estado de los permisos.
  document.addEventListener('visibilitychange', () => { if (!document.hidden) refreshPermissions(); });
}

function registerServiceWorker() {
  const native = window.Capacitor?.isNativePlatform?.();
  const secure = location.protocol === 'https:' || location.hostname === 'localhost';
  if (!native && secure && 'serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch(() => { /* la app funciona igual sin caché offline */ });
  }
}

const live = document.createElement('div');
live.id = 'srStatus';
live.className = 'sr-only';
live.setAttribute('role', 'status');
live.setAttribute('aria-live', 'polite');
document.body.append(live);

fillSourceSelect();
wire();
await selectSource(defaultSourceId());
await refreshPermissions();
renderButtons();
registerServiceWorker();
