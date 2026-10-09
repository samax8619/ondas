// Conversión de número de canal de radio -> frecuencia de bajada (DL) en MHz.
//
// Android no entrega la frecuencia directamente: entrega el número de canal de la
// celda (EARFCN en LTE, NR-ARFCN en 5G, UARFCN en 3G, ARFCN en 2G) y la frecuencia
// se calcula con las fórmulas del 3GPP:
//   LTE   -> TS 36.101 §5.7.3   F_DL = F_DL_low + 0.1 · (N_DL − N_offs-DL)
//   5G NR -> TS 38.104 §5.4.2.1 F = F_ref-offs + ΔF_global · (N_ref − N_ref-offs)
//   UMTS  -> TS 25.101 §5.4.4
//   GSM   -> TS 45.005 §2
//
// El resultado es la frecuencia CENTRAL de la portadora de bajada de la celda que
// te sirve. No es un análisis de espectro: un teléfono no mide potencia por frecuencia.

const round = (x, d = 3) => Math.round(x * 10 ** d) / 10 ** d;

// [banda, F_DL_low (MHz), N_offs-DL, N_DL máximo]
const LTE_BANDS = [
  [1, 2110, 0, 599],
  [2, 1930, 600, 1199],
  [3, 1805, 1200, 1949],
  [4, 2110, 1950, 2399],
  [5, 869, 2400, 2649],
  [7, 2620, 2750, 3449],
  [8, 925, 3450, 3799],
  [12, 729, 5010, 5179],
  [13, 746, 5180, 5279],
  [14, 758, 5280, 5379],
  [17, 734, 5730, 5849],
  [18, 860, 5850, 5999],
  [19, 875, 6000, 6149],
  [20, 791, 6150, 6449],
  [25, 1930, 8040, 8689],
  [26, 859, 8690, 9039],
  [28, 758, 9210, 9659],
  [38, 2570, 37750, 38249],
  [39, 1880, 38250, 38649],
  [40, 2300, 38650, 39649],
  [41, 2496, 39650, 41589],
  [66, 2110, 66436, 67335],
  [71, 617, 68586, 68935],
];

export function lteDownlink(earfcn) {
  for (const [band, low, offs, max] of LTE_BANDS) {
    if (earfcn >= offs && earfcn <= max) {
      return { mhz: round(low + 0.1 * (earfcn - offs)), band };
    }
  }
  return null; // banda no incluida en la tabla
}

export function nrDownlink(nrarfcn) {
  let mhz;
  if (nrarfcn >= 0 && nrarfcn <= 599999) mhz = 0.005 * nrarfcn;
  else if (nrarfcn <= 2016666) mhz = 3000 + 0.015 * (nrarfcn - 600000);
  else if (nrarfcn <= 3279165) mhz = 24250.08 + 0.06 * (nrarfcn - 2016667);
  else return null;
  // La banda n78 / n77 / n41... se solapa en frecuencia: la da el sistema (Android 11+).
  return { mhz: round(mhz), band: null };
}

// [banda, UARFCN mín, UARFCN máx, offset MHz]  ->  F_DL = offset + UARFCN / 5
const UMTS_BANDS = [
  [1, 10562, 10838, 0],
  [2, 9662, 9938, 0],
  [3, 1162, 1513, 1575],
  [4, 1537, 1738, 1805],
  [5, 4357, 4458, 0],
  [8, 2937, 3088, 340],
];

export function umtsDownlink(uarfcn) {
  for (const [band, lo, hi, off] of UMTS_BANDS) {
    if (uarfcn >= lo && uarfcn <= hi) return { mhz: round(off + uarfcn / 5, 1), band };
  }
  return null;
}

export function gsmDownlink(n) {
  if (n >= 0 && n <= 124) return { mhz: round(935 + 0.2 * n, 1), band: 'GSM 900' };
  if (n >= 128 && n <= 251) return { mhz: round(869.2 + 0.2 * (n - 128), 1), band: 'GSM 850' };
  if (n >= 811 && n <= 885) return { mhz: round(1805.2 + 0.2 * (n - 512), 1), band: 'DCS 1800' };
  if (n >= 975 && n <= 1023) return { mhz: round(935 + 0.2 * (n - 1024), 1), band: 'GSM 900' };
  // 512–810 es ambiguo (DCS 1800 en la mayor parte del mundo, PCS 1900 en América):
  // sin saber el país/operador no se puede resolver, así que no se inventa.
  return null;
}

/**
 * @param {'EARFCN'|'NR-ARFCN'|'UARFCN'|'ARFCN'} type
 * @returns {{mhz:number, band:number|string|null}|null}
 */
export function resolveChannel(type, channel) {
  if (!Number.isFinite(channel)) return null;
  switch (type) {
    case 'EARFCN': return lteDownlink(channel);
    case 'NR-ARFCN': return nrDownlink(channel);
    case 'UARFCN': return umtsDownlink(channel);
    case 'ARFCN': return gsmDownlink(channel);
    default: return null;
  }
}
