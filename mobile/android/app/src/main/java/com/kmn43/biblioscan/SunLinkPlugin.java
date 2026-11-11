package com.kmn43.biblioscan;

import android.Manifest;
import android.bluetooth.BluetoothAdapter;
import android.bluetooth.BluetoothManager;
import android.bluetooth.le.AdvertiseCallback;
import android.bluetooth.le.AdvertiseData;
import android.bluetooth.le.AdvertiseSettings;
import android.bluetooth.le.BluetoothLeAdvertiser;
import android.bluetooth.le.BluetoothLeScanner;
import android.bluetooth.le.ScanCallback;
import android.bluetooth.le.ScanFilter;
import android.bluetooth.le.ScanResult;
import android.bluetooth.le.ScanSettings;
import android.content.Context;
import android.location.LocationManager;
import android.os.Build;
import android.os.ParcelUuid;

import androidx.annotation.NonNull;

import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;
import com.google.android.gms.nearby.Nearby;
import com.google.android.gms.nearby.connection.AdvertisingOptions;
import com.google.android.gms.nearby.connection.ConnectionInfo;
import com.google.android.gms.nearby.connection.ConnectionLifecycleCallback;
import com.google.android.gms.nearby.connection.ConnectionResolution;
import com.google.android.gms.nearby.connection.ConnectionsClient;
import com.google.android.gms.nearby.connection.ConnectionsStatusCodes;
import com.google.android.gms.nearby.connection.DiscoveredEndpointInfo;
import com.google.android.gms.nearby.connection.DiscoveryOptions;
import com.google.android.gms.nearby.connection.EndpointDiscoveryCallback;
import com.google.android.gms.nearby.connection.Payload;
import com.google.android.gms.nearby.connection.PayloadCallback;
import com.google.android.gms.nearby.connection.PayloadTransferUpdate;
import com.google.android.gms.nearby.connection.Strategy;

import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.UUID;

/**
 * SunLink: encuentra otro móvil con BiblioScan («Juntar soles» abierto), se conecta sin internet
 * (Google Nearby Connections) e intercambia mensajes cortos. Además mide la intensidad de la señal
 * Bluetooth LE del otro móvil (RSSI) para estimar la distancia entre los dos.
 *
 * Eventos hacia JS: found, connected, disconnected, message {data}, rssi {tag, rssi}, error {message}.
 */
@CapacitorPlugin(
    name = "SunLink",
    permissions = {
        @Permission(alias = "bt", strings = {
            Manifest.permission.BLUETOOTH_SCAN, Manifest.permission.BLUETOOTH_ADVERTISE, Manifest.permission.BLUETOOTH_CONNECT }),
        @Permission(alias = "wifi", strings = { Manifest.permission.NEARBY_WIFI_DEVICES }),
        @Permission(alias = "location", strings = { Manifest.permission.ACCESS_FINE_LOCATION, Manifest.permission.ACCESS_COARSE_LOCATION }),
    })
public class SunLinkPlugin extends Plugin {

    private static final String SERVICE_ID = "com.kmn43.biblioscan.sol";
    private static final ParcelUuid BLE_UUID = new ParcelUuid(UUID.fromString("6f0b5a2e-3c1d-4b8e-9a77-b1b5ca2f0e11"));

    private ConnectionsClient client;
    private String peerId = null;
    private boolean running = false;
    private String myName = "BS-00000000";
    private BluetoothLeAdvertiser advertiser;
    private BluetoothLeScanner scanner;
    private AdvertiseCallback advCb;
    private ScanCallback scanCb;

    private ConnectionsClient client() {
        if (client == null) client = Nearby.getConnectionsClient(getContext());
        return client;
    }

