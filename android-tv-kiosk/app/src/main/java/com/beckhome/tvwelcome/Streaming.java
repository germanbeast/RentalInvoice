package com.beckhome.tvwelcome;

import android.app.admin.DevicePolicyManager;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.ApplicationInfo;
import android.content.pm.PackageManager;
import android.content.pm.ResolveInfo;
import android.os.Build;
import android.provider.Settings;

import org.json.JSONObject;

/**
 * „Handy verbinden“: Gäste spiegeln ihr Handy auf den Fernseher.
 *
 * Eine Android-App kann selbst kein Miracast-/AirPlay-/Cast-Ziel sein, das macht eine Empfangs-App
 * auf der Box. Gesucht wird in dieser Reihenfolge:
 *  1. AirScreen (Play Store, kostenlos): AirPlay (iPhone/iPad/Mac), Google Cast und Miracast (Android)
 *  2. eine eingebaute Bildschirm-Spiegeln-/Miracast-App der Box (viele Amlogic-/Rockchip-Boxen haben eine)
 *  3. nur Chromecast built-in (Google-TV-Boxen): kein Start nötig, es kommt eine Anleitung
 *
 * Der Fernseher heißt dabei „Beckhome TV“ (im Admin änderbar). Beim Check-out bzw. Gästewechsel wird
 * die Empfangs-App beendet, damit keine Verbindung des alten Gastes übrig bleibt.
 */
final class Streaming {

    static final String DEFAULT_NAME = "Beckhome TV";
    static final String CHROMECAST = "com.google.android.apps.mediashell";
    /** Bekannte Empfangs-Apps, beste zuerst. */
    private static final String[] KNOWN = {
            "com.ionitech.airscreen",          // AirScreen: AirPlay + Google Cast + Miracast + DLNA
            "com.droidlogic.miracast",          // Amlogic-Boxen
            "com.amlogic.miracast",
            "com.rockchip.wfd",                 // Rockchip-Boxen
            "com.android.rockchip.miracast",
            "com.mediatek.wfd",
            "com.waxrain.airplaydmr",           // AirPin
            "com.eshare.server",                // EShare (auf vielen Boxen vorinstalliert)
            "com.hpplay.happycast",
            "com.hpplay.happyplay.aw",          // Lebo/HappyCast
    };
    /** Stichwörter im Paket- oder App-Namen, falls die Box eine eigene Spiegeln-App unter anderem Namen hat. */
    private static final String[] KEYWORDS = {
            "airscreen", "miracast", "mirror", "spiegeln", "screencast", "screen cast", "airplay", "airpin",
            "airreceiver", "eshare", "happycast", "wireless display", "drahtlose anzeige", "wfd"
    };

    private Streaming() {
    }

    private static SharedPreferences prefs(Context ctx) {
        return ctx.getSharedPreferences("WelcomeSettings", Context.MODE_PRIVATE);
    }

    static String deviceName(Context ctx) {
        String n = prefs(ctx).getString("stream_name", "").trim();
        return n.isEmpty() ? DEFAULT_NAME : n;
    }

    /** Startbare Empfangs-App auf dieser Box oder null. */
    static String receiverPackage(Context ctx) {
        PackageManager pm = ctx.getPackageManager();
        for (String p : KNOWN) {
            if (launchIntent(pm, p) != null) return p;
        }
        String[] categories = {"android.intent.category.LEANBACK_LAUNCHER", Intent.CATEGORY_LAUNCHER};
        for (String cat : categories) {
            Intent q = new Intent(Intent.ACTION_MAIN);
            q.addCategory(cat);
            for (ResolveInfo ri : pm.queryIntentActivities(q, 0)) {
                String p = ri.activityInfo.packageName;
                if (p.equals(ctx.getPackageName())) continue;
                CharSequence label = ri.loadLabel(pm);
                String hay = (p + " " + (label == null ? "" : label)).toLowerCase(java.util.Locale.ROOT);
                for (String kw : KEYWORDS) {
                    if (hay.contains(kw)) return p;
                }
            }
        }
        return null;
    }

