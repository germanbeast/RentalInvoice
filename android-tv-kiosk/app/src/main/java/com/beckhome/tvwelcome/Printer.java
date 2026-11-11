package com.beckhome.tvwelcome;

import android.content.Context;
import android.net.nsd.NsdManager;
import android.net.nsd.NsdServiceInfo;
import android.os.Build;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.DataOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.InetSocketAddress;
import java.net.Socket;
import java.net.URL;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;

/**
 * Druckt neue Buchungen im Hintergrund auf dem Drucker im WLAN der Wohnung.
 * Der Server kann den Drucker nicht erreichen; er gibt offene Druckaufträge bei der minütlichen
 * Meldung (/api/tv-box/sync, Feld "print") mit. Die Box lädt das Buchungsblatt als PDF und schickt
 * es per IPP (Port 631, wie AirPrint) oder direkt an Port 9100 an den Drucker. Auf dem Fernseher
 * ist davon nichts zu sehen.
 *
 * Außerdem sucht sie alle 30 Minuten per mDNS nach Druckern (_ipp._tcp), damit der Gastgeber die
 * IP im Admin nur noch antippen muss.
 */
final class Printer {

    private static volatile boolean running = false;
    /** Letzter Druckfehler für den Admin, leer = ok. */
    static volatile String lastError = "";

    private static final List<JSONObject> found = new ArrayList<>();
    private static volatile long lastDiscovery = 0;
    private static volatile boolean discovering = false;
    private static final long DISCOVER_EVERY_MS = 30 * 60 * 1000L;

    private Printer() {
    }

    // ---------------------------------------------------------------------------------------------
    // Druckaufträge
    // ---------------------------------------------------------------------------------------------

    static void runAsync(final JSONObject print, final String server, final String auth) {
        if (running) return;
        running = true;
        new Thread(new Runnable() {
            @Override
            public void run() {
                try {
                    runJobs(print, server, auth);
                } catch (Exception ignored) {
                } finally {
                    running = false;
                }
            }
        }, "print-jobs").start();
    }

    private static void runJobs(JSONObject print, String server, String auth) {
        JSONObject printer = print.optJSONObject("printer");
        JSONArray jobs = print.optJSONArray("jobs");
        if (printer == null || jobs == null) return;
        String host = printer.optString("host", "").trim();
        if (host.isEmpty()) return;
        int port = printer.optInt("port", 631);
        String path = printer.optString("path", "ipp/print").replaceAll("^/+", "");
        String mode = printer.optString("mode", "auto");
        int copies = Math.max(1, Math.min(5, printer.optInt("copies", 1)));

        for (int i = 0; i < jobs.length(); i++) {
            JSONObject job = jobs.optJSONObject(i);
            if (job == null) continue;
            long id = job.optLong("id", 0);
            String title = job.optString("title", "Buchung");
            String via = "";
            String error = null;
            try {
                byte[] pdf = download(server + "/api/tv-box/print/" + id + "/pdf", auth);
                if ("raw".equals(mode)) {
                    printRaw(host, port == 631 ? 9100 : port, pdf, copies);
                    via = "raw";
                } else {
                    try {
                        printIpp(host, port, path, title, pdf, copies);
                        via = "ipp";
                    } catch (NoIpp e) {
                        // Drucker spricht kein IPP (Port zu, Pfad unbekannt): direkt an Port 9100
                        if (!"auto".equals(mode)) throw new Exception(e.getMessage());
                        try {
                            printRaw(host, 9100, pdf, copies);
                            via = "raw";
                        } catch (Exception re) {
                            throw new Exception(e.getMessage() + " / Port 9100: " + msg(re));
                        }
                    }
                }
            } catch (Exception e) {
                error = msg(e);
            }
            lastError = error == null ? "" : error;
            report(server, auth, id, error == null, error, via);
        }
    }

    private static String msg(Exception e) {
        return e.getMessage() != null ? e.getMessage() : e.getClass().getSimpleName();
    }

    /** IPP ist nicht erreichbar oder unbekannt: im Modus "auto" auf Port 9100 ausweichen. */
    private static final class NoIpp extends Exception {
        NoIpp(String m) {
            super(m);
        }
    }

    private static byte[] download(String url, String auth) throws Exception {
        HttpURLConnection c = (HttpURLConnection) new URL(url).openConnection();
        c.setConnectTimeout(20000);
        c.setReadTimeout(60000); // der Server erzeugt das PDF erst jetzt
        c.setRequestProperty("X-Tvbox-Auth", auth);
        try {
            int code = c.getResponseCode();
            if (code != 200) throw new Exception("Buchungsblatt nicht geladen (HTTP " + code + ")");
            try (InputStream in = c.getInputStream()) {
                return readAll(in, 20 * 1024 * 1024);
            }
        } finally {
            c.disconnect();
        }
    }

