package com.beckhome.tvwelcome;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.content.Intent;
import android.content.SharedPreferences;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.view.KeyEvent;
import android.view.MotionEvent;
import android.view.View;
import android.view.WindowManager;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

public class MainActivity extends Activity {

    private WebView webView;
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
        String serverUrl = prefs.getString("server_url", "http://192.168.1.100:3000");
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

    @Override
    public void onWindowFocusChanged(boolean hasFocus) {
        super.onWindowFocusChanged(hasFocus);
        if (hasFocus) {
            enableKioskMode();
        }
    }

    @Override
    public boolean onKeyDown(int keyCode, KeyEvent event) {
        // Open settings with MENU key (for easier access in emulator/testing)
        if (keyCode == KeyEvent.KEYCODE_MENU) {
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
        // Reload page when returning from settings
        loadWelcomePage();
    }
}
