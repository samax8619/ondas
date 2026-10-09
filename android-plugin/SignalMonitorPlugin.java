package com.example.senalcelular;

import android.Manifest;
import android.annotation.SuppressLint;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.location.LocationManager;
import android.net.Uri;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.provider.Settings;
import android.telephony.CellIdentityGsm;
import android.telephony.CellIdentityLte;
import android.telephony.CellIdentityNr;
import android.telephony.CellIdentityWcdma;
import android.telephony.CellInfo;
import android.telephony.CellInfoCdma;
import android.telephony.CellInfoGsm;
import android.telephony.CellInfoLte;
import android.telephony.CellInfoNr;
import android.telephony.CellInfoWcdma;
import android.telephony.CellSignalStrengthCdma;
import android.telephony.CellSignalStrengthGsm;
import android.telephony.CellSignalStrengthLte;
import android.telephony.CellSignalStrengthNr;
import android.telephony.CellSignalStrengthWcdma;
import android.telephony.SubscriptionManager;
import android.telephony.TelephonyManager;

import androidx.core.content.ContextCompat;

import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;

import java.util.List;

/**
 * Lee la celda que sirve al teléfono (potencia en dBm y número de canal) y la empuja a la
 * interfaz web como el evento "signal". La conversión canal -> MHz se hace en JavaScript
 * (www/arfcn.js) para tener una sola implementación testeable.
 *
 * Requiere Android 10 (API 29) o superior: usa requestCellInfoUpdate() y las clases CellInfoNr.
 *
 * Permisos (alias "signal"): READ_PHONE_STATE + ubicación precisa. Android considera la identidad
 * de la celda como dato de ubicación, por eso exige ACCESS_FINE_LOCATION aunque la app no use GPS.
 * Capacitor expone automáticamente checkPermissions() y requestPermissions() para este alias.
 */
@CapacitorPlugin(
    name = "SignalMonitor",
    permissions = {
        @Permission(
            alias = "signal",
            strings = {
                Manifest.permission.READ_PHONE_STATE,
                Manifest.permission.ACCESS_FINE_LOCATION,
                // Desde Android 12 el diálogo exige pedir COARSE junto con FINE.
                Manifest.permission.ACCESS_COARSE_LOCATION
            }
        )
    }
)
public class SignalMonitorPlugin extends Plugin {

    private static final int UNAVAILABLE = Integer.MAX_VALUE; // CellInfo.UNAVAILABLE
    private static final long REQUEST_TIMEOUT_MS = 5000;

    private final Handler main = new Handler(Looper.getMainLooper());
    private TelephonyManager tm;
    private boolean running = false;
    private boolean resumeOnForeground = false;
    private boolean inFlight = false;
    private long lastRequestAt = 0;
    private long intervalMs = 1000;

    private final Runnable tick = new Runnable() {
        @Override
        public void run() {
            if (!running) return;
            sample();
            main.postDelayed(this, intervalMs);
        }
    };

    /* ------------------------------------------------------------------ */
    /* API para JavaScript                                                  */
    /* ------------------------------------------------------------------ */

    @PluginMethod
    public void start(PluginCall call) {
        if (getPermissionState("signal") != PermissionState.GRANTED) {
            call.reject("Faltan los permisos de teléfono y ubicación precisa.", "PERMISSION_DENIED");
            return;
        }
        Context ctx = getContext();
        if (!ctx.getPackageManager().hasSystemFeature(PackageManager.FEATURE_TELEPHONY)) {
            call.reject("Este dispositivo no tiene módem celular.", "NO_TELEPHONY");
            return;
        }

        TelephonyManager base = (TelephonyManager) ctx.getSystemService(Context.TELEPHONY_SERVICE);
        // En equipos dual-SIM se mide la SIM que lleva los datos móviles.
        int subId = SubscriptionManager.getDefaultDataSubscriptionId();
        tm = (subId != SubscriptionManager.INVALID_SUBSCRIPTION_ID) ? base.createForSubscriptionId(subId) : base;

        int requested = call.getInt("intervalMs", 1000);
        intervalMs = Math.max(500, Math.min(10000, requested));

        main.removeCallbacks(tick);
        running = true;
        resumeOnForeground = true;
        main.post(tick);
        call.resolve();
    }

    @PluginMethod
    public void stop(PluginCall call) {
        halt();
        resumeOnForeground = false;
        call.resolve();
    }

