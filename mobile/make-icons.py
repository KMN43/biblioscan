"""Genera los iconos y la pantalla de arranque de Android con el logo de BiblioScan (logo.py, en la raíz).
    python make-icons.py
"""
import glob
import os
import sys
from PIL import Image

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))
from logo import render  # noqa: E402

RES = os.path.join(os.path.dirname(os.path.abspath(__file__)), "android", "app", "src", "main", "res")
ORANGE, INK, PAPER = "#ff4f12", "#121212", "#ecebe6"


def legacy(size, round_):
    return render(size, ORANGE, INK, "circle" if round_ else "rounded", mark=.62 if round_ else .66)


def foreground(size):  # icono adaptativo: el dibujo dentro de la zona segura (66 % central); la estrella es un hueco
    return render(size, None, INK, None, mark=.5)


DENS = {"mdpi": 1, "hdpi": 1.5, "xhdpi": 2, "xxhdpi": 3, "xxxhdpi": 4}
for name, k in DENS.items():
    out = os.path.join(RES, f"mipmap-{name}")
    legacy(int(48 * k), False).save(os.path.join(out, "ic_launcher.png"))
    legacy(int(48 * k), True).save(os.path.join(out, "ic_launcher_round.png"))
    foreground(int(108 * k)).save(os.path.join(out, "ic_launcher_foreground.png"))

with open(os.path.join(RES, "values", "ic_launcher_background.xml"), "w", encoding="utf-8") as f:
    f.write('<?xml version="1.0" encoding="utf-8"?>\n<resources>\n    <color name="ic_launcher_background">#FF4F12</color>\n</resources>\n')

for path in glob.glob(os.path.join(RES, "drawable*", "splash.png")):
    w, h = Image.open(path).size
    img = Image.new("RGB", (w, h), PAPER)
    s = int(min(w, h) * 0.32)
    icon = render(s, ORANGE, INK, "rounded", mark=.66)
    img.paste(icon, ((w - s) // 2, (h - s) // 2), icon)
    img.save(path)
print("iconos y splash listos")