    private static void report(String server, String auth, long id, boolean ok, String error, String via) {
        try {
            JSONObject b = new JSONObject();
            b.put("ok", ok);
            if (error != null) b.put("error", error);
            b.put("via", via);
            HttpURLConnection c = (HttpURLConnection) new URL(server + "/api/tv-box/print/" + id + "/result").openConnection();
            c.setConnectTimeout(15000);
            c.setReadTimeout(15000);
            c.setRequestMethod("POST");
            c.setDoOutput(true);
            c.setRequestProperty("Content-Type", "application/json; charset=utf-8");
            c.setRequestProperty("X-Tvbox-Auth", auth);
            try (OutputStream os = c.getOutputStream()) {
                os.write(b.toString().getBytes("UTF-8"));
            }
            c.getResponseCode();
            c.disconnect();
        } catch (Exception ignored) {
            // Server meldet den Auftrag nach 10 Minuten ohnehin erneut
        }
    }

    /** Direkt an den Drucker (Port 9100, "RAW"/JetDirect). Utax/Kyocera erkennen PDF selbst. */
    private static void printRaw(String host, int port, byte[] pdf, int copies) throws Exception {
        for (int i = 0; i < copies; i++) {
            Socket s = new Socket();
            try {
                s.connect(new InetSocketAddress(host, port), 8000);
                s.setSoTimeout(30000);
                OutputStream os = s.getOutputStream();
                os.write(pdf);
                os.flush();
                s.shutdownOutput();
                try {
                    // kurz warten, bis der Drucker die Daten übernommen hat
                    s.getInputStream().read(new byte[64]);
                } catch (IOException ignored) {
                }
            } finally {
                try {
                    s.close();
                } catch (IOException ignored) {
                }
            }
        }
    }

    /** IPP 1.1 Print-Job (application/pdf). */
    private static void printIpp(String host, int port, String path, String title, byte[] pdf, int copies) throws Exception {
        String hostPart = host.contains(":") && !host.startsWith("[") ? "[" + host + "]" : host;
        String uri = "ipp://" + hostPart + ":" + port + "/" + path;

        ByteArrayOutputStream bo = new ByteArrayOutputStream();
        DataOutputStream d = new DataOutputStream(bo);
        d.writeShort(0x0101);      // Version 1.1
        d.writeShort(0x0002);      // Print-Job
        d.writeInt(1);             // request-id
        d.writeByte(0x01);         // operation-attributes-tag
        attr(d, 0x47, "attributes-charset", "utf-8");
        attr(d, 0x48, "attributes-natural-language", "de");
        attr(d, 0x45, "printer-uri", uri);
        attr(d, 0x42, "requesting-user-name", "Beckhome");
        attr(d, 0x42, "job-name", title.length() > 60 ? title.substring(0, 60) : title);
        attr(d, 0x49, "document-format", "application/pdf");
        if (copies > 1) {
            d.writeByte(0x02);     // job-attributes-tag
            d.writeByte(0x21);     // integer
            byte[] n = "copies".getBytes("UTF-8");
            d.writeShort(n.length);
            d.write(n);
            d.writeShort(4);
            d.writeInt(copies);
        }
        d.writeByte(0x03);         // end-of-attributes
        d.write(pdf);
        d.flush();
        byte[] body = bo.toByteArray();

        HttpURLConnection c;
        try {
            c = (HttpURLConnection) new URL("http://" + hostPart + ":" + port + "/" + path).openConnection();
        } catch (Exception e) {
            throw new NoIpp("IPP-Adresse ungültig: " + msg(e));
        }
        c.setConnectTimeout(8000);
        c.setReadTimeout(60000);
        c.setRequestMethod("POST");
        c.setDoOutput(true);
        c.setFixedLengthStreamingMode(body.length);
        c.setRequestProperty("Content-Type", "application/ipp");
        try {
            try (OutputStream os = c.getOutputStream()) {
                os.write(body);
            } catch (IOException e) {
                throw new NoIpp("Drucker nicht erreichbar (IPP): " + msg(e));
            }
            int code;
            try {
                code = c.getResponseCode();
            } catch (IOException e) {
                throw new NoIpp("Keine IPP-Antwort: " + msg(e));
            }
            if (code != 200) throw new NoIpp("IPP: HTTP " + code + " (Pfad /" + path + ")");
            byte[] res;
            try (InputStream in = c.getInputStream()) {
                res = readAll(in, 64 * 1024);
            }
            if (res.length < 4) throw new NoIpp("IPP: leere Antwort");
            int status = ((res[2] & 0xff) << 8) | (res[3] & 0xff);
            if (status > 0x00ff) {
                throw new Exception("Drucker lehnt ab (IPP-Status 0x" + Integer.toHexString(status) + ")");
            }
        } finally {
            c.disconnect();
        }
    }

