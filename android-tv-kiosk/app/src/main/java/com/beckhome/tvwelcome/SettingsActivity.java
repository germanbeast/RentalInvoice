package com.beckhome.tvwelcome;

import android.app.Activity;
import android.content.Intent;
import android.content.SharedPreferences;
import android.os.Bundle;
import android.view.View;
import android.widget.Button;
import android.widget.EditText;
import android.widget.Toast;

public class SettingsActivity extends Activity {

    private EditText etServerUrl;
    private EditText etGuestName;
    private EditText etWifiName;
    private EditText etWifiPassword;
    private EditText etCheckInTime;
    private EditText etCheckOutTime;
    private EditText etContactPhone;
    private Button btnSave;
    private Button btnClose;

    private SharedPreferences prefs;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        setContentView(R.layout.activity_settings);

        prefs = getSharedPreferences("WelcomeSettings", MODE_PRIVATE);

        // Find views
        etServerUrl = findViewById(R.id.et_server_url);
        etGuestName = findViewById(R.id.et_guest_name);
        etWifiName = findViewById(R.id.et_wifi_name);
        etWifiPassword = findViewById(R.id.et_wifi_password);
        etCheckInTime = findViewById(R.id.et_checkin_time);
        etCheckOutTime = findViewById(R.id.et_checkout_time);
        etContactPhone = findViewById(R.id.et_contact_phone);
        btnSave = findViewById(R.id.btn_save);
        btnClose = findViewById(R.id.btn_close);

        // Load saved settings
        loadSettings();
        askPin();

        // Save button
        btnSave.setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                saveSettings();
            }
        });

        findViewById(R.id.btn_wifi_settings).setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                openSystemScreen(android.provider.Settings.ACTION_WIFI_SETTINGS);
            }
        });

        // Kiosk aussetzen: Sperre lösen, Home-Zuordnung aufheben, bis zum nächsten Neustart
        findViewById(R.id.btn_exit_kiosk).setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                prefs.edit().putBoolean("kiosk_paused", true).apply();
                android.app.admin.DevicePolicyManager dpm =
                        (android.app.admin.DevicePolicyManager) getSystemService(DEVICE_POLICY_SERVICE);
                if (dpm != null && dpm.isDeviceOwnerApp(getPackageName())) {
                    try {
                        dpm.clearPackagePersistentPreferredActivities(
                                new android.content.ComponentName(SettingsActivity.this, AdminReceiver.class),
                                getPackageName());
                    } catch (Exception ignored) {
                    }
                }
                Toast.makeText(SettingsActivity.this,
                        "Kiosk beendet. Nach einem Neustart ist er wieder aktiv.", Toast.LENGTH_LONG).show();
                openSystemScreen(android.provider.Settings.ACTION_SETTINGS);
            }
        });

        // Android-Einstellungen (WLAN, Entwickleroptionen …). Kiosk-Sperre dafür kurz lösen,
        // die Home-Taste führt danach zum Welcome-Screen, der die Sperre wieder setzt.
        findViewById(R.id.btn_android_settings).setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                openSystemScreen(android.provider.Settings.ACTION_SETTINGS);
            }
        });

        // Close button
        btnClose.setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                finish();
            }
        });
    }

    /** Android-Einstellungen öffnen; die Kiosk-Sperre dafür lösen (Home setzt sie wieder). */
    private void openSystemScreen(String action) {
        try {
            stopLockTask();
        } catch (Exception ignored) {
        }
        try {
            Intent i = new Intent(action);
            i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            startActivity(i);
        } catch (Exception e) {
            Toast.makeText(this, "Einstellungen nicht verfügbar", Toast.LENGTH_LONG).show();
        }
    }

    /** Gäste kommen ohne PIN nicht in die Einstellungen. PIN setzt das Einrichtungs-Skript (admin_pin). */
    private void askPin() {
        final String pin = prefs.getString("admin_pin", "");
        if (pin.isEmpty()) return;
        final EditText input = new EditText(this);
        input.setInputType(android.text.InputType.TYPE_CLASS_NUMBER
                | android.text.InputType.TYPE_NUMBER_VARIATION_PASSWORD);
        input.setTextSize(28);
        final android.app.AlertDialog dialog = new android.app.AlertDialog.Builder(this)
                .setTitle("PIN eingeben")
                .setView(input)
                .setCancelable(true)
                .setPositiveButton("OK", null)
                .setNegativeButton("Abbrechen", null)
                .create();
        dialog.setOnCancelListener(new android.content.DialogInterface.OnCancelListener() {
            @Override
            public void onCancel(android.content.DialogInterface d) {
                finish();
            }
        });
        dialog.setOnShowListener(new android.content.DialogInterface.OnShowListener() {
            @Override
            public void onShow(android.content.DialogInterface d) {
                dialog.getButton(android.app.AlertDialog.BUTTON_POSITIVE).setOnClickListener(new View.OnClickListener() {
                    @Override
                    public void onClick(View v) {
                        if (pin.equals(input.getText().toString().trim())) {
                            dialog.dismiss();
                        } else {
                            input.setText("");
                            Toast.makeText(SettingsActivity.this, "Falsche PIN", Toast.LENGTH_SHORT).show();
                        }
                    }
                });
                dialog.getButton(android.app.AlertDialog.BUTTON_NEGATIVE).setOnClickListener(new View.OnClickListener() {
                    @Override
                    public void onClick(View v) {
                        dialog.dismiss();
                        finish();
                    }
                });
                input.requestFocus();
            }
        });
        dialog.show();
    }

    private void loadSettings() {
        etServerUrl.setText(prefs.getString("server_url", MainActivity.DEFAULT_SERVER_URL));
        etGuestName.setText(prefs.getString("guest_name", "Gast"));
        etWifiName.setText(prefs.getString("wifi_name", "Ferienwohnung-WLAN"));
        etWifiPassword.setText(prefs.getString("wifi_password", ""));
        etCheckInTime.setText(prefs.getString("checkin_time", "15:00 Uhr"));
        etCheckOutTime.setText(prefs.getString("checkout_time", "10:00 Uhr"));
        etContactPhone.setText(prefs.getString("contact_phone", "+49 123 456789"));
    }

    private void saveSettings() {
        SharedPreferences.Editor editor = prefs.edit();

        editor.putString("server_url", etServerUrl.getText().toString());
        editor.putString("guest_name", etGuestName.getText().toString());
        editor.putString("wifi_name", etWifiName.getText().toString());
        editor.putString("wifi_password", etWifiPassword.getText().toString());
        editor.putString("checkin_time", etCheckInTime.getText().toString());
        editor.putString("checkout_time", etCheckOutTime.getText().toString());
        editor.putString("contact_phone", etContactPhone.getText().toString());

        editor.apply();

        Toast.makeText(this, "Einstellungen gespeichert!", Toast.LENGTH_SHORT).show();

        // Restart MainActivity to apply changes
        finish();
    }
}
