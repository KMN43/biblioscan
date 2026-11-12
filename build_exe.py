"""Genera BiblioScan.exe (un solo archivo) junto a este script.

    python build_exe.py

Requisitos (una vez):  python -m pip install --user pywebview pyinstaller pillow
El .exe usa la biblioteca.db que tenga al lado; si no hay, crea una vacía.
"""
import os
import shutil
import subprocess
import sys


HERE = os.path.dirname(os.path.abspath(__file__))
ICON = os.path.join(HERE, "biblioscan.ico")


def make_icon():
    from logo import render
    sizes = [16, 24, 32, 48, 64, 128, 256]
    imgs = [render(n, mark=.72 if n <= 24 else .66) for n in sizes]   # en pequeño, el libro algo mayor
    imgs[-1].save(ICON, sizes=[(n, n) for n in sizes], append_images=imgs[:-1])


def main():
    make_icon()
    sep = os.pathsep
    cmd = [sys.executable, "-m", "PyInstaller", "--noconfirm", "--clean", "--onefile", "--windowed",
           "--name", "BiblioScan", "--icon", ICON,
           "--add-data", f"{os.path.join(HERE, 'index.html')}{sep}.",
           "--distpath", HERE,
           "--workpath", os.path.join(HERE, "build"),
           "--specpath", os.path.join(HERE, "build"),
           os.path.join(HERE, "desktop.py")]
    subprocess.check_call(cmd, cwd=HERE)
    shutil.rmtree(os.path.join(HERE, "build"), ignore_errors=True)
    print("\nListo:", os.path.join(HERE, "BiblioScan.exe"))


if __name__ == "__main__":
    main()
