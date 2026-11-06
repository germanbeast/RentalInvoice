package com.beckhome.tvwelcome;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

public class BootReceiver extends BroadcastReceiver {
    @Override
    public void onReceive(Context context, Intent intent) {
        String action = intent.getAction();
        // Nach einem Selbst-Update: Wächter und Welcome-Screen wieder starten
        if (Intent.ACTION_MY_PACKAGE_REPLACED.equals(action)) {
            WatchService.start(context);
            Intent i = new Intent(context, MainActivity.class);
            i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            context.startActivity(i);
            return;
        }
        if (Intent.ACTION_BOOT_COMPLETED.equals(action) || "android.intent.action.QUICKBOOT_POWERON".equals(action)) {
            // Per PIN ausgesetzter Kiosk gilt nur bis zum Neustart
            context.getSharedPreferences("WelcomeSettings", Context.MODE_PRIVATE)
                    .edit().putBoolean("kiosk_paused", false).apply();
            WatchService.start(context);
            // Start MainActivity on boot
            Intent i = new Intent(context, MainActivity.class);
            i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            context.startActivity(i);
        }
    }
}
