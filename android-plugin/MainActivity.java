package com.example.senalcelular;

import android.os.Bundle;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        // Los plugins locales deben registrarse ANTES de super.onCreate().
        registerPlugin(SignalMonitorPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
