// Gráfica en tiempo real sobre <canvas>, sin dependencias.
//
// Dos paneles que comparten el eje del tiempo (NO es un gráfico de doble eje: cada panel
// tiene su propia escala, vertical y separada):
//   arriba  -> magnitud principal (dBm), con los umbrales de calidad como referencia
//   abajo   -> magnitud auxiliar en escalón (frecuencia DL en MHz; cambia en un handover)
//
// Comportamiento:
//  - La ventana de tiempo se desplaza de forma continua (requestAnimationFrame).
//  - Si no llegan datos durante > 5 s, la línea se corta (señal perdida / pausa).
//  - Al pasar el puntero (o con ←/→ si el canvas tiene foco) el tiempo se congela y aparece
//    una guía con los valores exactos de esa muestra.
//  - Colores y fuente salen de variables CSS, así que respeta modo claro/oscuro.

const FONT = 'system-ui, -apple-system, "Segoe UI", sans-serif';
const GAP_MS = 5000;
const KEEP_MS = 11 * 60 * 1000;
const MAX_POINTS = 6000;

function readTheme(el) {
  const cs = getComputedStyle(el);
  const v = (n) => cs.getPropertyValue(n).trim();
  return {
    surface: v('--surface'), ink: v('--ink'), ink2: v('--ink-2'), muted: v('--muted'),
    grid: v('--grid'), axis: v('--axis'), border: v('--border'),
    s1: v('--series-1'), s2: v('--series-2'),
  };
}

function niceTicks(lo, hi, target = 4) {
  const raw = (hi - lo) / target;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const n = raw / mag;
  const step = (n < 1.5 ? 1 : n < 3 ? 2 : n < 7 ? 5 : 10) * mag;
  const out = [];
  for (let t = Math.ceil(lo / step) * step; t <= hi + 1e-9; t += step) out.push(+t.toFixed(6));
  return out;
}

function autoRange(vals, minSpan) {
  if (!vals.length) return [0, minSpan];
  let lo = Math.min(...vals);
  let hi = Math.max(...vals);
  if (hi - lo < minSpan) {
    const c = (hi + lo) / 2;
    lo = c - minSpan / 2;
    hi = c + minSpan / 2;
  }
  const pad = (hi - lo) * 0.08;
  return [lo - pad, hi + pad];
}

const fmt = (v, d = 0) => v.toLocaleString('es', { maximumFractionDigits: d, minimumFractionDigits: 0 });

