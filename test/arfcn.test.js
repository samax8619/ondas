import test from 'node:test';
import assert from 'node:assert/strict';
import { lteDownlink, nrDownlink, umtsDownlink, gsmDownlink, resolveChannel } from '../www/arfcn.js';
import { normalize } from '../www/sources.js';
import { classify, thresholdsFor } from '../www/quality.js';

test('LTE: EARFCN -> MHz de bajada (TS 36.101)', () => {
  assert.deepEqual(lteDownlink(0), { mhz: 2110, band: 1 }); // inicio de la banda 1
  assert.deepEqual(lteDownlink(100), { mhz: 2120, band: 1 });
  assert.deepEqual(lteDownlink(1500), { mhz: 1835, band: 3 });
  assert.deepEqual(lteDownlink(3100), { mhz: 2655, band: 7 });
  assert.deepEqual(lteDownlink(6300), { mhz: 806, band: 20 });
  assert.deepEqual(lteDownlink(9435), { mhz: 780.5, band: 28 });
  assert.deepEqual(lteDownlink(66436), { mhz: 2110, band: 66 });
  assert.equal(lteDownlink(99999), null);
});

test('NR: NR-ARFCN -> MHz (TS 38.104)', () => {
  assert.equal(nrDownlink(158200).mhz, 791); // 0.005 · N
  assert.equal(nrDownlink(600000).mhz, 3000); // inicio del tramo de 15 kHz
  assert.equal(nrDownlink(632628).mhz, 3489.42);
  assert.equal(nrDownlink(2016667).mhz, 24250.08); // inicio del tramo de 60 kHz
  assert.equal(nrDownlink(4000000), null);
});

test('UMTS y GSM', () => {
  assert.deepEqual(umtsDownlink(10700), { mhz: 2140, band: 1 });
  assert.deepEqual(umtsDownlink(1537), { mhz: 2112.4, band: 4 });
  assert.deepEqual(gsmDownlink(1), { mhz: 935.2, band: 'GSM 900' });
  assert.equal(gsmDownlink(600), null); // 512–810 es ambiguo (1800 vs 1900): no se inventa
});

test('resolveChannel rechaza tipos y valores inválidos', () => {
  assert.equal(resolveChannel('FOO', 100), null);
  assert.equal(resolveChannel('EARFCN', NaN), null);
});

test('normalize resuelve frecuencia y banda, y limpia valores inválidos', () => {
  const s = normalize({ tech: 'LTE', dbm: -91, channel: 1500, channelType: 'EARFCN', rsrq: undefined, snr: null });
  assert.equal(s.freqMhz, 1835);
  assert.equal(s.band, 3);
  assert.equal(s.rsrq, null);
  assert.equal(s.snr, null);

  // si el sistema ya informa la banda (Android 11+), se respeta
  const nr = normalize({ tech: 'NR', dbm: -95, channel: 632628, channelType: 'NR-ARFCN', band: 78 });
  assert.equal(nr.band, 78);
  assert.equal(nr.freqMhz, 3489.42);
});

test('clasificación de calidad', () => {
  assert.equal(classify(-75, 'LTE').id, 'excellent');
  assert.equal(classify(-95, 'LTE').id, 'fair');
  assert.equal(classify(-115, 'NR').id, 'bad');
  assert.equal(classify(-80, 'GSM').id, 'good'); // escala RSSI de 2G/3G
  assert.equal(classify(null, 'LTE'), null);
  assert.equal(thresholdsFor('LTE').length, 4);
});
