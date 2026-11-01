package com.beckhome.tvwelcome;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.app.admin.DevicePolicyManager;
import android.content.ComponentName;
import android.content.Intent;
import android.content.SharedPreferences;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.view.KeyEvent;
import android.view.MotionEvent;
import android.view.View;
import android.view.WindowManager;
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
            "server_url", "guest_name", "wifi_name", "wifi_password", "checkin_time", "checkout_time", "contact_phone"
    };
    private static final long RETRY_MS = 20000;

    private WebView webView;
    private final Handler retryHandler = new Handler();
    private final Runnable retryRunnable = new Runnable() {
        @Override
        public void run() {
            loadWelcomePage();
        }
    };
    private SharedPreferences prefs;

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
                // Handle app launch intents
                if (url.startsWith("intent://")) {
                    try {
                        Intent intent = Intent.parseUri(url, Intent.URI_INTENT_SCHEME);
                        startActivity(intent);
                        return true;
                    } catch (Exception e) {
                        e.printStackTrace();
                    }
                }
                return false;
            }

            // Kein Internet (z.B. Box startet schneller als das WLAN): Hinweis zeigen und neu versuchen
            @Override
            public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M && request.isForMainFrame()) {
                    showOfflineAndRetry();
                }
            }

            @SuppressWarnings("deprecation")
            @Override
            public void onReceivedError(WebView view, int errorCode, String description, String failingUrl) {
                if (Build.VERSION.SDK_INT < Build.VERSION_CODES.M) {
                    showOfflineAndRetry();
                }
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

    private void showOfflineAndRetry() {
        retryHandler.removeCallbacks(retryRunnable);
        String html = "<html><body style='margin:0;background:#1f1c18;color:#f5f0e8;font-family:sans-serif;"
                + "display:flex;align-items:center;justify-content:center;height:100vh;text-align:center'>"
                + "<div><div style='font-size:42px'>Willkommen in der Ferienwohnung Beckhome</div>"
                + "<div style='font-size:22px;opacity:.7;margin-top:24px'>Verbindung zum Internet wird hergestellt …</div>"
                + "</div></body></html>";
        webView.loadDataWithBaseURL(null, html, "text/html", "UTF-8", null);
        retryHandler.postDelayed(retryRunnable, RETRY_MS);
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

    private void loadWelcomePage() {
        // Get settings from SharedPreferences
        retryHandler.removeCallbacks(retryRunnable);
        String serverUrl = prefs.getString("server_url", DEFAULT_SERVER_URL);
        if (serverUrl.trim().isEmpty()) serverUrl = DEFAULT_SERVER_URL;
        String guestName = prefs.getString("guest_name", "Willkommen");

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
     * Echter Kiosk-Modus (Lock Task): Home, Zurück und Übersicht der Fernbedienung sind gesperrt.
     * Funktioniert nur, wenn die App Geräte-Eigentümer ist:
     * adb shell dpm set-device-owner com.beckhome.tvwelcome/.AdminReceiver
     */
    private void startLockTaskIfOwner() {
        DevicePolicyManager dpm = (DevicePolicyManager) getSystemService(DEVICE_POLICY_SERVICE);
        if (dpm == null || !dpm.isDeviceOwnerApp(getPackageName())) return;
        try {
            ComponentName admin = new ComponentName(this, AdminReceiver.class);
            dpm.setLockTaskPackages(admin, new String[]{getPackageName()});
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
                dpm.setLockTaskFeatures(admin, DevicePolicyManager.LOCK_TASK_FEATURE_NONE);
            }
            startLockTask();
        } catch (Exception e) {
            e.printStackTrace();
        }
    }

    private void exitKioskMode() {
        try {
            stopLockTask();
        } catch (Exception ignored) {
        }
        DevicePolicyManager dpm = (DevicePolicyManager) getSystemService(DEVICE_POLICY_SERVICE);
        if (dpm != null && dpm.isDeviceOwnerApp(getPackageName())) {
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
        int code = event.getKeyCode();
        if ((code == KeyEvent.KEYCODE_DPAD_CENTER || code == KeyEvent.KEYCODE_ENTER)
                && event.getAction() == KeyEvent.ACTION_DOWN && event.getRepeatCount() == 60) {
            openSettings();
            return true;
        }
        return super.dispatchKeyEvent(event);
    }

    @Override
    public boolean onKeyDown(int keyCode, KeyEvent event) {
        // Einstellungen: MENU- oder Einstellungen-Taste der Fernbedienung
        if (keyCode == KeyEvent.KEYCODE_MENU || keyCode == KeyEvent.KEYCODE_SETTINGS) {
            openSettings();
            return true;
        }

        // Disable back, home, and recent apps buttons
        if (keyCode == KeyEvent.KEYCODE_BACK ||
            keyCode == KeyEvent.KEYCODE_HOME ||
            keyCode == KeyEvent.KEYCODE_APP_SWITCH) {
            return true;
        }
        return super.onKeyDown(keyCode, event);
    }

    @Override
    protected void onResume() {
        super.onResume();
        enableKioskMode();
        if (!getIntent().getBooleanExtra("exit_kiosk", false)) {
            startLockTaskIfOwner();
        }
        // Reload page when returning from settings
        loadWelcomePage();
    }
}
