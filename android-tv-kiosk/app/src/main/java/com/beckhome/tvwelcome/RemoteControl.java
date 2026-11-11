package com.beckhome.tvwelcome;

import android.app.ActivityManager;
import android.app.admin.DevicePolicyManager;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageInfo;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;

import org.json.JSONObject;

import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.Inet4Address;
import java.net.InetAddress;
import java.net.NetworkInterface;
import java.net.URL;
import java.security.SecureRandom;
import java.util.Collections;
import java.util.UUID;

/**
 * Fernsteuerung aus dem Admin (Einstellungen → TV-Box). Die Box meldet sich jede Minute bei
 * /api/tv-box/sync mit einer eigenen zufälligen Kennung. Erst nachdem der Gastgeber sie im Admin
 * gekoppelt hat, bekommt sie Einstellungen (PIN, Kiosk an/aus, Ruhezeit) und Befehle
 * (Welcome-Screen zeigen, neu laden, Android-Einstellungen, Neustart, Update suchen).
 */
final class RemoteControl {

    static final String EXTRA_OPEN_SETTINGS = "open_settings";
    private static final String PREFS = "WelcomeSettings";
    private static volatile boolean running = false;
    /** Letzter Fehler beim Melden (für den Kopplungs-Bildschirm), null = ok. */
    static volatile String lastError = null;

    private RemoteControl() {
    }

