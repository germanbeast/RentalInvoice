package com.beckhome.tvwelcome;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.app.admin.DevicePolicyManager;
import android.content.ComponentName;
import android.content.Intent;
import android.content.IntentFilter;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.content.pm.ResolveInfo;
import android.net.wifi.WifiManager;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.view.KeyEvent;
import android.view.MotionEvent;
import android.view.View;
import android.view.WindowManager;
import android.net.http.SslError;
import android.webkit.SslErrorHandler;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

public class MainActivity extends Activity {

    /** Öffentliche Adresse der Gäste-Webseite; welcome.html + /api/welcome laufen dort ohne Login. */
    static final String DEFAULT_SERVER_URL = "https://beckhome.cloud";
    /** Einstellungen, die das Einrichtungs-Skript per adb mitgeben kann (am start ... --es server_url ...). */
    private static final String[] PREF_KEYS = {
            "server_url", "guest_name", "wifi_name", "wifi_password", "checkin_time", "checkout_time", "contact_phone",
            "admin_pin"
    };
    /** Stichwörter, über die eine App gefunden wird, wenn der Paketname auf der Box anders lautet. */
    private static final String[] APP_KEYWORDS = {"waipu", "netflix", "youtube", "amazon", "disney", "zdf", "ard"};
    /** Externe Seite (z.B. urlaub.saarland): nach so langer Ruhe zurück zum Welcome-Screen. */
    private static final long IDLE_RETURN_MS = 10 * 60 * 1000;
    private static final long BACK_HOLD_MS = 10 * 1000;
    /** Extra beim Start nach Aus/Ein: Welcome-Seite neu laden. */
    static final String EXTRA_RESET = "reset_home";
    /** Welcome-Screen ist gerade sichtbar (für die Inaktivitäts-Prüfung im WatchService). */
    static volatile boolean inFront = false;
    private static final long RETRY_MS = 20000;
    /** Apps, die die Knöpfe auf dem Welcome-Screen starten dürfen (auch im Kiosk-Modus). */
    private static final String[] ALLOWED_APPS = {
            "de.exaring.waiputv", "com.netflix.mediaclient", "com.netflix.ninja",
            "com.google.android.youtube.tv", "com.google.android.youtube",
            "com.amazon.avod.thirdpartyclient", "com.amazon.amazonvideo.livingroom",
            "com.disney.disneyplus", "com.zdf.android.mediathek", "de.swr.ard.avp.mobile.android.amazon"
    };

    private WebView webView;
    private final Handler retryHandler = new Handler();
    private final Runnable retryRunnable = new Runnable() {
        @Override
        public void run() {
            retryWhenServerBack();
        }
    };
    private SharedPreferences prefs;
    private boolean backLongPressFired = false;
    private final Runnable backLongPress = new Runnable() {
        @Override
        public void run() {
            backLongPressFired = true;
            openSettings();
        }
    };
    private WifiManager.WifiLock wifiLock;
    private final Runnable idleReturn = new Runnable() {
        @Override
        public void run() {
            if (!isOnWelcomePage()) loadWelcomePage();
        }
    };

    // Settings tap gesture
    private int tapCount = 0;
    private Handler tapHandler = new Handler();
    private Runnable tapResetRunnable = new Runnable() {
        @Override
        public void run() {
            tapCount = 0;
        }
    };

    @SuppressLint("SetJavaScriptEnabled")
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        // Load preferences
        prefs = getSharedPreferences("WelcomeSettings", MODE_PRIVATE);
        applySettingsFromIntent(getIntent());
        keepWifiAwake();
        WatchService.start(this);

        // Kiosk beenden, falls per adb angefordert (siehe INSTALL.md)
        if (getIntent().getBooleanExtra("exit_kiosk", false)) {
            exitKioskMode();
        }

        // Enable fullscreen kiosk mode
        enableKioskMode();

        // Create WebView
        webView = new WebView(this);
        setContentView(webView);

        // Configure WebView
        WebSettings webSettings = webView.getSettings();
        webSettings.setJavaScriptEnabled(true);
        webSettings.setDomStorageEnabled(true);
        webSettings.setLoadWithOverviewMode(true);
        webSettings.setUseWideViewPort(true);
        webSettings.setBuiltInZoomControls(false);
        webSettings.setDisplayZoomControls(false);
        webSettings.setCacheMode(WebSettings.LOAD_DEFAULT);

