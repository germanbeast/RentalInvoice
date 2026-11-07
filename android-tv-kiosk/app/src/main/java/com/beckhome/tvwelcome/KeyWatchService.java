package com.beckhome.tvwelcome;

import android.accessibilityservice.AccessibilityService;
import android.view.KeyEvent;
import android.view.accessibility.AccessibilityEvent;

/**
 * Bedienungshilfe, die nur mitzählt, wann zuletzt eine Taste auf der Fernbedienung gedrückt wurde –
 * auch während Waipu oder eine andere App läuft. Die Tasten werden nicht abgefangen, sondern normal
 * weitergereicht. Wird von TV-Box-einrichten.bat eingeschaltet.
 */
public class KeyWatchService extends AccessibilityService {

    /** Läuft gerade (für die Statusanzeige im Admin). */
    static volatile boolean connected = false;

    @Override
    protected void onServiceConnected() {
        super.onServiceConnected();
        connected = true;
    }

    @Override
    public void onDestroy() {
        connected = false;
        super.onDestroy();
    }

    @Override
    protected boolean onKeyEvent(KeyEvent event) {
        WatchService.markActive();
        return false; // Taste nicht verbrauchen
    }

    @Override
    public void onAccessibilityEvent(AccessibilityEvent event) {
        // Touch auf Boxen mit Touch/Maus zählt ebenfalls als Bedienung
        if (event != null && event.getEventType() == AccessibilityEvent.TYPE_TOUCH_INTERACTION_START) {
            WatchService.markActive();
        }
    }

    @Override
    public void onInterrupt() {
    }
}
