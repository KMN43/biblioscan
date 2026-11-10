package com.kmn43.biblioscan;

import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.provider.Settings;

import androidx.core.content.FileProvider;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;

/**
 * Actualizaciones dentro de la app: descarga la APK nueva y abre el instalador de Android
 * («¿Quieres actualizar esta app?»). Android exige siempre ese toque de confirmación; la app
 * solo necesita, una vez, el permiso «Instalar aplicaciones desconocidas».
 */
@CapacitorPlugin(name = "ApkInstaller")
public class ApkInstallerPlugin extends Plugin {

    /** ¿Tiene la app permiso para abrir el instalador? (Android 8+ lo pide por app). */
    @PluginMethod
    public void canInstall(PluginCall call) {
        boolean ok = Build.VERSION.SDK_INT < Build.VERSION_CODES.O
                || getContext().getPackageManager().canRequestPackageInstalls();
        JSObject r = new JSObject();
        r.put("allowed", ok);
        call.resolve(r);
    }

    /** Abre la pantalla de Ajustes donde se concede ese permiso a BiblioScan. */
    @PluginMethod
    public void openInstallSettings(PluginCall call) {
        Intent i = new Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
                Uri.parse("package:" + getContext().getPackageName()));
        i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        getContext().startActivity(i);
        call.resolve();
    }

    /** Descarga la APK a la caché de la app, avisando del progreso con el evento "progress". */
    @PluginMethod
    public void download(PluginCall call) {
        String url = call.getString("url");
        if (url == null || !url.startsWith("https://")) { call.reject("URL no válida"); return; }
        new Thread(() -> {
            HttpURLConnection con = null;
            try {
                File dir = new File(getContext().getCacheDir(), "updates");
                if (!dir.exists() && !dir.mkdirs()) throw new Exception("No se pudo crear la carpeta temporal");
                File out = new File(dir, "BiblioScan-update.apk");
                // GitHub redirige a otro servidor: seguir hasta 5 redirecciones a mano (https → https)
                URL u = new URL(url);
                for (int hop = 0; ; hop++) {
                    con = (HttpURLConnection) u.openConnection();
                    con.setInstanceFollowRedirects(false);
                    con.setConnectTimeout(15000);
                    con.setReadTimeout(30000);
                    con.setRequestProperty("User-Agent", "BiblioScan");
                    int code = con.getResponseCode();
                    if (code >= 300 && code < 400 && hop < 5) {
                        String loc = con.getHeaderField("Location");
                        con.disconnect();
                        u = new URL(u, loc);
                        if (!"https".equals(u.getProtocol())) throw new Exception("Redirección insegura");
                        continue;
                    }
                    if (code != 200) throw new Exception("Error " + code + " al descargar");
                    break;
                }
                long total = con.getContentLengthLong(), done = 0;
                int last = -1;
                try (InputStream in = con.getInputStream(); OutputStream os = new FileOutputStream(out)) {
                    byte[] buf = new byte[64 * 1024];
                    for (int n; (n = in.read(buf)) > 0; ) {
                        os.write(buf, 0, n);
                        done += n;
                        int pct = total > 0 ? (int) (done * 100 / total) : -1;
                        if (pct != last) {
                            last = pct;
                            JSObject p = new JSObject();
                            p.put("percent", pct);
                            p.put("bytes", done);
                            notifyListeners("progress", p);
                        }
                    }
                }
                JSObject r = new JSObject();
                r.put("path", out.getAbsolutePath());
                r.put("bytes", done);
                call.resolve(r);
            } catch (Exception e) {
                call.reject(e.getMessage() != null ? e.getMessage() : e.toString());
            } finally {
                if (con != null) con.disconnect();
            }
        }).start();
    }

    /** Abre el instalador de Android con la APK descargada. */
    @PluginMethod
    public void install(PluginCall call) {
        String path = call.getString("path");
        File f = path == null ? null : new File(path);
        File cache = getContext().getCacheDir();
        try {
            if (f == null || !f.exists() || !f.getCanonicalPath().startsWith(cache.getCanonicalPath())) {
                call.reject("No encuentro la actualización descargada");
                return;
            }
            Uri uri = FileProvider.getUriForFile(getContext(), getContext().getPackageName() + ".fileprovider", f);
            Intent i = new Intent(Intent.ACTION_VIEW);
            i.setDataAndType(uri, "application/vnd.android.package-archive");
            i.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_ACTIVITY_NEW_TASK);
            getContext().startActivity(i);
            call.resolve();
        } catch (Exception e) {
            call.reject(e.getMessage() != null ? e.getMessage() : e.toString());
        }
    }
}
