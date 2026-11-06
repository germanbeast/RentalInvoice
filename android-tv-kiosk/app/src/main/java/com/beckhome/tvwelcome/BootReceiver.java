package com.beckhome.tvwelcome;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

public class BootReceiver extends BroadcastReceiver {
    @Override
    public void onReceive(Context context, Intent intent) {
        if (Intent.ACTION_BOOT_COMPLETED.equals(intent.getAction())) {
            // Per PIN ausgesetzter Kiosk gilt nur bis zum Neustart
            context.getSharedPreferences("WelcomeSettings", Context.MODE_PRIVATE)
                    .edit().putBoolean("kiosk_paused", false).apply();
            // Start MainActivity on boot
            Intent i = new Intent(context, MainActivity.class);
            i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            context.startActivity(i);
        }
    }
}
