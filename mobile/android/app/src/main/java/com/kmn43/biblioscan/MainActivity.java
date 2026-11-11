package com.kmn43.biblioscan;

import android.os.Bundle;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(ApkInstallerPlugin.class);   // actualizaciones dentro de la app
        super.onCreate(savedInstanceState);
    }
}