    private static void attr(DataOutputStream d, int tag, String name, String value) throws IOException {
        byte[] n = name.getBytes("UTF-8");
        byte[] v = value.getBytes("UTF-8");
        d.writeByte(tag);
        d.writeShort(n.length);
        d.write(n);
        d.writeShort(v.length);
        d.write(v);
    }

    private static byte[] readAll(InputStream in, int max) throws IOException {
        ByteArrayOutputStream bo = new ByteArrayOutputStream();
        byte[] buf = new byte[8192];
        int n;
        while ((n = in.read(buf)) > 0) {
            bo.write(buf, 0, n);
            if (bo.size() > max) throw new IOException("Antwort zu groß");
        }
        return bo.toByteArray();
    }

    // ---------------------------------------------------------------------------------------------
    // Drucker im WLAN finden (mDNS / Bonjour, wie AirPrint)
    // ---------------------------------------------------------------------------------------------

    static JSONArray foundJson() {
        JSONArray a = new JSONArray();
        synchronized (found) {
            for (JSONObject o : found) a.put(o);
        }
        return a;
    }

    static void discoverIfDue(Context ctx) {
        long now = System.currentTimeMillis();
        if (discovering || now - lastDiscovery < DISCOVER_EVERY_MS) return;
        lastDiscovery = now;
        discovering = true;
        try {
            discover(ctx.getApplicationContext());
        } catch (Exception e) {
            discovering = false;
        }
    }

    private static void discover(Context ctx) {
        final NsdManager nsd = (NsdManager) ctx.getSystemService(Context.NSD_SERVICE);
        if (nsd == null) {
            discovering = false;
            return;
        }
        final List<NsdServiceInfo> seen = new ArrayList<>();
        final NsdManager.DiscoveryListener listener = new NsdManager.DiscoveryListener() {
            @Override
            public void onStartDiscoveryFailed(String serviceType, int errorCode) {
                discovering = false;
            }

            @Override
            public void onStopDiscoveryFailed(String serviceType, int errorCode) {
            }

            @Override
            public void onDiscoveryStarted(String serviceType) {
            }

            @Override
            public void onDiscoveryStopped(String serviceType) {
            }

            @Override
            public void onServiceFound(NsdServiceInfo info) {
                synchronized (seen) {
                    if (seen.size() < 10) seen.add(info);
                }
            }

            @Override
            public void onServiceLost(NsdServiceInfo info) {
            }
        };
        nsd.discoverServices("_ipp._tcp", NsdManager.PROTOCOL_DNS_SD, listener);
        new Thread(new Runnable() {
            @Override
            public void run() {
                try {
                    Thread.sleep(8000);
                } catch (InterruptedException ignored) {
                }
                try {
                    nsd.stopServiceDiscovery(listener);
                } catch (Exception ignored) {
                }
                List<NsdServiceInfo> list;
                synchronized (seen) {
                    list = new ArrayList<>(seen);
                }
                List<JSONObject> result = new ArrayList<>();
                for (NsdServiceInfo info : list) {
                    JSONObject o = resolve(nsd, info);
                    if (o != null) result.add(o);
                }
                synchronized (found) {
                    found.clear();
                    found.addAll(result);
                }
                discovering = false;
            }
        }, "printer-discovery").start();
    }

    /** Einen Dienst auflösen (nacheinander, NsdManager kann nur einen zugleich). */
    private static JSONObject resolve(NsdManager nsd, NsdServiceInfo info) {
        final Object lock = new Object();
        final NsdServiceInfo[] out = new NsdServiceInfo[1];
        final boolean[] done = new boolean[1];
        try {
            nsd.resolveService(info, new NsdManager.ResolveListener() {
                @Override
                public void onResolveFailed(NsdServiceInfo serviceInfo, int errorCode) {
                    synchronized (lock) {
                        done[0] = true;
                        lock.notifyAll();
                    }
                }

                @Override
                public void onServiceResolved(NsdServiceInfo serviceInfo) {
                    synchronized (lock) {
                        out[0] = serviceInfo;
                        done[0] = true;
                        lock.notifyAll();
                    }
                }
            });
            synchronized (lock) {
                if (!done[0]) lock.wait(5000);
            }
            NsdServiceInfo r = out[0];
            if (r == null || r.getHost() == null) return null;
            JSONObject o = new JSONObject();
            o.put("name", r.getServiceName());
            o.put("host", r.getHost().getHostAddress());
            o.put("port", r.getPort());
            String rp = "ipp/print";
            if (Build.VERSION.SDK_INT >= 21) {
                Map<String, byte[]> attrs = r.getAttributes();
                if (attrs != null && attrs.get("rp") != null) rp = new String(attrs.get("rp"), "UTF-8");
            }
            o.put("path", rp);
            return o;
        } catch (Exception e) {
            return null;
        }
    }
}
