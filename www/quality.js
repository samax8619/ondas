// Umbrales ORIENTATIVOS para interpretar la intensidad de señal.
// 4G/5G se evalúan con RSRP; 2G/3G con RSSI (escala distinta, por eso van separados).
// Cada operador/fabricante usa cortes algo distintos: son una guía, no una norma.

const LTE_NR = [
  { id: 'excellent', label: 'Excelente', min: -80, status: 'good', level: 4 },
  { id: 'good', label: 'Buena', min: -90, status: 'good', level: 3 },
  { id: 'fair', label: 'Regular', min: -100, status: 'warning', level: 2 },
  { id: 'poor', label: 'Débil', min: -110, status: 'serious', level: 1 },
  { id: 'bad', label: 'Muy débil', min: -Infinity, status: 'critical', level: 0 },
];

const GSM_UMTS = [
  { id: 'excellent', label: 'Excelente', min: -70, status: 'good', level: 4 },
  { id: 'good', label: 'Buena', min: -85, status: 'good', level: 3 },
  { id: 'fair', label: 'Regular', min: -95, status: 'warning', level: 2 },
  { id: 'poor', label: 'Débil', min: -105, status: 'serious', level: 1 },
  { id: 'bad', label: 'Muy débil', min: -Infinity, status: 'critical', level: 0 },
];

export function scaleFor(tech) {
  return tech === 'GSM' || tech === 'WCDMA' || tech === 'CDMA' ? GSM_UMTS : LTE_NR;
}

export function classify(dbm, tech) {
  if (dbm == null) return null;
  return scaleFor(tech).find((c) => dbm >= c.min);
}

/** Líneas de umbral para dibujar en la gráfica (solo los cortes internos). */
export function thresholdsFor(tech) {
  const s = scaleFor(tech);
  return s.slice(0, -1).map((c, i) => ({ dbm: c.min, above: c.label, below: s[i + 1].label }));
}
