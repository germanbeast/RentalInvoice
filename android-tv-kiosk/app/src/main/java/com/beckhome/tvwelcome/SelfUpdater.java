package com.beckhome.tvwelcome;

import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageInfo;
import android.content.pm.PackageInstaller;
import android.os.Build;

import org.json.JSONObject;

import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.net.URLEncoder;
import java.security.MessageDigest;

/**
 * Selbst-Update: fragt den Server (/api/tv-app), welche Version im Admin unter
 * Einstellungen → TV-Box freigegeben ist, lädt die APK von GitHub, prüft die SHA-256-Summe
 * und installiert sie. Als Geräte-Eigentümer (Kiosk-Modus) ohne Rückfrage, sonst zeigt
 * Android einmal „Installieren?“.
 */
final class SelfUpdater {

    private static final long RETRY_MS = 3 * 60 * 60 * 1000L;
    private static volatile boolean running = false;

    private SelfUpdater() {
    }

    static void checkAsync(final Context ctx) {
        if (running) return;
        running = true;
        new Thread(new Runnable() {
            @Override
            public void run() {
                try {
                    check(ctx.getApplicationContext());
                } catch (Exception ignored) {
                } finally {
                    running = false;
                }
            }
        }, "self-update").start();
    }

    private static void check(Context ctx) throws Exception {
        SharedPreferences prefs = ctx.getSharedPreferences("WelcomeSettings", Context.MODE_PRIVATE);
        PackageInfo info = ctx.getPackageManager().getPackageInfo(ctx.getPackageName(), 0);
        long mine = Build.VERSION.SDK_INT >= 28 ? info.getLongVersionCode() : info.versionCode;

        String server = prefs.getString("server_url", MainActivity.DEFAULT_SERVER_URL).trim().replaceAll("/+$", "");
        if (server.isEmpty()) server = MainActivity.DEFAULT_SERVER_URL;
        if (!server.contains("://")) server = "https://" + server;
        String q = server + "/api/tv-app?v=" + mine + "&n=" + URLEncoder.encode(String.valueOf(info.versionName), "UTF-8");

        JSONObject res = new JSONObject(readText(q));
        JSONObject approved = res.optJSONObject("approved");
        if (approved == null) return;
        long code = approved.optLong("versionCode", 0);
        String url = approved.optString("url", "");
        String sha = approved.optString("sha256", "").toLowerCase();
        if (code <= mine || !url.startsWith("https://") || sha.length() != 64) return;

        // nicht bei jeder Abfrage erneut versuchen, falls die Installation scheitert
        String key = "update_tried_" + code;
        long tried = prefs.getLong(key, 0);
        if (System.currentTimeMillis() - tried < RETRY_MS) return;
        prefs.edit().putLong(key, System.currentTimeMillis()).apply();

        File apk = new File(ctx.getCacheDir(), "update.apk");
        download(url, apk);
        if (!sha.equals(sha256(apk))) {
            apk.delete();
            return;
        }
        install(ctx, apk);
    }

    private static String readText(String url) throws Exception {
        HttpURLConnection c = (HttpURLConnection) new URL(url).openConnection();
        c.setConnectTimeout(15000);
        c.setReadTimeout(15000);
        try (InputStream in = c.getInputStream()) {
            StringBuilder sb = new StringBuilder();
            byte[] buf = new byte[4096];
            int n;
            while ((n = in.read(buf)) > 0 && sb.length() < 100000) sb.append(new String(buf, 0, n, "UTF-8"));
            return sb.toString();
        } finally {
            c.disconnect();
        }
    }

    private static void download(String url, File out) throws Exception {
        HttpURLConnection c = (HttpURLConnection) new URL(url).openConnection();
        c.setInstanceFollowRedirects(true);
        c.setConnectTimeout(20000);
        c.setReadTimeout(60000);
        try (InputStream in = c.getInputStream(); OutputStream os = new FileOutputStream(out)) {
            byte[] buf = new byte[65536];
            int n;
            long total = 0;
            while ((n = in.read(buf)) > 0) {
                os.write(buf, 0, n);
                total += n;
                if (total > 100L * 1024 * 1024) throw new Exception("APK zu groß");
            }
        } finally {
            c.disconnect();
        }
    }

    private static String sha256(File f) throws Exception {
        MessageDigest md = MessageDigest.getInstance("SHA-256");
        try (InputStream in = new FileInputStream(f)) {
            byte[] buf = new byte[65536];
            int n;
            while ((n = in.read(buf)) > 0) md.update(buf, 0, n);
        }
        StringBuilder sb = new StringBuilder();
        for (byte b : md.digest()) sb.append(String.format("%02x", b));
        return sb.toString();
    }

    private static void install(Context ctx, File apk) throws Exception {
        PackageInstaller installer = ctx.getPackageManager().getPackageInstaller();
        PackageInstaller.SessionParams params =
                new PackageInstaller.SessionParams(PackageInstaller.SessionParams.MODE_FULL_INSTALL);
        params.setAppPackageName(ctx.getPackageName());
        if (Build.VERSION.SDK_INT >= 31) {
            params.setRequireUserAction(PackageInstaller.SessionParams.USER_ACTION_NOT_REQUIRED);
        }
        int id = installer.createSession(params);
        try (PackageInstaller.Session session = installer.openSession(id)) {
            try (InputStream in = new FileInputStream(apk);
                 OutputStream out = session.openWrite("update.apk", 0, apk.length())) {
                byte[] buf = new byte[65536];
                int n;
                while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
                session.fsync(out);
            }
            Intent cb = new Intent(ctx, InstallReceiver.class);
            int flags = PendingIntent.FLAG_UPDATE_CURRENT;
            if (Build.VERSION.SDK_INT >= 31) flags |= PendingIntent.FLAG_MUTABLE;
            PendingIntent pi = PendingIntent.getBroadcast(ctx, id, cb, flags);
            session.commit(pi.getIntentSender());
        }
    }
}