    /** Abre Ajustes > Apps > esta app, para el caso "No volver a preguntar". */
    @PluginMethod
    public void openSettings(PluginCall call) {
        Intent i = new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.fromParts("package", getContext().getPackageName(), null));
        i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        getContext().startActivity(i);
        call.resolve();
    }

    /* ------------------------------------------------------------------ */
    /* Ciclo de vida: en segundo plano Android limita el acceso al módem   */
    /* ------------------------------------------------------------------ */

    @Override
    protected void handleOnPause() {
        halt();
    }

    @Override
    protected void handleOnResume() {
        if (resumeOnForeground && tm != null && !running) {
            running = true;
            main.post(tick);
        }
    }

    @Override
    protected void handleOnDestroy() {
        halt();
    }

    private void halt() {
        running = false;
        inFlight = false;
        main.removeCallbacks(tick);
    }

    /* ------------------------------------------------------------------ */
    /* Muestreo                                                             */
    /* ------------------------------------------------------------------ */

    @SuppressLint("MissingPermission")
    private void sample() {
        if (tm == null) return;
        long now = System.currentTimeMillis();
        if (inFlight && now - lastRequestAt < REQUEST_TIMEOUT_MS) return; // no apilar peticiones al módem
        inFlight = true;
        lastRequestAt = now;
        try {
            tm.requestCellInfoUpdate(ContextCompat.getMainExecutor(getContext()), new TelephonyManager.CellInfoCallback() {
                @Override
                public void onCellInfo(List<CellInfo> cellInfo) {
                    inFlight = false;
                    publish(cellInfo);
                }

                @Override
                public void onError(int errorCode, Throwable detail) {
                    // Algunos módems no soportan la petición activa: se usa el último valor en caché.
                    inFlight = false;
                    try {
                        publish(tm.getAllCellInfo());
                    } catch (SecurityException e) {
                        fail("PERMISSION_DENIED", e.getMessage());
                    }
                }
            });
        } catch (SecurityException e) {
            inFlight = false;
            fail("PERMISSION_DENIED", e.getMessage());
        }
    }

    private void publish(List<CellInfo> cells) {
        JSObject out = new JSObject();
        out.put("t", System.currentTimeMillis());
        String operator = tm.getNetworkOperatorName();
        if (operator != null && !operator.isEmpty()) out.put("operator", operator);

        CellInfo pick = null;
        int registered = 0;
        if (cells != null) {
            for (CellInfo c : cells) {
                if (!c.isRegistered()) continue;
                registered++;
                // Con 5G se prefiere la celda NR; si no, la primera registrada.
                if (pick == null || (c instanceof CellInfoNr && !(pick instanceof CellInfoNr))) pick = c;
            }
        }
        out.put("registeredCells", registered);

        if (pick == null) {
            out.put("tech", "NONE");
            if ((cells == null || cells.isEmpty()) && !isLocationEnabled()) {
                fail("LOCATION_OFF", "Sin celdas: la ubicación del sistema está apagada.");
            }
        } else {
            describe(pick, out);
        }
        notifyListeners("signal", out);
    }

    private void describe(CellInfo ci, JSObject o) {
        if (ci instanceof CellInfoNr) {
            CellInfoNr nr = (CellInfoNr) ci;
            CellSignalStrengthNr ss = (CellSignalStrengthNr) nr.getCellSignalStrength();
            CellIdentityNr id = (CellIdentityNr) nr.getCellIdentity();
            o.put("tech", "NR");
            int dbm = ss.getSsRsrp();
            if (dbm == UNAVAILABLE) dbm = ss.getDbm();
            putIfValid(o, "dbm", dbm);
            putIfValid(o, "rsrq", ss.getSsRsrq());
            putIfValid(o, "snr", ss.getSsSinr());
            o.put("level", ss.getLevel());
            putIfValid(o, "channel", id.getNrarfcn());
            o.put("channelType", "NR-ARFCN");
            putIfValid(o, "pci", id.getPci());
            if (Build.VERSION.SDK_INT >= 30) {
                int[] bands = id.getBands();
                if (bands != null && bands.length > 0) o.put("band", bands[0]);
            }
        } else if (ci instanceof CellInfoLte) {
            CellInfoLte lte = (CellInfoLte) ci;
            CellSignalStrengthLte ss = lte.getCellSignalStrength();
            CellIdentityLte id = lte.getCellIdentity();
            o.put("tech", "LTE");
            int dbm = ss.getRsrp();
            if (dbm == UNAVAILABLE) dbm = ss.getDbm();
            putIfValid(o, "dbm", dbm);
            putIfValid(o, "rsrq", ss.getRsrq());
            putIfValid(o, "snr", ss.getRssnr());
            o.put("level", ss.getLevel());
            putIfValid(o, "channel", id.getEarfcn());
            o.put("channelType", "EARFCN");
            putIfValid(o, "pci", id.getPci());
            if (Build.VERSION.SDK_INT >= 30) {
                int[] bands = id.getBands();
                if (bands != null && bands.length > 0) o.put("band", bands[0]);
            }
        } else if (ci instanceof CellInfoWcdma) {
            CellInfoWcdma w = (CellInfoWcdma) ci;
            CellSignalStrengthWcdma ss = w.getCellSignalStrength();
            CellIdentityWcdma id = w.getCellIdentity();
            o.put("tech", "WCDMA");
            putIfValid(o, "dbm", ss.getDbm());
            o.put("level", ss.getLevel());
            putIfValid(o, "channel", id.getUarfcn());
            o.put("channelType", "UARFCN");
            putIfValid(o, "pci", id.getPsc());
        } else if (ci instanceof CellInfoGsm) {
            CellInfoGsm g = (CellInfoGsm) ci;
            CellSignalStrengthGsm ss = g.getCellSignalStrength();
            CellIdentityGsm id = g.getCellIdentity();
            o.put("tech", "GSM");
            putIfValid(o, "dbm", ss.getDbm());
            o.put("level", ss.getLevel());
            putIfValid(o, "channel", id.getArfcn());
            o.put("channelType", "ARFCN");
        } else if (ci instanceof CellInfoCdma) {
            CellSignalStrengthCdma ss = ((CellInfoCdma) ci).getCellSignalStrength();
            o.put("tech", "CDMA");
            putIfValid(o, "dbm", ss.getDbm());
            o.put("level", ss.getLevel());
        } else {
            o.put("tech", "NONE");
        }
    }

    private static void putIfValid(JSObject o, String key, int value) {
        if (value != UNAVAILABLE) o.put(key, value);
    }

    private boolean isLocationEnabled() {
        LocationManager lm = (LocationManager) getContext().getSystemService(Context.LOCATION_SERVICE);
        return lm != null && lm.isLocationEnabled();
    }

    private void fail(String code, String message) {
        JSObject e = new JSObject();
        e.put("code", code);
        e.put("message", message == null ? code : message);
        notifyListeners("error", e);
    }
}
