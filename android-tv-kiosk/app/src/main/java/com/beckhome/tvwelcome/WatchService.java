package com.beckhome.tvwelcome;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.Service;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.content.pm.ServiceInfo;
import android.hardware.display.DisplayManager;
import android.os.Build;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.os.PowerManager;
import android.view.Display;

/**
 * Läuft dauerhaft im Hintergrund und holt den Welcome-Screen nach vorne, sobald der Fernseher
 * aus- und wieder eingeschaltet wird – egal auf welchem Weg die Box davon erfährt:
 * Bildschirm aus/an (Standby), Bildschirmschoner, HDMI getrennt (nur Fernseher aus) oder
 * Anzeige aus. Zusätzlich wird alle paar Sekunden nachgesehen, falls ein Signal fehlt.
 */
public class WatchService extends Service {

    private static final String CHANNEL = "watch";
    private static final long POLL_MS = 3000;
    private static final long UPDATE_EVERY_MS = 3 * 60 * 60 * 1000L;
    /** Nach so langer Ruhe (keine Taste auf der Fernbedienung) geht es zurück zum Welcome-Screen. */
    static final long IDLE_HOME_MS = 4 * 60 * 60 * 1000L;
    private static final long IDLE_CHECK_MS = 60 * 1000L;
    private static volatile long lastActive = System.currentTimeMillis();
    private static final String HDMI_PLUG = "android.media.action.HDMI_AUDIO_PLUG";

    private final Handler handler = new Handler(Looper.getMainLooper());
    private boolean wasOff = false;
    private boolean lastOn = true;

    private final BroadcastReceiver receiver = new BroadcastReceiver() {
        @Override
        public void onReceive(Context context, Intent intent) {
            String a = intent.getAction();
            if (a == null) return;
            if (HDMI_PLUG.equals(a)) {
                if (isInitialStickyBroadcast()) return; // aktueller Zustand beim Anmelden, kein Wechsel
                int state = intent.getIntExtra("android.media.extra.AUDIO_PLUG_STATE", -1);
                if (state == 0) turnedOff();
                else if (state == 1) turnedOn();
                return;
            }
            switch (a) {
                case Intent.ACTION_SCREEN_OFF:
                case Intent.ACTION_DREAMING_STARTED:
                    turnedOff();
                    break;
                case Intent.ACTION_SCREEN_ON:
                case Intent.ACTION_DREAMING_STOPPED:
                case Intent.ACTION_USER_PRESENT:
                    turnedOn();
                    break;
            }
        }
    };

    private final Runnable updateCheck = new Runnable() {
        @Override
        public void run() {
            SelfUpdater.checkAsync(WatchService.this);
            handler.postDelayed(this, UPDATE_EVERY_MS);
        }
    };

    private final Runnable poll = new Runnable() {
        @Override
        public void run() {
            boolean on = isDisplayOn();
            if (lastOn && !on) turnedOff();
            else if (!lastOn && on) turnedOn();
            lastOn = on;
            handler.postDelayed(this, POLL_MS);
        }
    };

    /** Tastendruck oder Wechsel weg vom Welcome-Screen: Ruhezeit beginnt neu. */
    static void markActive() {
        lastActive = System.currentTimeMillis();
    }

    private final Runnable idleCheck = new Runnable() {
        @Override
        public void run() {
            // Läuft eine andere App (z.B. Waipu) und seit 4 Stunden wurde keine Taste gedrückt,
            // zurück zum Welcome-Screen. Ohne Tasten-Wächter (Bedienungshilfe nicht aktiv) zählt die
            // Zeit ab dem Verlassen des Welcome-Screens.
            if (!MainActivity.inFront && isDisplayOn()
                    && System.currentTimeMillis() - lastActive >= IDLE_HOME_MS) {
                markActive();
                showWelcome();
            }
            handler.postDelayed(this, IDLE_CHECK_MS);
        }
    };