        // Set WebView client
        webView.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, String url) {
                // Knöpfe für Waipu, Netflix … (intent://…;package=…;end)
                if (url.startsWith("intent://")) {
                    launchApp(url);
                    return true;
                }
                // Knöpfe auf dem Kopplungs- und Offline-Bildschirm
                if (url.startsWith("beckhome://")) {
                    handleLocalButton(url.substring("beckhome://".length()));
                    return true;
                }
                return false;
            }

            @Override
            public void onReceivedHttpError(WebView view, WebResourceRequest request,
                                            android.webkit.WebResourceResponse response) {
                // Server kennt die Box nicht (mehr): gleich nachfragen, dann zeigt sie den Kopplungs-Code
                if (request.isForMainFrame() && response.getStatusCode() == 403) {
                    RemoteControl.syncAsync(MainActivity.this, true);
                    pageFailed = true;
                    showOfflineAndRetry("HTTP 403"); // gleich danach zeigt die Box ggf. den Kopplungs-Code
                }
                // Server/Tunnel gestört (z.B. 502 von Cloudflare): Offline-Welcome statt Fehlerseite
                if (request.isForMainFrame() && response.getStatusCode() >= 500) {
                    pageFailed = true;
                    showOfflineAndRetry("HTTP " + response.getStatusCode());
                }
            }

            @Override
            public void onPageStarted(WebView view, String url, android.graphics.Bitmap favicon) {
                if (url != null && !url.startsWith("data:") && !url.startsWith("about:")) pageFailed = false;
            }

            @Override
            public void onPageFinished(WebView view, String url) {
                if (url != null && url.contains("/welcome.html") && !pageFailed) welcomeLoaded = true;
                retryHandler.removeCallbacks(idleReturn);
                if (!isOnWelcomePage()) retryHandler.postDelayed(idleReturn, IDLE_RETURN_MS);
            }

            // Kein Internet (z.B. Box startet schneller als das WLAN): Hinweis zeigen und neu versuchen
            @Override
            public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M && request.isForMainFrame()) {
                    pageFailed = true;
                    showOfflineAndRetry(error.getDescription() + " (" + error.getErrorCode() + ")");
                }
            }

            @SuppressWarnings("deprecation")
            @Override
            public void onReceivedError(WebView view, int errorCode, String description, String failingUrl) {
                if (Build.VERSION.SDK_INT < Build.VERSION_CODES.M) {
                    pageFailed = true;
                    showOfflineAndRetry(description + " (" + errorCode + ")");
                }
            }

            // Zertifikatsfehler (z.B. falsche Uhrzeit auf der Box): nicht laden, aber Grund anzeigen
            @Override
            public void onReceivedSslError(WebView view, SslErrorHandler handler, SslError error) {
                handler.cancel();
                pageFailed = true;
                showOfflineAndRetry("Zertifikat ungültig (" + error.getPrimaryError()
                        + "), Datum/Uhrzeit der Box prüfen");
            }
        });

        // Add touch listener for settings gesture (5x tap)
        webView.setOnTouchListener(new View.OnTouchListener() {
            @Override
            public boolean onTouch(View v, MotionEvent event) {
                if (event.getAction() == MotionEvent.ACTION_DOWN) {
                    // Check if tap is in top-left corner (logo area) - larger area for easier access
                    if (event.getX() < 500 && event.getY() < 500) {
                        handleSettingsTap();
                    }
                }
                return false;
            }
        });

        // Load welcome page
        loadWelcomePage();
    }

    private void launchApp(String url) {
        String pkg = null;
        Intent parsed = null;
        try {
            parsed = Intent.parseUri(url, Intent.URI_INTENT_SCHEME);
            pkg = parsed.getPackage();
        } catch (Exception ignored) {
        }
        Intent launch = launchIntentFor(pkg);
        if (launch == null && pkg != null) {
            // Paketname weicht ab (z.B. andere Waipu-Variante für TV): per Stichwort suchen
            for (String kw : APP_KEYWORDS) {
                if (pkg.toLowerCase().contains(kw)) {
                    launch = launchIntentFor(findPackageByKeyword(kw));
                    break;
                }
            }
        }
        try {
            if (launch != null) {
                launch.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                allowInLockTask(launch.getComponent() != null ? launch.getComponent().getPackageName() : null);
                startActivity(launch);
                return;
            }
            if (parsed != null) {
                startActivity(parsed);
                return;
            }
        } catch (Exception ignored) {
        }
        android.widget.Toast.makeText(this, "Diese App ist auf dem Fernseher nicht installiert.",
                android.widget.Toast.LENGTH_LONG).show();
    }

    private Intent launchIntentFor(String pkg) {
        if (pkg == null) return null;
        PackageManager pm = getPackageManager();
        Intent launch = null;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP) {
            launch = pm.getLeanbackLaunchIntentForPackage(pkg);
        }
        if (launch == null) launch = pm.getLaunchIntentForPackage(pkg);
        return launch;
    }

    /** Sucht unter allen startbaren Apps eine, deren Paketname oder Name das Stichwort enthält. */
    private String findPackageByKeyword(String keyword) {
        PackageManager pm = getPackageManager();
        String[] categories = {"android.intent.category.LEANBACK_LAUNCHER", Intent.CATEGORY_LAUNCHER};
        for (String cat : categories) {
            Intent q = new Intent(Intent.ACTION_MAIN);
            q.addCategory(cat);
            for (ResolveInfo ri : pm.queryIntentActivities(q, 0)) {
                String p = ri.activityInfo.packageName;
                if (p.equals(getPackageName())) continue;
                CharSequence label = ri.loadLabel(pm);
                if (p.toLowerCase().contains(keyword)
                        || (label != null && label.toString().toLowerCase().contains(keyword))) {
                    return p;
                }
            }
        }
        return null;
    }

    /** Im Kiosk-Modus muss jede gestartete App auf der Erlaubt-Liste stehen. */
    private void allowInLockTask(String pkg) {
        DevicePolicyManager dpm = (DevicePolicyManager) getSystemService(DEVICE_POLICY_SERVICE);
        if (pkg == null || dpm == null || !dpm.isDeviceOwnerApp(getPackageName())) return;
        try {
            ComponentName admin = new ComponentName(this, AdminReceiver.class);
            java.util.LinkedHashSet<String> set = new java.util.LinkedHashSet<>(
                    java.util.Arrays.asList(dpm.getLockTaskPackages(admin)));
            if (set.add(pkg)) dpm.setLockTaskPackages(admin, set.toArray(new String[0]));
        } catch (Exception ignored) {
        }
    }

    /** WLAN soll auch im Dauerbetrieb nicht schlafen gehen. */
    private void keepWifiAwake() {
        try {
            WifiManager wm = (WifiManager) getApplicationContext().getSystemService(WIFI_SERVICE);
            if (wm == null) return;
            int mode = Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q
                    ? WifiManager.WIFI_MODE_FULL_LOW_LATENCY : WifiManager.WIFI_MODE_FULL_HIGH_PERF;
            wifiLock = wm.createWifiLock(mode, "beckhome-welcome");
            wifiLock.setReferenceCounted(false);
            wifiLock.acquire();
        } catch (Exception ignored) {
        }
    }

    private String serverUrl() {
        String serverUrl = prefs.getString("server_url", DEFAULT_SERVER_URL).trim().replaceAll("/+$", "");
        if (serverUrl.isEmpty()) serverUrl = DEFAULT_SERVER_URL;
        if (!serverUrl.contains("://")) serverUrl = "https://" + serverUrl;
        if (serverUrl.endsWith("/welcome.html")) serverUrl = serverUrl.substring(0, serverUrl.length() - "/welcome.html".length());
        return serverUrl;
    }

    private boolean isOnWelcomePage() {
        String u = webView == null ? null : webView.getUrl();
        return u == null || u.contains("/welcome.html") || u.startsWith("about:") || u.startsWith("data:");
    }

    /** Übernimmt per adb mitgegebene Einstellungen dauerhaft. */
    private void applySettingsFromIntent(Intent intent) {
        if (intent == null) return;
        SharedPreferences.Editor editor = prefs.edit();
        boolean changed = false;
        for (String key : PREF_KEYS) {
            String value = intent.getStringExtra(key);
            if (value != null) {
                if (key.equals("server_url")) value = value.trim().replaceAll("/+$", "");
                editor.putString(key, value);
                changed = true;
            }
        }
        if (changed) editor.apply();
    }

    /** Echte Welcome-Seite ist geladen (für „offline: einfach stehen lassen“). */
    private boolean welcomeLoaded = false;
    private boolean pageFailed = false;
    private volatile boolean checkingServer = false;

    private boolean isOnRealWelcome() {
        String u = webView == null ? null : webView.getUrl();
        return welcomeLoaded && u != null && u.contains("/welcome.html");
    }

    /**
     * Internet/Server weg: keine Fehlermeldung, sondern ein Welcome-Screen aus der App mit den zuletzt
     * bekannten Daten (Name, Zeiten, Kontakt), Uhr und dem Fernseh-Knopf. Im Hintergrund wird alle
     * 20 Sekunden geprüft, ob der Server wieder da ist, dann lädt die echte Seite.
     */
    private void showOfflineAndRetry(String detail) {
        android.util.Log.w("Welcome", "offline: " + detail);
        retryHandler.removeCallbacks(retryRunnable);
        welcomeLoaded = false;
        webView.loadDataWithBaseURL(null, offlineWelcomeHtml(), "text/html", "UTF-8", null);
        retryHandler.postDelayed(retryRunnable, RETRY_MS);
    }

    private String offlineWelcomeHtml() {
        String name = "", title = "", phone = "", cin = "", cout = "";
        try {
            org.json.JSONObject w = new org.json.JSONObject(prefs.getString("welcome_json", "{}"));
            title = w.optString("title", "");
            phone = w.optString("phone", "");
            cin = w.optString("checkinTime", "");
            cout = w.optString("checkoutTime", "");
            org.json.JSONObject g = w.optJSONObject("guest");
            String today = new java.text.SimpleDateFormat("yyyy-MM-dd", java.util.Locale.ROOT).format(new java.util.Date());
            if (g != null && today.compareTo(g.optString("checkout", "")) <= 0) name = g.optString("name", "");
        } catch (Exception ignored) {
        }
        StringBuilder facts = new StringBuilder();
        if (!phone.isEmpty()) facts.append("<div class='f'><span>Kontakt</span><b>").append(h(phone)).append("</b></div>");
        if (!cin.isEmpty()) facts.append("<div class='f'><span>Check-in</span><b>").append(h(cin)).append("</b></div>");
        if (!cout.isEmpty()) facts.append("<div class='f'><span>Check-out</span><b>").append(h(cout)).append("</b></div>");
        return "<html><head><meta charset='utf-8'><style>"
                + "body{margin:0;height:100vh;overflow:hidden;color:#f5f0e8;font-family:sans-serif;"
                + "background:radial-gradient(110% 90% at 15% 0%,#4a3d31 0%,#1f1c18 62%)}"
                + ".w{box-sizing:border-box;height:100vh;padding:5vh 5vw;display:flex;flex-direction:column}"
                + ".top{display:flex;justify-content:space-between;align-items:flex-start}"
                + ".brand{font:italic 2.3rem/1 Georgia,serif;color:rgba(245,240,232,.72)}"
                + ".time{font:4.4rem/1 Georgia,serif;text-align:right}.date{color:rgba(245,240,232,.52);font-size:1.2rem;margin-top:.4rem}"
                + ".main{flex:1;display:flex;flex-direction:column;justify-content:center}"
                + ".eye{letter-spacing:.18em;text-transform:uppercase;color:#c27a4f;font-size:1rem;margin-bottom:1rem}"
                + "h1{font:6.2rem/.98 Georgia,serif;margin:0 0 1.2rem}.msg{font-size:1.6rem;color:rgba(245,240,232,.72);margin:0}"
                + ".facts{display:flex;gap:3.5rem;margin-top:2.5rem}.f span{display:block;color:rgba(245,240,232,.52);font-size:.9rem;"
                + "letter-spacing:.12em;text-transform:uppercase;margin-bottom:.4rem}.f b{font-weight:400;font-size:1.6rem}"
                + ".apps{display:flex;gap:1.2rem;align-items:center;border-top:1px solid rgba(245,240,232,.14);padding-top:1.6rem}"
                + ".apps div{color:rgba(245,240,232,.52);font-size:1rem;letter-spacing:.12em;text-transform:uppercase;margin-right:1rem}"
                + "a{display:inline-block;padding:1rem 2.2rem;border:1px solid rgba(245,240,232,.3);border-radius:4px;color:#f5f0e8;"
                + "text-decoration:none;font-size:1.35rem;background:#2b2621}a:focus{outline:none;background:#f5f0e8;color:#1f1c18}"
                + "</style></head><body><div class='w'>"
                + "<div class='top'><div class='brand'>" + h(title.isEmpty() ? "Ferienwohnung Beckhome" : title) + "</div>"
                + "<div><div class='time' id='t'></div><div class='date' id='d'></div></div></div>"
                + "<div class='main'><div class='eye'>Willkommen</div><h1>" + h(name.isEmpty() ? "Liebe Gäste" : name) + "</h1>"
                + "<p class='msg'>Wir wünschen Ihnen einen angenehmen Aufenthalt!</p>"
                + (facts.length() > 0 ? "<div class='facts'>" + facts + "</div>" : "") + "</div>"
                + "<div class='apps'><div>Für Ihren Aufenthalt</div>"
                + "<a id='tv' href='intent://de.exaring.waiputv#Intent;scheme=app;package=de.exaring.waiputv;end'>Fernsehen schauen</a></div>"
                + "</div><script>"
                + "function u(){var n=new Date();document.getElementById('t').textContent=n.toLocaleTimeString('de-DE',{hour:'2-digit',minute:'2-digit'});"
                + "document.getElementById('d').textContent=n.toLocaleDateString('de-DE',{weekday:'long',year:'numeric',month:'long',day:'numeric'});}"
                + "u();setInterval(u,15000);setTimeout(function(){document.getElementById('tv').focus();},200);"
                + "</script></body></html>";
    }

    private static String h(String v) {
        return android.text.TextUtils.htmlEncode(v);
    }

    /** Server wieder erreichbar? Erst dann die echte Seite laden (kein Flackern beim Warten). */
    private void retryWhenServerBack() {
        if (checkingServer) return;
        checkingServer = true;
        final String url = serverUrl() + "/api/health";
        new Thread(new Runnable() {
            @Override
            public void run() {
                boolean ok = false;
                try {
                    java.net.HttpURLConnection c = (java.net.HttpURLConnection) new java.net.URL(url).openConnection();
                    c.setConnectTimeout(8000);
                    c.setReadTimeout(8000);
                    ok = c.getResponseCode() == 200;
                    c.disconnect();
                } catch (Exception ignored) {
                }
                final boolean back = ok;
                checkingServer = false;
                retryHandler.post(new Runnable() {
                    @Override
                    public void run() {
                        if (back) loadWelcomePage();
                        else retryHandler.postDelayed(retryRunnable, RETRY_MS);
                    }
                });
            }
        }, "server-check").start();
    }

    private void handleSettingsTap() {
        tapCount++;

        // Reset counter after 2 seconds
        tapHandler.removeCallbacks(tapResetRunnable);
        tapHandler.postDelayed(tapResetRunnable, 2000);

        // Open settings after 5 taps
        if (tapCount >= 5) {
            tapCount = 0;
            openSettings();
        }
    }

    private void openSettings() {
        Intent intent = new Intent(this, SettingsActivity.class);
        startActivity(intent);
    }

    private String lastPairingHtml = null;
    private final Runnable pairingPoll = new Runnable() {
        @Override
        public void run() {
            RemoteControl.syncAsync(MainActivity.this, true);
            if (!RemoteControl.mayShowWelcome(prefs)) {
                showPairingScreen(); // Code / Verbindungsstatus aktualisieren
            }
        }
    };

    /** Netzwerk-Knöpfe: ohne Kopplung frei (Ersteinrichtung), danach nur mit PIN. */
    private void handleLocalButton(String what) {
        if ("pin".equals(what) || RemoteControl.isPaired(prefs)) {
            openSettings(); // PIN-Abfrage, dort gibt es WLAN und Android-Einstellungen
            return;
        }
        String action = "wifi".equals(what) ? android.provider.Settings.ACTION_WIFI_SETTINGS
                : android.provider.Settings.ACTION_SETTINGS;
        releaseLockOnly();
        try {
            Intent i = new Intent(action);
            i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            startActivity(i);
        } catch (Exception e) {
            try {
                Intent i = new Intent(android.provider.Settings.ACTION_SETTINGS);
                i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                startActivity(i);
            } catch (Exception ignored) {
            }
        }
    }

    private boolean networkConnected() {
        try {
            android.net.ConnectivityManager cm = (android.net.ConnectivityManager) getSystemService(CONNECTIVITY_SERVICE);
            android.net.NetworkInfo ni = cm != null ? cm.getActiveNetworkInfo() : null;
            return ni != null && ni.isConnected();
        } catch (Exception e) {
            return true;
        }
    }

    private static final String SCREEN_CSS = "<style>body{margin:0;background:#1f1c18;color:#f5f0e8;font-family:sans-serif;"
            + "display:flex;align-items:center;justify-content:center;height:100vh;text-align:center}"
            + "a{display:inline-block;margin:10px;padding:16px 30px;border:2px solid rgba(245,240,232,.4);border-radius:6px;"
            + "color:#f5f0e8;text-decoration:none;font-size:22px}a:focus{background:#f5f0e8;color:#1f1c18;outline:none}"
            + ".s{font-size:20px;opacity:.7;margin-top:18px}.m{font-size:15px;opacity:.45;margin-top:26px}</style>";

    private String networkButtons() {
        if (RemoteControl.isPaired(prefs)) {
            return "<div style='margin-top:34px'><a id='b1' href='beckhome://pin'>Netzwerk einrichten (PIN)</a></div>";
        }
        return "<div style='margin-top:34px'><a id='b1' href='beckhome://wifi'>WLAN einrichten</a>"
                + "<a href='beckhome://settings'>Netzwerk / LAN-Einstellungen</a></div>";
    }

    /** Erster Start oder Kopplung aufgehoben: Code zeigen, den der Gastgeber im Admin eingibt. */
    private void showPairingScreen() {
        retryHandler.removeCallbacks(retryRunnable);
        retryHandler.removeCallbacks(pairingPoll);
        String code = RemoteControl.pairCode(prefs);
        String status;
        if (!networkConnected()) {
            status = "Keine Netzwerkverbindung. Bitte WLAN einrichten oder ein LAN-Kabel einstecken.";
        } else if (RemoteControl.lastError != null) {
            status = "Server nicht erreichbar: " + RemoteControl.lastError;
        } else {
            status = "Verbunden. Wartet auf die Eingabe des Codes im Admin …";
        }
        String html = "<html><head><meta charset='utf-8'>" + SCREEN_CSS + "</head><body><div>"
                + "<div style='font-size:34px'>TV-Box koppeln</div>"
                + "<div class='s'>Im Admin unter Einstellungen → TV-Box diesen Code eingeben:</div>"
                + "<div style='font-size:96px;letter-spacing:14px;margin-top:22px;font-weight:bold'>"
                + code.substring(0, 3) + " " + code.substring(3) + "</div>"
                + "<div class='s'>" + android.text.TextUtils.htmlEncode(status) + "</div>"
                + networkButtons()
                + "<div class='m'>" + android.text.TextUtils.htmlEncode(serverUrl()) + "</div>"
                + "</div><script>var b=document.getElementById('b1');if(b)b.focus();</script></body></html>";
        if (!html.equals(lastPairingHtml)) { // nur bei Änderung neu zeichnen (Fokus bleibt stehen)
            lastPairingHtml = html;
            webView.loadDataWithBaseURL(null, html, "text/html", "UTF-8", null);
        }
        retryHandler.postDelayed(pairingPoll, 8000);
    }

    private void loadWelcomePage() {
        // Get settings from SharedPreferences
        retryHandler.removeCallbacks(retryRunnable);
        retryHandler.removeCallbacks(idleReturn);
        retryHandler.removeCallbacks(pairingPoll);
        if (!RemoteControl.mayShowWelcome(prefs)) {
            RemoteControl.syncAsync(this, true);
            showPairingScreen();
            return;
        }
        lastPairingHtml = null;
        if (!networkConnected()) {
            // Kein Netz: die geladene Seite einfach stehen lassen, sonst Offline-Welcome
            if (!isOnRealWelcome()) showOfflineAndRetry("kein Netzwerk");
            return;
        }
        String serverUrl = serverUrl();
        // Ausweis der gekoppelten Box: nur damit liefert der Server welcome.html und /api/welcome
        try {
            android.webkit.CookieManager cm = android.webkit.CookieManager.getInstance();
            cm.setAcceptCookie(true);
            cm.setCookie(serverUrl, "tvbox_auth=" + RemoteControl.authToken(prefs)
                    + "; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=31536000");
            cm.flush();
        } catch (Exception ignored) {
        }
        // Gastname kommt vom Server (aktuelle Buchung). Nur ein per adb fest gesetzter Name überschreibt ihn.
        String guestName = prefs.getString("guest_name", "");

        // Get guest name from intent (if provided)
        String intentGuestName = getIntent().getStringExtra("guest_name");
        if (intentGuestName != null && !intentGuestName.isEmpty()) {
            guestName = intentGuestName;
        }

        // Build URL to dedicated welcome page
        String url = serverUrl + "/welcome.html?welcome=" + java.net.URLEncoder.encode(guestName);

        // Add additional settings as URL parameters for the web app to use
        url += "&wifi=" + java.net.URLEncoder.encode(prefs.getString("wifi_name", ""));
        url += "&wifi_pass=" + java.net.URLEncoder.encode(prefs.getString("wifi_password", ""));
        url += "&checkin=" + java.net.URLEncoder.encode(prefs.getString("checkin_time", ""));
        url += "&checkout=" + java.net.URLEncoder.encode(prefs.getString("checkout_time", ""));
        url += "&phone=" + java.net.URLEncoder.encode(prefs.getString("contact_phone", ""));

        webView.loadUrl(url);
    }

    private void enableKioskMode() {
        // Hide status bar and navigation bar
        View decorView = getWindow().getDecorView();
        int uiOptions = View.SYSTEM_UI_FLAG_FULLSCREEN
                | View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
                | View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY
                | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN
                | View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION
                | View.SYSTEM_UI_FLAG_LAYOUT_STABLE;
        decorView.setSystemUiVisibility(uiOptions);

        // Keep screen on
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);

        // Show on lock screen
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O_MR1) {
            setShowWhenLocked(true);
            setTurnScreenOn(true);
        } else {
            getWindow().addFlags(WindowManager.LayoutParams.FLAG_SHOW_WHEN_LOCKED);
            getWindow().addFlags(WindowManager.LayoutParams.FLAG_TURN_SCREEN_ON);
        }
    }

    /**
     * Echter Kiosk-Modus (Lock Task): nur diese App und die Streaming-Apps laufen, Home führt immer hierher.
     * Funktioniert nur, wenn die App Geräte-Eigentümer ist:
     * adb shell dpm set-device-owner com.beckhome.tvwelcome/.AdminReceiver
     */
    private void startLockTaskIfOwner() {
        DevicePolicyManager dpm = (DevicePolicyManager) getSystemService(DEVICE_POLICY_SERVICE);
        if (dpm == null || !dpm.isDeviceOwnerApp(getPackageName())) return;
        if (RemoteControl.kioskOff(prefs)) return; // per PIN (bis zum Neustart) oder im Admin ausgeschaltet
        try {
            ComponentName admin = new ComponentName(this, AdminReceiver.class);
            java.util.LinkedHashSet<String> allowed = new java.util.LinkedHashSet<>();
            allowed.add(getPackageName());
            allowed.addAll(java.util.Arrays.asList(ALLOWED_APPS));
            for (String kw : APP_KEYWORDS) {
                String p = findPackageByKeyword(kw);
                if (p != null) allowed.add(p);
            }
            dpm.setLockTaskPackages(admin, allowed.toArray(new String[0]));
            // Home-Taste bleibt aktiv und führt immer hierher zurück (z.B. aus Netflix)
            IntentFilter home = new IntentFilter(Intent.ACTION_MAIN);
            home.addCategory(Intent.CATEGORY_HOME);
            home.addCategory(Intent.CATEGORY_DEFAULT);
            dpm.addPersistentPreferredActivity(admin, home, new ComponentName(this, MainActivity.class));
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
                dpm.setLockTaskFeatures(admin, DevicePolicyManager.LOCK_TASK_FEATURE_HOME);
            }
            startLockTask();
        } catch (Exception e) {
            e.printStackTrace();
        }
    }

    private void releaseLockOnly() {
        try {
            stopLockTask();
        } catch (Exception ignored) {
        }
    }

    /** Kiosk aus (Admin): Sperre lösen und Home-Taste wieder normal, Geräte-Eigentümer bleibt. */
    private void releaseKiosk() {
        releaseLockOnly();
        DevicePolicyManager dpm = (DevicePolicyManager) getSystemService(DEVICE_POLICY_SERVICE);
        if (dpm != null && dpm.isDeviceOwnerApp(getPackageName())) {
            try {
                dpm.clearPackagePersistentPreferredActivities(new ComponentName(this, AdminReceiver.class), getPackageName());
            } catch (Exception ignored) {
            }
        }
    }

    private void exitKioskMode() {
        try {
            stopLockTask();
        } catch (Exception ignored) {
        }
        DevicePolicyManager dpm = (DevicePolicyManager) getSystemService(DEVICE_POLICY_SERVICE);
        if (dpm != null && dpm.isDeviceOwnerApp(getPackageName())) {
            try {
                dpm.clearPackagePersistentPreferredActivities(new ComponentName(this, AdminReceiver.class), getPackageName());
            } catch (Exception ignored) {
            }
            dpm.clearDeviceOwnerApp(getPackageName());
        }
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        applySettingsFromIntent(intent);
        if (intent.getBooleanExtra("exit_kiosk", false)) {
            exitKioskMode();
        }
    }

    @Override
    public void onWindowFocusChanged(boolean hasFocus) {
        super.onWindowFocusChanged(hasFocus);
        if (hasFocus) {
            enableKioskMode();
        }
    }

    // Fernbedienungen ohne Menü-Taste: OK etwa 3 Sekunden gedrückt halten öffnet die Einstellungen.
    // dispatchKeyEvent, weil die WebView OK sonst selbst verbraucht.
    @Override
    public boolean dispatchKeyEvent(KeyEvent event) {
        WatchService.markActive();
        int code = event.getKeyCode();
        // Zurück-Taste 10 Sekunden halten → PIN-Abfrage für die Einstellungen (Ausstieg für den Gastgeber).
        // Per Zeitgeber statt Tasten-Wiederholung, weil manche Fernbedienungen Zurück nicht wiederholen.
        if (code == KeyEvent.KEYCODE_BACK) {
            if (event.getAction() == KeyEvent.ACTION_DOWN && event.getRepeatCount() == 0) {
                backLongPressFired = false;
                retryHandler.removeCallbacks(backLongPress);
                retryHandler.postDelayed(backLongPress, BACK_HOLD_MS);
            } else if (event.getAction() == KeyEvent.ACTION_UP) {
                retryHandler.removeCallbacks(backLongPress);
                // kurz gedrückt auf einer externen Seite: eine Seite zurück, sonst zum Welcome-Screen
                if (!backLongPressFired && !isOnWelcomePage()) {
                    if (webView.canGoBack()) webView.goBack();
                    else loadWelcomePage();
                }
            }
            return true;
        }
        // Auf einer externen Seite (urlaub.saarland …): nach längerer Ruhe zurück zum Welcome-Screen
        retryHandler.removeCallbacks(idleReturn);
        if (!isOnWelcomePage()) retryHandler.postDelayed(idleReturn, IDLE_RETURN_MS);
        return super.dispatchKeyEvent(event);
    }

    @Override
    public boolean onKeyDown(int keyCode, KeyEvent event) {
        // Disable back, home, and recent apps buttons
        if (keyCode == KeyEvent.KEYCODE_BACK ||
            keyCode == KeyEvent.KEYCODE_HOME ||
            keyCode == KeyEvent.KEYCODE_APP_SWITCH) {
            return true;
        }
        return super.onKeyDown(keyCode, event);
    }

    @Override
    protected void onPause() {
        inFront = false;
        WatchService.markActive(); // ab Verlassen des Welcome-Screens zählt die Ruhezeit
        super.onPause();
    }

    @Override
    protected void onResume() {
        super.onResume();
        inFront = true;
        if (prefs.getBoolean("just_updated", false)) {
            prefs.edit().putBoolean("just_updated", false).apply();
            String v = "";
            try {
                v = getPackageManager().getPackageInfo(getPackageName(), 0).versionName;
            } catch (Exception ignored) {
            }
            android.widget.Toast.makeText(this, "App aktualisiert auf Version " + v, android.widget.Toast.LENGTH_LONG).show();
        }
        WatchService.markActive();
        enableKioskMode();
        if (RemoteControl.kioskOff(prefs)) {
            releaseKiosk(); // im Admin ausgeschaltet: Sperre lösen, Home-Zuordnung aufheben
        } else if (!getIntent().getBooleanExtra("exit_kiosk", false)) {
            startLockTaskIfOwner();
        }
        // Fernbefehl aus dem Admin: Android-Einstellungen öffnen
        if (getIntent().getBooleanExtra(RemoteControl.EXTRA_OPEN_SETTINGS, false)) {
            getIntent().removeExtra(RemoteControl.EXTRA_OPEN_SETTINGS);
            releaseLockOnly();
            try {
                Intent si = new Intent(android.provider.Settings.ACTION_SETTINGS);
                si.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                startActivity(si);
            } catch (Exception ignored) {
            }
            return;
        }
        // Reload page when returning from settings
        loadWelcomePage();
    }
}