    static Intent launchIntent(PackageManager pm, String pkg) {
        if (pkg == null) return null;
        Intent i = null;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP) i = pm.getLeanbackLaunchIntentForPackage(pkg);
        if (i == null) i = pm.getLaunchIntentForPackage(pkg);
        return i;
    }

    static boolean chromecastBuiltIn(Context ctx) {
        try {
            ApplicationInfo ai = ctx.getPackageManager().getApplicationInfo(CHROMECAST, 0);
            return ai.enabled;
        } catch (Exception e) {
            return false;
        }
    }

    /** Für den Admin (Einstellungen → TV-Box) und den Knopf auf dem Welcome-Screen. */
    static JSONObject info(Context ctx) {
        JSONObject o = new JSONObject();
        try {
            String p = receiverPackage(ctx);
            o.put("app", p == null ? "" : p);
            String label = "";
            if (p != null) {
                try {
                    PackageManager pm = ctx.getPackageManager();
                    label = String.valueOf(pm.getApplicationLabel(pm.getApplicationInfo(p, 0)));
                } catch (Exception ignored) {
                }
            }
            o.put("label", label);
            o.put("chromecast", chromecastBuiltIn(ctx));
            o.put("name", deviceName(ctx));
            o.put("nameSet", currentSystemName(ctx).equals(deviceName(ctx)));
        } catch (Exception ignored) {
        }
        return o;
    }

    private static String currentSystemName(Context ctx) {
        try {
            String n = Settings.Global.getString(ctx.getContentResolver(), "device_name");
            return n == null ? "" : n;
        } catch (Exception e) {
            return "";
        }
    }

    /**
     * Gerätename der Box setzen (Miracast-Ziel und Bluetooth nehmen ihn auf den meisten Boxen).
     * Braucht WRITE_SECURE_SETTINGS, das die .bat erteilt. AirScreen hat einen eigenen Namen in seinen Einstellungen.
     */
    static void applyDeviceName(Context ctx) {
        String name = deviceName(ctx);
        if (currentSystemName(ctx).equals(name)) return;
        try {
            Settings.Global.putString(ctx.getContentResolver(), "device_name", name);
        } catch (Exception ignored) {
        }
    }

    /** Empfangs-App wurde für einen Gast gestartet (beim Check-out beenden). */
    static void markUsed(Context ctx, String pkg) {
        prefs(ctx).edit().putString("stream_used", pkg == null ? "" : pkg).apply();
    }

    /** Darf im Kiosk-Modus laufen, auch wenn sich das Handy meldet, während der Welcome-Screen vorne ist. */
    static void allowInKiosk(Context ctx) {
        String p = receiverPackage(ctx);
        DevicePolicyManager dpm = (DevicePolicyManager) ctx.getSystemService(Context.DEVICE_POLICY_SERVICE);
        if (p == null || dpm == null || !dpm.isDeviceOwnerApp(ctx.getPackageName())) return;
        try {
            ComponentName admin = new ComponentName(ctx, AdminReceiver.class);
            java.util.LinkedHashSet<String> set = new java.util.LinkedHashSet<>(
                    java.util.Arrays.asList(dpm.getLockTaskPackages(admin)));
            if (set.add(p)) dpm.setLockTaskPackages(admin, set.toArray(new String[0]));
        } catch (Exception ignored) {
        }
    }

    /**
     * Server meldet den aktuellen Aufenthalt (Buchungs-Nummer, leer nach dem Check-out). Wechselt er,
     * wird die Empfangs-App beendet: laufende Spiegelung bricht ab, gemerkte Verbindungen sind weg.
     */
    static boolean onStayChanged(Context ctx, String stay) {
        SharedPreferences p = prefs(ctx);
        String prev = p.getString("stream_stay", null);
        if (stay.equals(prev)) return false;
        p.edit().putString("stream_stay", stay).commit();
        if (prev == null) return false; // erster Abgleich nach dem Update: nichts beenden
        String used = p.getString("stream_used", "");
        if (used.isEmpty()) return false;
        stop(ctx, used);
        p.edit().putString("stream_used", "").commit();
        return true;
    }

    /** App beenden: als Geräte-Eigentümer kurz ausblenden und wieder einblenden (stoppt alle Prozesse). */
    static void stop(Context ctx, String pkg) {
        DevicePolicyManager dpm = (DevicePolicyManager) ctx.getSystemService(Context.DEVICE_POLICY_SERVICE);
        if (dpm == null || !dpm.isDeviceOwnerApp(ctx.getPackageName())) return;
        ComponentName admin = new ComponentName(ctx, AdminReceiver.class);
        try {
            dpm.setApplicationHidden(admin, pkg, true);
        } catch (Exception ignored) {
        }
        try {
            dpm.setApplicationHidden(admin, pkg, false);
        } catch (Exception ignored) {
        }
    }
}