function fmtAgo(ms) {
  const s = Math.round(ms / 1000);
  if (s <= 0) return 'ahora';
  if (s < 60) return `−${s} s`;
  return `−${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

export class SignalChart {
  /**
   * cfg = {
   *   main: { key, label, unit, fixed, min, max, minSpan, decimals },
   *   aux:  { key, label, unit, step, minSpan, decimals },
   *   extra: (sample) => string          // texto adicional del tooltip (tecnología, banda)
   * }
   */
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.windowMs = 120_000;
    this.data = [];
    this.cfg = null;
    this.thresholds = [];
    this.hoverX = null;
    this.hoverFreeze = null;
    this.frozenAt = Date.now();
    this.dirty = true;
    this.w = 0; this.h = 0; this.dpr = 1;
    this.theme = readTheme(canvas);
    this._vis = [];
    this._xOf = null;

    canvas.tabIndex = 0;
    canvas.style.touchAction = 'pan-y'; // el scroll vertical sigue funcionando; el horizontal mueve la guía

    new ResizeObserver(() => this._resize()).observe(canvas);
    matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
      this.theme = readTheme(canvas);
      this.dirty = true;
    });

    const moveTo = (e) => {
      const r = canvas.getBoundingClientRect();
      this._setHover(e.clientX - r.left);
    };
    canvas.addEventListener('pointerdown', moveTo);
    canvas.addEventListener('pointermove', moveTo);
    canvas.addEventListener('pointerleave', () => this._setHover(null));
    canvas.addEventListener('pointercancel', () => this._setHover(null));
    canvas.addEventListener('pointerup', (e) => { if (e.pointerType !== 'mouse') this._setHover(null); });
    canvas.addEventListener('blur', () => this._setHover(null));
    canvas.addEventListener('keydown', (e) => this._onKey(e));

    this._frame = this._frame.bind(this);
    requestAnimationFrame(this._frame);
    this._resize();
  }

  /* ---------- API pública ---------- */

  setConfig(cfg) { this.cfg = cfg; this.clear(); }
  setThresholds(list) { this.thresholds = list ?? []; this.dirty = true; }
  setWindow(ms) { this.windowMs = ms; this.dirty = true; }
  freeze() { this.frozenAt = Date.now(); this.dirty = true; }
  unfreeze() { this.frozenAt = null; }
  clear() { this.data = []; this._setHover(null); this.dirty = true; }

  push(sample) {
    this.data.push(sample);
    const cutoff = Date.now() - KEEP_MS;
    let drop = 0;
    while (drop < this.data.length && this.data[drop].t < cutoff) drop++;
    if (this.data.length - drop > MAX_POINTS) drop = this.data.length - MAX_POINTS;
    if (drop) this.data.splice(0, drop);
    this.dirty = true;
  }

  /* ---------- interno ---------- */

  _now() { return this.frozenAt ?? this.hoverFreeze ?? Date.now(); }

  _setHover(x) {
    if (x == null) { this.hoverX = null; this.hoverFreeze = null; }
    else { if (this.hoverX == null) this.hoverFreeze = Date.now(); this.hoverX = x; }
    this.dirty = true;
  }

  _onKey(e) {
    if (e.key === 'Escape') return this._setHover(null);
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    e.preventDefault();
    const pts = this._vis.filter((p) => p[this.cfg.main.key] != null);
    if (!pts.length || !this._xOf) return;
    let i = pts.length - 1;
    if (this.hoverX != null) {
      let best = Infinity;
      pts.forEach((p, k) => { const d = Math.abs(this._xOf(p.t) - this.hoverX); if (d < best) { best = d; i = k; } });
      i = Math.min(pts.length - 1, Math.max(0, i + (e.key === 'ArrowLeft' ? -1 : 1)));
    }
    this._setHover(this._xOf(pts[i].t));
  }

  _resize() {
    const dpr = Math.max(1, window.devicePixelRatio || 1);
    const w = this.canvas.clientWidth;
    const h = this.canvas.clientHeight;
    this.canvas.width = Math.round(w * dpr);
    this.canvas.height = Math.round(h * dpr);
    this.w = w; this.h = h; this.dpr = dpr;
    this.dirty = true;
  }

  _frame() {
    requestAnimationFrame(this._frame);
    if (document.hidden) return;
    const live = this.frozenAt == null && this.hoverX == null;
    if (!live && !this.dirty) return;
    this._draw();
    this.dirty = false;
  }

  _layout() {
    const padL = 50, padR = 16, padT = 28, padB = 22, gap = 34;
    const usable = this.h - padT - padB - gap;
    const mainH = Math.round(usable * 0.62);
    return {
      padL, padR, plotW: this.w - padL - padR,
      main: { top: padT, h: mainH },
      aux: { top: padT + mainH + gap, h: usable - mainH },
      bottom: this.h - padB,
    };
  }

  _draw() {
    const { ctx, cfg, theme: T } = this;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.clearRect(0, 0, this.w, this.h);
    if (!cfg || this.w < 80 || this.h < 120) return;

    const L = this._layout();
    const now = this._now();
    const t0 = now - this.windowMs;
    const xOf = (t) => L.padL + ((t - t0) / this.windowMs) * L.plotW;
    const vis = this.data.filter((p) => p.t >= t0 - GAP_MS && p.t <= now);
    this._vis = vis;
    this._xOf = xOf;

    const mainVals = vis.map((p) => p[cfg.main.key]).filter((v) => v != null);
    const auxVals = vis.map((p) => p[cfg.aux.key]).filter((v) => v != null);
    const mainRange = cfg.main.fixed ? [cfg.main.min, cfg.main.max] : autoRange(mainVals, cfg.main.minSpan ?? 10);
    const auxRange = autoRange(auxVals, cfg.aux.minSpan ?? 10);

    const mainTicks = cfg.main.fixed && this.thresholds.length
      ? this.thresholds.map((t) => t.dbm)
      : niceTicks(mainRange[0], mainRange[1], 4);

    const yMain = this._drawPanel(L, L.main, cfg.main, mainRange, mainTicks, T.s1, vis, xOf, now, false);
    const yAux = this._drawPanel(L, L.aux, cfg.aux, auxRange, niceTicks(auxRange[0], auxRange[1], 3), T.s2, vis, xOf, now, !!cfg.aux.step);

    // Etiquetas del eje de tiempo
    ctx.fillStyle = T.muted;
    ctx.font = `11px ${FONT}`;
    ctx.textBaseline = 'alphabetic';
    for (let k = 0; k <= 4; k++) {
      const t = t0 + (this.windowMs * k) / 4;
      ctx.textAlign = k === 0 ? 'left' : k === 4 ? 'right' : 'center';
      ctx.fillText(fmtAgo(now - t), xOf(t), L.bottom + 15);
    }

    if (this.hoverX != null && vis.length) this._drawHover(L, vis, xOf, now, yMain, yAux);
  }

  /** Dibuja un panel y devuelve su función valor -> y. */
  _drawPanel(L, box, spec, [lo, hi], ticks, color, vis, xOf, now, step) {
    const { ctx, theme: T } = this;
    const yOf = (v) => box.top + box.h - ((Math.min(hi, Math.max(lo, v)) - lo) / (hi - lo)) * box.h;
    const right = L.padL + L.plotW;

    // Título del panel (texto en tinta, nunca en el color de la serie)
    ctx.fillStyle = T.ink2;
    ctx.font = `600 12px ${FONT}`;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';
    ctx.fillText(`${spec.label} (${spec.unit})`, L.padL, box.top - 10);

    // Nombres de las zonas de calidad (solo en el panel principal con umbrales)
    if (spec === this.cfg.main && spec.fixed && this.thresholds.length) {
      const edges = [hi, ...this.thresholds.map((t) => t.dbm), lo];
      const names = [this.thresholds[0].above, ...this.thresholds.map((t) => t.below)];
      ctx.fillStyle = T.muted;
      ctx.font = `10px ${FONT}`;
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      names.forEach((name, i) => {
        const yMid = (yOf(edges[i]) + yOf(edges[i + 1])) / 2;
        if (yOf(edges[i + 1]) - yOf(edges[i]) >= 14) ctx.fillText(name, L.padL + 6, yMid);
      });
    }

    // Rejilla y etiquetas del eje Y: hairlines sólidas y recesivas
    ctx.lineWidth = 1;
    ctx.strokeStyle = T.grid;
    ctx.fillStyle = T.muted;
    ctx.font = `11px ${FONT}`;
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    for (const t of ticks) {
      const y = Math.round(yOf(t)) + 0.5;
      ctx.beginPath(); ctx.moveTo(L.padL, y); ctx.lineTo(right, y); ctx.stroke();
      ctx.fillText(fmt(t, spec.decimals ?? 0), L.padL - 8, y);
    }
    ctx.strokeStyle = T.axis;
    ctx.beginPath();
    ctx.moveTo(L.padL, box.top + box.h + 0.5);
    ctx.lineTo(right, box.top + box.h + 0.5);
    ctx.stroke();

    // Línea (2 px, uniones redondeadas), cortada donde no hay datos
    let last = null;
    ctx.save();
    ctx.beginPath();
    ctx.rect(L.padL, box.top - 6, L.plotW, box.h + 12);
    ctx.clip();
    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.beginPath();
    let prev = null;
    for (const p of vis) {
      const v = p[spec.key];
      if (v == null) { prev = null; continue; }
      const x = xOf(p.t);
      const y = yOf(v);
      if (prev && p.t - prev.t <= GAP_MS) {
        if (step) ctx.lineTo(x, yOf(prev.v));
        ctx.lineTo(x, y);
      } else {
        ctx.moveTo(x, y);
      }
      prev = { t: p.t, v };
      last = { t: p.t, v, x, y };
    }
    ctx.stroke();
    ctx.restore();

    if (!vis.some((p) => p[spec.key] != null)) {
      ctx.fillStyle = T.muted;
      ctx.font = `12px ${FONT}`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(this.data.length ? 'Sin dato en este intervalo' : 'Esperando datos…', L.padL + L.plotW / 2, box.top + box.h / 2);
      return yOf;
    }

    // Marcador final con anillo de 2 px del color de la superficie + etiqueta directa del último valor
    if (last && now - last.t <= GAP_MS) {
      ctx.fillStyle = T.surface;
      ctx.beginPath(); ctx.arc(last.x, last.y, 6, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = color;
      ctx.beginPath(); ctx.arc(last.x, last.y, 4, 0, Math.PI * 2); ctx.fill();

      ctx.fillStyle = T.ink;
      ctx.font = `600 12px ${FONT}`;
      ctx.textAlign = 'right';
      ctx.textBaseline = 'alphabetic';
      const above = last.y - box.top > 22;
      const txt = `${fmt(last.v, spec.decimals ?? 0)} ${spec.unit}`;
      const tx = Math.min(last.x + 6, right);
      const ty = above ? last.y - 11 : last.y + 20;
      // Halo del color de la superficie para que la etiqueta se lea aunque cruce la línea
      ctx.lineWidth = 4;
      ctx.lineJoin = 'round';
      ctx.strokeStyle = T.surface;
      ctx.strokeText(txt, tx, ty);
      ctx.fillText(txt, tx, ty);
    }
    return yOf;
  }

  _drawHover(L, vis, xOf, now, yMain, yAux) {
    const { ctx, cfg, theme: T } = this;
    let near = null;
    let best = Infinity;
    for (const p of vis) {
      if (p[cfg.main.key] == null && p[cfg.aux.key] == null) continue;
      const d = Math.abs(xOf(p.t) - this.hoverX);
      if (d < best) { best = d; near = p; }
    }
    if (!near || best > 40) return; // solo si el puntero está razonablemente cerca de una muestra

    const x = xOf(near.t);
    ctx.strokeStyle = T.axis;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(Math.round(x) + 0.5, L.main.top);
    ctx.lineTo(Math.round(x) + 0.5, L.aux.top + L.aux.h);
    ctx.stroke();

    const mv = near[cfg.main.key];
    const av = near[cfg.aux.key];
    const dot = (y, color) => {
      ctx.fillStyle = T.surface; ctx.beginPath(); ctx.arc(x, y, 6, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = color; ctx.beginPath(); ctx.arc(x, y, 4, 0, Math.PI * 2); ctx.fill();
    };
    if (mv != null) dot(yMain(mv), T.s1);
    if (av != null) dot(yAux(av), T.s2);

    const lines = [
      new Date(near.t).toLocaleTimeString('es', { hour12: false }) + ` (${fmtAgo(now - near.t)})`,
      mv != null ? `${cfg.main.label}: ${fmt(mv, cfg.main.decimals ?? 0)} ${cfg.main.unit}` : `${cfg.main.label}: sin dato`,
      av != null ? `${cfg.aux.label}: ${fmt(av, cfg.aux.decimals ?? 0)} ${cfg.aux.unit}` : `${cfg.aux.label}: sin dato`,
    ];
    const extra = cfg.extra?.(near);
    if (extra) lines.push(extra);

    ctx.font = `12px ${FONT}`;
    const width = Math.max(...lines.map((s) => ctx.measureText(s).width)) + 20;
    const height = lines.length * 17 + 12;
    let bx = x + 14;
    if (bx + width > this.w - 4) bx = x - 14 - width;
    bx = Math.max(4, bx);
    const by = L.main.top + 6;

    ctx.fillStyle = T.surface;
    ctx.strokeStyle = T.border;
    ctx.beginPath();
    ctx.roundRect(bx, by, width, height, 6);
    ctx.fill();
    ctx.stroke();

    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    lines.forEach((s, i) => {
      ctx.fillStyle = i === 0 ? T.muted : T.ink;
      ctx.fillText(s, bx + 10, by + 6 + 8.5 + i * 17);
    });
  }
}
