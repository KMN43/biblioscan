"""BIBLIO/SCAN — versión de escritorio.

Arranca el servidor local en segundo plano y abre la app en una ventana propia (WebView2 de Windows).
Al cerrar la ventana se cierra todo. La base de datos es la misma biblioteca.db.

    python desktop.py            -> abre la app
    python build_exe.py          -> genera BiblioScan.exe
"""
import ctypes
import os
import socket
import sys
import threading
import time

import webview

import server

PORT = 8766  # distinto del 8765 del modo navegador, para poder usar los dos a la vez


def free_port(preferred):
    with socket.socket() as s:
        try:
            s.bind(("127.0.0.1", preferred))
            return preferred
        except OSError:
            s.bind(("127.0.0.1", 0))
            return s.getsockname()[1]


def main():
    # icono propio en la barra de tareas (si no, Windows agrupa la ventana con python.exe)
    try:
        ctypes.windll.shell32.SetCurrentProcessExplicitAppUserModelID("BiblioScan.Desktop")
    except Exception:
        pass
    port = free_port(PORT)
    httpd = server.make_server(port)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()

    webview.settings["ALLOW_DOWNLOADS"] = True  # exportar CSV / JSON
    # ?v=… distinto en cada arranque: la ventana nunca reutiliza una versión vieja guardada en caché
    webview.create_window("BiblioScan · Catálogo Óptico de Biblioteca", f"http://127.0.0.1:{port}/?v={int(time.time())}",
                          width=1440, height=900, min_size=(1000, 640), background_color="#ecebe6")
    # private_mode=False: recuerda la cámara elegida, la vista del catálogo y el permiso de cámara
    webview.start(private_mode=False, storage_path=os.path.join(server.DATA_DIR, ".biblioscan-webview"))
    httpd.shutdown()


if __name__ == "__main__":
    sys.exit(main())
