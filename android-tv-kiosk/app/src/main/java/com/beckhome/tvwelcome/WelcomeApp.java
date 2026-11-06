package com.beckhome.tvwelcome;

import android.app.Application;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;

/**
 * Nach Aus/Ein an der Fernbedienung (Bildschirm aus/an, Standby) immer zurück zum Welcome-Screen,
 * nicht zur zuletzt benutzten App (z.B. Waipu).
 */
public class WelcomeApp extends Application {

    @Override
    public void onCreate() {
        super.onCreate();
        IntentFilter filter = new IntentFilter();
        filter.addAction(Intent.ACTION_SCREEN_OFF);
        filter.addAction(Intent.ACTION_SCREEN_ON);
        registerReceiver(new BroadcastReceiver() {
            @Override
            public void onReceive(Context context, Intent intent) {
                showWelcome(context);
            }
        }, filter);
    }

    static void showWelcome(Context context) {
        try {
            Intent i = new Intent(context, MainActivity.class);
            i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP
                    | Intent.FLAG_ACTIVITY_REORDER_TO_FRONT);
            i.putExtra(MainActivity.EXTRA_RESET, true);
            context.startActivity(i);
        } catch (Exception ignored) {
        }
    }
}