    private String[] aliasesNeeded() {
        List<String> a = new ArrayList<>();
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) a.add("bt");
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) a.add("wifi");
        a.add("location");   // Nearby Connections la exige en todas las versiones (error 8034 si falta)
        return a.toArray(new String[0]);
    }

    private boolean allGranted() {
        for (String alias : aliasesNeeded()) if (getPermissionState(alias) != PermissionState.GRANTED) return false;
        return locationOn();
    }

    /** Nearby también necesita la ubicación del sistema encendida. */
    private boolean locationOn() {
        try {
            LocationManager lm = (LocationManager) getContext().getSystemService(Context.LOCATION_SERVICE);
            return lm == null || Build.VERSION.SDK_INT < Build.VERSION_CODES.P || lm.isLocationEnabled();
        } catch (Exception e) { return true; }
    }

    private void emitError(String msg) {
        JSObject o = new JSObject();
        o.put("message", msg);
        notifyListeners("error", o);
    }

    /** Pide los permisos necesarios. Resuelve {granted}. */
    @PluginMethod
    public void ensurePermissions(PluginCall call) {
        if (allGranted()) { JSObject r = new JSObject(); r.put("granted", true); call.resolve(r); return; }
        boolean perms = true;
        for (String alias : aliasesNeeded()) if (getPermissionState(alias) != PermissionState.GRANTED) perms = false;
        if (perms) { permsDone(call); return; }
        requestPermissionForAliases(aliasesNeeded(), call, "permsDone");
    }

    @PermissionCallback
    private void permsDone(PluginCall call) {
        JSObject r = new JSObject();
        r.put("granted", allGranted());
        r.put("locationOff", !locationOn());
        call.resolve(r);
    }

    /** Empieza a anunciarse y a buscar. tag: 4 bytes aleatorios en hex (nombre «BS-tag» y marca en Bluetooth LE; sin datos personales). */
    @PluginMethod
    public void start(PluginCall call) {
        if (!allGranted()) { call.reject("Faltan permisos"); return; }
        String tag = call.getString("tag", "00000000");
        stopAll();
        running = true;
        myName = "BS-" + tag;
        client().startAdvertising(myName, SERVICE_ID, lifecycle,
                new AdvertisingOptions.Builder().setStrategy(Strategy.P2P_POINT_TO_POINT).build())
            .addOnFailureListener(e -> emitError("No se pudo anunciar: " + e.getMessage()));
        client().startDiscovery(SERVICE_ID, discovery,
                new DiscoveryOptions.Builder().setStrategy(Strategy.P2P_POINT_TO_POINT).build())
            .addOnFailureListener(e -> emitError("No se pudo buscar: " + e.getMessage()));
        startBle(hex(tag));
        call.resolve();
    }

    @PluginMethod
    public void stop(PluginCall call) {
        stopAll();
        call.resolve();
    }

    /** Envía un mensaje de texto (JSON) al móvil conectado. */
    @PluginMethod
    public void send(PluginCall call) {
        String data = call.getString("data", "");
        if (peerId == null) { call.reject("No hay ningún sol conectado"); return; }
        client().sendPayload(peerId, Payload.fromBytes(data.getBytes(StandardCharsets.UTF_8)));
        call.resolve();
    }

    private void stopAll() {
        running = false;
        try { client().stopAdvertising(); client().stopDiscovery(); client().stopAllEndpoints(); } catch (Exception ignored) { }
        peerId = null;
        stopBle();
    }

    @Override
    protected void handleOnDestroy() { stopAll(); }

    // ---------------- Nearby Connections ----------------
    private final EndpointDiscoveryCallback discovery = new EndpointDiscoveryCallback() {
        @Override
        public void onEndpointFound(@NonNull String endpointId, @NonNull DiscoveredEndpointInfo info) {
            if (peerId != null || !running) return;
            String other = info.getEndpointName();
            JSObject o = new JSObject();
            o.put("id", endpointId); o.put("name", other);
            notifyListeners("found", o);
            // solo pide la conexión el móvil con el nombre «menor»: así no se cruzan dos peticiones a la vez
            if (myName.compareTo(other) > 0) return;
            client().requestConnection(myName, endpointId, lifecycle)
                .addOnFailureListener(e -> emitError("No se pudo conectar: " + e.getMessage()));
        }
        @Override
        public void onEndpointLost(@NonNull String endpointId) { }
    };

    private final ConnectionLifecycleCallback lifecycle = new ConnectionLifecycleCallback() {
        @Override
        public void onConnectionInitiated(@NonNull String endpointId, @NonNull ConnectionInfo info) {
            client().acceptConnection(endpointId, payloads);   // los dos han abierto «Juntar soles»: se acepta sin más
        }
        @Override
        public void onConnectionResult(@NonNull String endpointId, @NonNull ConnectionResolution result) {
            int code = result.getStatus().getStatusCode();
            if (code == ConnectionsStatusCodes.STATUS_OK) {
                peerId = endpointId;
                try { client().stopDiscovery(); client().stopAdvertising(); } catch (Exception ignored) { }
                JSObject o = new JSObject();
                o.put("id", endpointId);
                notifyListeners("connected", o);
            } else {
                emitError("Conexión rechazada (" + code + ")");
            }
        }
        @Override
        public void onDisconnected(@NonNull String endpointId) {
            if (endpointId.equals(peerId)) peerId = null;
            notifyListeners("disconnected", new JSObject());
        }
    };

    private final PayloadCallback payloads = new PayloadCallback() {
        @Override
        public void onPayloadReceived(@NonNull String endpointId, @NonNull Payload payload) {
            if (payload.getType() != Payload.Type.BYTES || payload.asBytes() == null) return;
            JSObject o = new JSObject();
            o.put("data", new String(payload.asBytes(), StandardCharsets.UTF_8));
            notifyListeners("message", o);
        }
        @Override
        public void onPayloadTransferUpdate(@NonNull String endpointId, @NonNull PayloadTransferUpdate update) { }
    };

    // ---------------- Bluetooth LE: señal del otro móvil (RSSI) ----------------
    private void startBle(byte[] tag) {
        try {
            BluetoothManager bm = (BluetoothManager) getContext().getSystemService(Context.BLUETOOTH_SERVICE);
            BluetoothAdapter ad = bm == null ? null : bm.getAdapter();
            if (ad == null || !ad.isEnabled()) { emitError("Activa el Bluetooth para medir la distancia"); return; }
            advertiser = ad.getBluetoothLeAdvertiser();
            scanner = ad.getBluetoothLeScanner();
            if (advertiser != null) {
                advCb = new AdvertiseCallback() {
                    @Override public void onStartFailure(int errorCode) { emitError("Bluetooth LE: no se pudo anunciar (" + errorCode + ")"); }
                };
                advertiser.startAdvertising(
                    new AdvertiseSettings.Builder().setAdvertiseMode(AdvertiseSettings.ADVERTISE_MODE_LOW_LATENCY)
                        .setTxPowerLevel(AdvertiseSettings.ADVERTISE_TX_POWER_MEDIUM).setConnectable(false).build(),
                    new AdvertiseData.Builder().addServiceUuid(BLE_UUID).addServiceData(BLE_UUID, tag).setIncludeDeviceName(false).build(),
                    advCb);
            }
            if (scanner != null) {
                scanCb = new ScanCallback() {
                    @Override
                    public void onScanResult(int callbackType, ScanResult result) {
                        if (result.getScanRecord() == null) return;
                        byte[] t = result.getScanRecord().getServiceData(BLE_UUID);
                        if (t == null) return;
                        JSObject o = new JSObject();
                        o.put("tag", toHex(t)); o.put("rssi", result.getRssi());
                        notifyListeners("rssi", o);
                    }
                };
                scanner.startScan(
                    Collections.singletonList(new ScanFilter.Builder().setServiceUuid(BLE_UUID).build()),
                    new ScanSettings.Builder().setScanMode(ScanSettings.SCAN_MODE_LOW_LATENCY).build(),
                    scanCb);
            }
        } catch (SecurityException e) {
            emitError("Faltan permisos de Bluetooth");
        } catch (Exception e) {
            emitError("Bluetooth LE: " + e.getMessage());
        }
    }

    private void stopBle() {
        try { if (advertiser != null && advCb != null) advertiser.stopAdvertising(advCb); } catch (Exception ignored) { }
        try { if (scanner != null && scanCb != null) scanner.stopScan(scanCb); } catch (Exception ignored) { }
        advCb = null; scanCb = null;
    }

    private static byte[] hex(String s) {
        s = s.replaceAll("[^0-9a-fA-F]", "");
        if (s.length() % 2 == 1) s = "0" + s;
        byte[] b = new byte[Math.min(8, s.length() / 2)];
        for (int i = 0; i < b.length; i++) b[i] = (byte) Integer.parseInt(s.substring(i * 2, i * 2 + 2), 16);
        return b;
    }

    private static String toHex(byte[] b) {
        StringBuilder sb = new StringBuilder();
        for (byte x : b) sb.append(String.format("%02x", x));
        return sb.toString();
    }
}