    private static SharedPreferences prefs(Context ctx) {
        return ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    static boolean isPaired(SharedPreferences p) {
        return p.getBoolean("paired", false);
    }

    /** Welcome-Seite laden? Nur gekoppelt – oder wenn der Server die Kopplung noch nicht kennt (alte Version). */
    static boolean mayShowWelcome(SharedPreferences p) {
        return isPaired(p) || p.getBoolean("server_legacy", false);
    }

    /** Ausweis für den Server (Cookie tvbox_auth): Kennung.Schlüssel */
    static String authToken(SharedPreferences p) {
        deviceId(p);
        return p.getString("device_id", "") + "." + p.getString("device_key", "");
    }

    /** 6-stelliger Kopplungs-Code, bleibt bis zur Kopplung gleich. */
    static synchronized String pairCode(SharedPreferences p) {
        String c = p.getString("pair_code", "");
        if (!c.matches("[0-9]{6}")) {
            c = String.format(java.util.Locale.ROOT, "%06d", new SecureRandom().nextInt(1000000));
            p.edit().putString("pair_code", c).commit();
        }
        return c;
    }

    /** Kiosk ist aus: per PIN bis zum Neustart ausgesetzt oder im Admin ausgeschaltet. */
    static boolean kioskOff(SharedPreferences p) {
        return p.getBoolean("kiosk_paused", false) || p.getBoolean("remote_kiosk_off", false);
    }

    static boolean kioskOff(Context ctx) {
        return kioskOff(prefs(ctx));
    }

    /** Ruhezeit bis zur Rückkehr zum Welcome-Screen (Admin, Standard 4 Stunden, 0 = aus). */
    static long idleHomeMs(Context ctx) {
        float h = prefs(ctx).getFloat("idle_hours", 4f);
        return h <= 0 ? 0 : (long) (h * 60 * 60 * 1000L);
    }

    static void syncAsync(final Context ctx, final boolean screenOn) {
        if (running) return;
        running = true;
        new Thread(new Runnable() {
            @Override
            public void run() {
                try {
                    sync(ctx.getApplicationContext(), screenOn);
                } catch (Exception ignored) {
                } finally {
                    running = false;
                }
            }
        }, "remote-sync").start();
    }

    private static synchronized String deviceId(SharedPreferences p) {
        String id = p.getString("device_id", "");
        String key = p.getString("device_key", "");
        if (id.isEmpty() || key.length() != 64) {
            id = UUID.randomUUID().toString();
            byte[] b = new byte[32];
            new SecureRandom().nextBytes(b);
            StringBuilder sb = new StringBuilder();
            for (byte x : b) sb.append(String.format("%02x", x));
            key = sb.toString();
            p.edit().putString("device_id", id).putString("device_key", key).commit();
        }
        return id;
    }

    private static void sync(final Context ctx, boolean screenOn) throws Exception {
        SharedPreferences p = prefs(ctx);
        String id = deviceId(p);
        PackageInfo info = ctx.getPackageManager().getPackageInfo(ctx.getPackageName(), 0);
        long mine = Build.VERSION.SDK_INT >= 28 ? info.getLongVersionCode() : info.versionCode;
        DevicePolicyManager dpm = (DevicePolicyManager) ctx.getSystemService(Context.DEVICE_POLICY_SERVICE);
        boolean owner = dpm != null && dpm.isDeviceOwnerApp(ctx.getPackageName());

        JSONObject body = new JSONObject();
        body.put("deviceId", id);
        body.put("key", p.getString("device_key", ""));
        body.put("versionCode", mine);
        body.put("versionName", String.valueOf(info.versionName));
        body.put("model", (Build.MANUFACTURER + " " + Build.MODEL).trim());
        body.put("android", Build.VERSION.RELEASE);
        body.put("ip", localIp());
        body.put("kioskActive", lockTaskActive(ctx));
        body.put("deviceOwner", owner);
        body.put("keyWatch", KeyWatchService.connected);
        body.put("onWelcome", MainActivity.inFront);
        body.put("screenOn", screenOn);
        body.put("idleMinutes", (System.currentTimeMillis() - WatchService.lastActive()) / 60000L);
        body.put("ackSeq", p.getLong("remote_ack", 0));
        body.put("configVersion", p.getInt("remote_config_version", 0));
        body.put("pairCode", pairCode(p));
        body.put("printers", Printer.foundJson());
        body.put("printError", Printer.lastError);

        String text;
        try {
            text = post(server(p) + "/api/tv-box/sync", body.toString());
        } catch (LegacyServer e) {
            // Server kennt die Fernsteuerung noch nicht: Welcome-Seite wie bisher zeigen
            lastError = null;
            setState(ctx, p, isPaired(p), true);
            return;
        } catch (Exception e) {
            lastError = e.getMessage() != null ? e.getMessage() : e.getClass().getSimpleName();
            throw e;
        }
        lastError = null;
        JSONObject res = new JSONObject(text);
        boolean paired = res.optBoolean("paired", false);
        setState(ctx, p, paired, false);
        if (!paired) return;
        JSONObject welcome = res.optJSONObject("welcome");
        if (welcome != null) p.edit().putString("welcome_json", welcome.toString()).apply(); // für den Offline-Welcome-Screen

        JSONObject cfg = res.optJSONObject("config");
        if (cfg != null) applyConfig(ctx, p, cfg);

        // Neue Buchungen drucken (im Hintergrund, der Fernseher zeigt davon nichts)
        Printer.discoverIfDue(ctx);
        JSONObject print = res.optJSONObject("print");
        if (print != null) Printer.runAsync(print, server(p), authToken(p));

        JSONObject cmd = res.optJSONObject("command");
        if (cmd != null) {
            long seq = cmd.optLong("seq", 0);
            if (seq > p.getLong("remote_ack", 0)) {
                p.edit().putLong("remote_ack", seq).commit(); // erst quittieren, damit z.B. Neustart nicht wiederholt wird
                runCommand(ctx, cmd.optString("type", ""), owner, dpm);
            }
        }
    }

    /** Kopplungs-Zustand merken; bei Wechsel Welcome-Screen bzw. Kopplungs-Code neu anzeigen. */
    private static void setState(Context ctx, SharedPreferences p, boolean paired, boolean legacy) {
        boolean wasPaired = isPaired(p), wasLegacy = p.getBoolean("server_legacy", false);
        if (wasPaired == paired && wasLegacy == legacy) return;
        SharedPreferences.Editor e = p.edit().putBoolean("paired", paired).putBoolean("server_legacy", legacy);
        if (wasPaired && !paired) e.remove("pair_code"); // Kopplung aufgehoben: neuer Code
        e.commit();
        showWelcome(ctx, false);
    }

    private static final class LegacyServer extends Exception {
    }

    private static void applyConfig(final Context ctx, SharedPreferences p, JSONObject cfg) {
        boolean wasOff = p.getBoolean("remote_kiosk_off", false);
        boolean off = !cfg.optBoolean("kiosk", true);
        SharedPreferences.Editor e = p.edit();
        e.putBoolean("remote_kiosk_off", off);
        e.putFloat("idle_hours", (float) cfg.optDouble("idleHours", 4));
        String pin = cfg.optString("adminPin", "");
        if (!pin.isEmpty()) e.putString("admin_pin", pin);
        e.putInt("remote_config_version", cfg.optInt("version", 0));
        e.commit();
        if (wasOff != off) {
            // Welcome-Screen holen: setzt die Sperre (Kiosk an) oder löst sie (Kiosk aus)
            if (!off) p.edit().putBoolean("kiosk_paused", false).commit();
            showWelcome(ctx, false);
        }
    }

    private static void runCommand(Context ctx, String type, boolean owner, DevicePolicyManager dpm) {
        switch (type) {
            case "show_welcome":
            case "reload":
                showWelcome(ctx, false);
                break;
            case "open_settings":
                showWelcome(ctx, true);
                break;
            case "update_check":
                for (String k : prefs(ctx).getAll().keySet()) {
                    if (k.startsWith("update_tried_")) prefs(ctx).edit().remove(k).commit();
                }
                SelfUpdater.checkAsync(ctx);
                break;
            case "reboot":
                if (owner && Build.VERSION.SDK_INT >= 24) {
                    try {
                        dpm.reboot(new ComponentName(ctx, AdminReceiver.class));
                    } catch (Exception ignored) {
                    }
                }
                break;
        }
    }

    private static void showWelcome(final Context ctx, final boolean openSettings) {
        new Handler(Looper.getMainLooper()).post(new Runnable() {
            @Override
            public void run() {
                try {
                    Intent i = new Intent(ctx, MainActivity.class);
                    i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP
                            | Intent.FLAG_ACTIVITY_REORDER_TO_FRONT);
                    i.putExtra(MainActivity.EXTRA_RESET, true);
                    if (openSettings) i.putExtra(EXTRA_OPEN_SETTINGS, true);
                    ctx.startActivity(i);
                } catch (Exception ignored) {
                }
            }
        });
    }

