"""Genera BiblioScan.exe (un solo archivo) junto a este script.

    python build_exe.py

Requisitos (una vez):  python -m pip install --user pywebview pyinstaller pillow
El .exe usa la biblioteca.db que tenga al lado; si no hay, crea una vacía.
"""
import os
import shutil
import subprocess
import sys

from PIL import Image, ImageDraw, ImageFont

HERE = os.path.dirname(os.path.abspath(__file__))
ICON = os.path.join(HERE, "biblioscan.ico")


def make_icon():
    S = 256
    img = Image.new("RGBA", (S, S), "#ff4f12")
    d = ImageDraw.Draw(img)
    d.rectangle([14, 14, S - 15, S - 15], outline="#121212", width=10)
    try:
        font = ImageFont.truetype("arialbd.ttf", 104)
    except OSError:
        font = ImageFont.load_default()
    d.text((S / 2, S / 2 - 6), "B/S", fill="#121212", font=font, anchor="mm")
    d.rectangle([40, S - 62, S - 41, S - 50], fill="#121212")  # "código de barras" minimalista
    img.save(ICON, sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)])


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
