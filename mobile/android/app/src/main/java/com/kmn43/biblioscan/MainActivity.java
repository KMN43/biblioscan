package com.kmn43.biblioscan;

import android.os.Bundle;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(ApkInstallerPlugin.class);   // actualizaciones dentro de la app
        registerPlugin(SunLinkPlugin.class);        // juntar soles con otro móvil cercano
        super.onCreate(savedInstanceState);
    }
}
