"""Genera los iconos y la pantalla de arranque de Android con el mismo diseño que biblioscan.ico.
    python make-icons.py
"""
import glob
import os
from PIL import Image, ImageDraw, ImageFont

RES = os.path.join(os.path.dirname(os.path.abspath(__file__)), "android", "app", "src", "main", "res")
ORANGE, INK, PAPER = "#ff4f12", "#121212", "#ecebe6"


def font(px):
    try:
        return ImageFont.truetype("arialbd.ttf", px)
    except OSError:
        return ImageFont.load_default()


def mark(d, cx, cy, s, color):
    """'B/S' + la barrita de 'código de barras', centrado en (cx, cy) con alto de referencia s."""
    d.text((cx, cy - s * 0.06), "B/S", fill=color, font=font(int(s * 0.42)), anchor="mm")
    d.rectangle([cx - s * 0.36, cy + s * 0.25, cx + s * 0.36, cy + s * 0.30], fill=color)


def legacy(size, round_):
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    if round_:
        d.ellipse([0, 0, size - 1, size - 1], fill=ORANGE)
    else:
        d.rounded_rectangle([0, 0, size - 1, size - 1], radius=size * 0.12, fill=ORANGE)
    mark(d, size / 2, size / 2, size * 0.82, INK)
    return img


def foreground(size):  # icono adaptativo: el dibujo dentro de la zona segura (66 % central)
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    mark(ImageDraw.Draw(img), size / 2, size / 2, size * 0.58, INK)
    return img


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
    d = ImageDraw.Draw(img)
    s = min(w, h) * 0.32
    d.rectangle([w / 2 - s / 2, h / 2 - s / 2, w / 2 + s / 2, h / 2 + s / 2], fill=ORANGE)
    mark(d, w / 2, h / 2, s * 0.9, INK)
    img.save(path)
print("iconos y splash listos")
