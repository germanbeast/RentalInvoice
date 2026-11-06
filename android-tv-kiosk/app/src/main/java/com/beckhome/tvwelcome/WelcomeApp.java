package com.beckhome.tvwelcome;

import android.app.Application;

/** Startet beim Prozessstart den Wächter, der nach Aus/Ein den Welcome-Screen zurückholt. */
public class WelcomeApp extends Application {

    @Override
    public void onCreate() {
        super.onCreate();
        WatchService.start(this);
    }
}
