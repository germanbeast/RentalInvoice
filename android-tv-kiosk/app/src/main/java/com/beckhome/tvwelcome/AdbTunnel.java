package com.beckhome.tvwelcome;

import org.json.JSONObject;

import java.io.InputStream;
import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.net.Socket;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.TimeUnit;

import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.Response;
import okhttp3.WebSocket;
import okhttp3.WebSocketListener;
import okio.ByteString;

/**
 * Fernwartung (Einstellungen → TV-Box im Admin): Die Box baut von sich aus eine WebSocket-Verbindung zum
 * Server auf (/api/tv-box/adb-tunnel, mit dem eigenen Schlüssel) und leitet sie an die eigene
 * ADB-Schnittstelle auf 127.0.0.1:5555 weiter. So erreicht ws-scrcpy auf dem Server die Box, obwohl sie
 * hinter der FRITZ!Box steht. Nur aktiv, solange die Fernwartung im Admin eingeschaltet ist.
 * Protokoll: siehe tv-remote.js auf dem Server.
 */
final class AdbTunnel {

    private static final int ADB_PORT = 5555;
    private static final OkHttpClient CLIENT = new OkHttpClient.Builder()
            .pingInterval(20, TimeUnit.SECONDS)
            .readTimeout(0, TimeUnit.MILLISECONDS)
            .connectTimeout(15, TimeUnit.SECONDS)
            .build();

    private static volatile WebSocket ws;
    private static volatile boolean wanted;
    private static volatile long connectingSince;
    private static final Map<Integer, Socket> conns = new ConcurrentHashMap<>();

    private AdbTunnel() {
    }

    /** Lauscht adbd auf der Box auf Port 5555 (vom PC mit "adb tcpip 5555" eingeschaltet)? */
    static boolean adbLocal() {
        Socket s = new Socket();
        try {
            s.connect(new InetSocketAddress("127.0.0.1", ADB_PORT), 400);
            return true;
        } catch (Exception e) {
            return false;
        } finally {
            try {
                s.close();
            } catch (Exception ignored) {
            }
        }
    }

    /** Nach jedem Abgleich mit dem Server: Tunnel öffnen oder schließen. */
    static synchronized void ensure(String server, String token, boolean on) {
        wanted = on;
        if (!on) {
            WebSocket w = ws;
            ws = null;
            if (w != null) w.close(1000, "aus");
            closeAll();
            return;
        }
        if (ws != null) return;
        if (System.currentTimeMillis() - connectingSince < 30000) return;
        connectingSince = System.currentTimeMillis();
        Request req = new Request.Builder()
                .url(server + "/api/tv-box/adb-tunnel")
                .header("x-tvbox-auth", token)
                .build();
        ws = CLIENT.newWebSocket(req, new Listener());
    }

    private static void closeAll() {
        for (Socket s : conns.values()) {
            try {
                s.close();
            } catch (Exception ignored) {
            }
        }
        conns.clear();
    }

    private static void sendJson(WebSocket w, String type, int id, String msg) {
        try {
            JSONObject o = new JSONObject();
            o.put("t", type);
            if (id > 0) o.put("id", id);
            if (msg != null) o.put("msg", msg);
            w.send(o.toString());
        } catch (Exception ignored) {
        }
    }

    private static final class Listener extends WebSocketListener {
        @Override
        public void onOpen(WebSocket w, Response response) {
            connectingSince = 0;
            try {
                JSONObject o = new JSONObject();
                o.put("t", "hello");
                o.put("adbLocal", adbLocal());
                w.send(o.toString());
            } catch (Exception ignored) {
            }
        }

        @Override
        public void onMessage(final WebSocket w, String text) {
            try {
                JSONObject m = new JSONObject(text);
                final int id = m.optInt("id", 0);
                String t = m.optString("t", "");
                if ("open".equals(t) && id > 0) {
                    new Thread(new Runnable() {
                        @Override
                        public void run() {
                            pump(w, id);
                        }
                    }, "adb-tunnel-" + id).start();
                } else if ("close".equals(t)) {
                    Socket s = conns.remove(id);
                    if (s != null) s.close();
                }
            } catch (Exception ignored) {
            }
        }

        @Override
        public void onMessage(WebSocket w, ByteString bytes) {
            if (bytes.size() < 4) return;
            byte[] b = bytes.toByteArray();
            int id = ((b[0] & 0xff) << 24) | ((b[1] & 0xff) << 16) | ((b[2] & 0xff) << 8) | (b[3] & 0xff);
            Socket s = conns.get(id);
            if (s == null) return;
            try {
                OutputStream out = s.getOutputStream();
                synchronized (s) {
                    out.write(b, 4, b.length - 4);
                    out.flush();
                }
            } catch (Exception e) {
                conns.remove(id);
                try {
                    s.close();
                } catch (Exception ignored) {
                }
                sendJson(w, "close", id, null);
            }
        }

        @Override
        public void onClosing(WebSocket w, int code, String reason) {
            w.close(1000, null);
        }

        @Override
        public void onClosed(WebSocket w, int code, String reason) {
            gone(w);
        }

        @Override
        public void onFailure(WebSocket w, Throwable t, Response response) {
            gone(w);
        }

        private void gone(WebSocket w) {
            synchronized (AdbTunnel.class) {
                if (ws == w) ws = null;
            }
            connectingSince = 0;
            closeAll();
            // Neuer Versuch spätestens beim nächsten Abgleich (jede Minute), solange die Fernwartung an ist
        }
    }

    /** Eine TCP-Verbindung zu adbd: Daten der Box zum Server schicken, bis eine Seite schließt. */
    private static void pump(WebSocket w, int id) {
        Socket s = new Socket();
        try {
            s.connect(new InetSocketAddress("127.0.0.1", ADB_PORT), 3000);
            s.setTcpNoDelay(true);
            conns.put(id, s);
            sendJson(w, "opened", id, null);
            InputStream in = s.getInputStream();
            byte[] buf = new byte[16384 + 4];
            buf[0] = (byte) (id >>> 24);
            buf[1] = (byte) (id >>> 16);
            buf[2] = (byte) (id >>> 8);
            buf[3] = (byte) id;
            int n;
            while ((n = in.read(buf, 4, buf.length - 4)) > 0) {
                // Video-Daten: nicht schneller senden, als die Leitung hergibt (OkHttp puffert sonst bis 16 MB und bricht ab)
                while (w.queueSize() > 1024 * 1024 && conns.containsKey(id) && wanted) Thread.sleep(20);
                if (!w.send(ByteString.of(buf, 0, n + 4))) break;
            }
        } catch (Exception e) {
            if (!conns.containsKey(id)) sendJson(w, "error", id, String.valueOf(e.getMessage()));
        } finally {
            try {
                s.close();
            } catch (Exception ignored) {
            }
            if (conns.remove(id) != null) sendJson(w, "close", id, null);
        }
    }
}