    private static boolean lockTaskActive(Context ctx) {
        try {
            ActivityManager am = (ActivityManager) ctx.getSystemService(Context.ACTIVITY_SERVICE);
            return am != null && am.getLockTaskModeState() != ActivityManager.LOCK_TASK_MODE_NONE;
        } catch (Exception e) {
            return false;
        }
    }

    private static String server(SharedPreferences p) {
        String server = p.getString("server_url", MainActivity.DEFAULT_SERVER_URL).trim();
        server = server.replaceAll("/welcome\\.html.*$", "").replaceAll("/+$", "");
        if (server.isEmpty()) server = MainActivity.DEFAULT_SERVER_URL;
        if (!server.contains("://")) server = "https://" + server;
        return server;
    }

    private static String localIp() {
        try {
            for (NetworkInterface ni : Collections.list(NetworkInterface.getNetworkInterfaces())) {
                if (!ni.isUp() || ni.isLoopback()) continue;
                for (InetAddress a : Collections.list(ni.getInetAddresses())) {
                    if (a instanceof Inet4Address && !a.isLoopbackAddress()) return a.getHostAddress();
                }
            }
        } catch (Exception ignored) {
        }
        return "";
    }

    private static String post(String url, String json) throws Exception {
        HttpURLConnection c = (HttpURLConnection) new URL(url).openConnection();
        c.setConnectTimeout(15000);
        c.setReadTimeout(15000);
        c.setRequestMethod("POST");
        c.setDoOutput(true);
        c.setRequestProperty("Content-Type", "application/json; charset=utf-8");
        try {
            try (OutputStream os = c.getOutputStream()) {
                os.write(json.getBytes("UTF-8"));
            }
            int code = c.getResponseCode();
            if (code == 404) throw new LegacyServer();
            if (code != 200) throw new Exception("HTTP " + code);
            try (InputStream in = c.getInputStream()) {
                java.io.ByteArrayOutputStream bo = new java.io.ByteArrayOutputStream();
                byte[] buf = new byte[4096];
                int n;
                while ((n = in.read(buf)) > 0 && bo.size() < 100000) bo.write(buf, 0, n);
                return bo.toString("UTF-8");
            }
        } finally {
            c.disconnect();
        }
    }
}
