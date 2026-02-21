package com.beckhome.tvwelcome;

import android.app.Activity;
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

        // Save button
        btnSave.setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                saveSettings();
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

    private void loadSettings() {
        etServerUrl.setText(prefs.getString("server_url", "http://192.168.1.100:3000"));
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