    static void start(Context context) {
        try {
            Intent i = new Intent(context, WatchService.class);
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) context.startForegroundService(i);
            else context.startService(i);
        } catch (Exception ignored) {
        }
    }

    @Override
    public void onCreate() {
        super.onCreate();
        goForeground();
        ensureKeyWatch();
        IntentFilter f = new IntentFilter();
        f.addAction(Intent.ACTION_SCREEN_OFF);
        f.addAction(Intent.ACTION_SCREEN_ON);
        f.addAction(Intent.ACTION_DREAMING_STARTED);
        f.addAction(Intent.ACTION_DREAMING_STOPPED);
        f.addAction(Intent.ACTION_USER_PRESENT);
        f.addAction(HDMI_PLUG);
        if (Build.VERSION.SDK_INT >= 33) {
            registerReceiver(receiver, f, Context.RECEIVER_EXPORTED); // System-Broadcasts
        } else {
            registerReceiver(receiver, f);
        }
        lastOn = isDisplayOn();
        handler.postDelayed(poll, POLL_MS);
        handler.postDelayed(idleCheck, IDLE_CHECK_MS);
        handler.postDelayed(updateCheck, 60 * 1000); // kurz nach dem Start, dann alle 3 Stunden
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        return START_STICKY;
    }

    @Override
    public void onDestroy() {
        handler.removeCallbacks(poll);
        handler.removeCallbacks(updateCheck);
        handler.removeCallbacks(idleCheck);
        try {
            unregisterReceiver(receiver);
        } catch (Exception ignored) {
        }
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    private void turnedOff() {
        wasOff = true;
        showWelcome(); // schon im Dunkeln nach vorne holen, beim Einschalten ist er sofort da
    }

    private void turnedOn() {
        if (wasOff) {
            wasOff = false;
            showWelcome();
            SelfUpdater.checkAsync(this);
        }
    }

    private void showWelcome() {
        try {
            Intent i = new Intent(this, MainActivity.class);
            i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP
                    | Intent.FLAG_ACTIVITY_REORDER_TO_FRONT);
            i.putExtra(MainActivity.EXTRA_RESET, true);
            startActivity(i);
        } catch (Exception ignored) {
        }
    }

    /**
     * Schaltet die Ruhe-Erkennung (Bedienungshilfe) wieder ein, falls Android sie z.B. nach einem
     * Absturz abgeschaltet hat. Geht nur, wenn die .bat WRITE_SECURE_SETTINGS erteilt hat.
     */
    private void ensureKeyWatch() {
        try {
            if (checkSelfPermission(android.Manifest.permission.WRITE_SECURE_SETTINGS)
                    != android.content.pm.PackageManager.PERMISSION_GRANTED) return;
            android.content.ContentResolver cr = getContentResolver();
            String me = getPackageName() + "/" + KeyWatchService.class.getName();
            String meShort = getPackageName() + "/.KeyWatchService";
            String list = android.provider.Settings.Secure.getString(cr,
                    android.provider.Settings.Secure.ENABLED_ACCESSIBILITY_SERVICES);
            if (list == null) list = "";
            if (!list.contains(me) && !list.contains(meShort)) {
                list = list.isEmpty() ? meShort : list + ":" + meShort;
                android.provider.Settings.Secure.putString(cr,
                        android.provider.Settings.Secure.ENABLED_ACCESSIBILITY_SERVICES, list);
            }
            android.provider.Settings.Secure.putInt(cr,
                    android.provider.Settings.Secure.ACCESSIBILITY_ENABLED, 1);
        } catch (Exception ignored) {
        }
    }

    private boolean isDisplayOn() {
        try {
            PowerManager pm = (PowerManager) getSystemService(POWER_SERVICE);
            if (pm != null && !pm.isInteractive()) return false;
            DisplayManager dm = (DisplayManager) getSystemService(DISPLAY_SERVICE);
            if (dm != null) {
                Display d = dm.getDisplay(Display.DEFAULT_DISPLAY);
                if (d != null && d.getState() == Display.STATE_OFF) return false;
            }
        } catch (Exception ignored) {
        }
        return true;
    }

    private void goForeground() {
        NotificationManager nm = (NotificationManager) getSystemService(NOTIFICATION_SERVICE);
        Notification.Builder b;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            if (nm != null) {
                nm.createNotificationChannel(new NotificationChannel(CHANNEL, "Welcome-Screen",
                        NotificationManager.IMPORTANCE_MIN));
            }
            b = new Notification.Builder(this, CHANNEL);
        } else {
            b = new Notification.Builder(this);
        }
        Notification n = b.setContentTitle("Welcome-Screen aktiv")
                .setSmallIcon(android.R.drawable.ic_menu_info_details)
                .setOngoing(true)
                .build();
        try {
            if (Build.VERSION.SDK_INT >= 34) {
                startForeground(1, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE);
            } else {
                startForeground(1, n);
            }
        } catch (Exception ignored) {
        }
    }
}
