// Gestión de permisos.
//
// IMPORTANTE: en un navegador NO existe ningún permiso que desbloquee la señal celular.
// Lo que sí hay es:
//   - Android nativo (Capacitor): READ_PHONE_STATE + ubicación precisa. Android trata la
//     identidad de la celda (canal, PCI) como dato de ubicación, por eso la pide.
//   - Navegador, OPCIONAL: Geolocation (solo para etiquetar el CSV con coordenadas) y
//     Screen Wake Lock (mantener la pantalla encendida mientras se mide).
//
// Estados normalizados: 'granted' | 'denied' | 'prompt' | 'unsupported'

import { getNativePlugin } from './sources.js';

const norm = (s) => (s === 'granted' ? 'granted' : s === 'denied' ? 'denied' : 'prompt');

/* ---------------- Android nativo ---------------- */

export async function nativeState() {
  const p = getNativePlugin();
  if (!p) return 'unsupported';
  const r = await p.checkPermissions(); // { signal: 'granted' | 'denied' | 'prompt' | 'prompt-with-rationale' }
  return norm(r.signal);
}

/**
 * Pide los permisos del módem. Si el usuario marcó "No volver a preguntar", Android ya no
 * muestra el diálogo y el resultado sigue siendo 'denied': en ese caso hay que mandarlo a
 * Ajustes (openAppSettings).
 */
export async function requestNative() {
  const p = getNativePlugin();
  if (!p) return 'unsupported';
  if ((await nativeState()) === 'granted') return 'granted';
  const r = await p.requestPermissions({ permissions: ['signal'] });
  return norm(r.signal);
}

export async function openAppSettings() {
  await getNativePlugin()?.openSettings();
}

/* ---------------- Geolocalización (opcional) ---------------- */

export async function geolocationState() {
  if (!('geolocation' in navigator)) return 'unsupported';
  if (!window.isSecureContext) return 'unsupported'; // exige HTTPS o localhost
  try {
    const s = await navigator.permissions.query({ name: 'geolocation' });
    return norm(s.state);
  } catch {
    return 'prompt'; // Safari antiguo: no permite consultar el estado sin pedirlo
  }
}

let geoWatchId = null;
export let lastFix = null;

/** Dispara el diálogo del navegador y empieza a seguir la posición. */
export function startGeolocation(onChange) {
  return new Promise((resolve) => {
    if (!('geolocation' in navigator)) return resolve('unsupported');
    let settled = false;
    geoWatchId = navigator.geolocation.watchPosition(
      (pos) => {
        lastFix = { lat: pos.coords.latitude, lon: pos.coords.longitude, acc: pos.coords.accuracy };
        if (!settled) { settled = true; resolve('granted'); }
        onChange?.('granted');
      },
      (err) => {
        lastFix = null;
        const state = err.code === err.PERMISSION_DENIED ? 'denied' : 'prompt';
        if (!settled) { settled = true; resolve(state); }
        onChange?.(state);
      },
      { enableHighAccuracy: true, maximumAge: 5000, timeout: 15000 },
    );
  });
}

export function stopGeolocation() {
  if (geoWatchId != null) navigator.geolocation.clearWatch(geoWatchId);
  geoWatchId = null;
  lastFix = null;
}

/* ---------------- Pantalla encendida (Screen Wake Lock) ---------------- */

let wakeLock = null;
let wantAwake = false;

async function acquire() {
  try {
    wakeLock = await navigator.wakeLock.request('screen');
    wakeLock.addEventListener('release', () => { wakeLock = null; });
    return true;
  } catch {
    return false; // batería baja, pestaña oculta, política del navegador...
  }
}

export function wakeLockSupported() { return 'wakeLock' in navigator; }

export async function keepAwake(on) {
  wantAwake = on;
  if (!wakeLockSupported()) return false;
  if (on) return wakeLock ? true : acquire();
  await wakeLock?.release();
  wakeLock = null;
  return true;
}

// El navegador libera el bloqueo al ocultar la pestaña: se vuelve a pedir al regresar.
document.addEventListener('visibilitychange', () => {
  if (wantAwake && !wakeLock && document.visibilityState === 'visible') acquire();
});
