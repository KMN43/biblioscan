"""Logo de BiblioScan: libro abierto (páginas con cuarto de círculo hacia el lomo, base recta) con una estrella
de cuatro puntas recortada. Una sola geometría para el SVG, el icono del .exe y los iconos de Android.

    python logo.py        # escribe docs/img/logo.svg y docs/img/logo.png
"""
import math
import os

ORANGE, INK, CREAM = "#ff4f12", "#121212", "#fff4e1"

# --- geometría en unidades del dibujo (libro de -46 a 46 en x, de -28 a 30 en y) ---
BOOK_D = "M-46 30 L-46 -28 L-27 -28 A24 24 0 0 1 -3 -4 L0 1 L3 -4 A24 24 0 0 1 27 -28 L46 -28 L46 30 Z"
STAR_S, STAR_Y = .85, 9          # estrella: puntas a 22·0.85, centrada 9 por debajo del centro
VIEW = (-50, -32, 100, 66)       # viewBox del SVG (con un poco de aire)


def _star_pts():
    s, y0, P = STAR_S, STAR_Y, []
    tips = [(0, -22), (22, 0), (0, 22), (-22, 0)]
    ctrl = [(2.6, -2.6), (2.6, 2.6), (-2.6, 2.6), (-2.6, -2.6)]
    for i in range(4):
        a, c, b = tips[i], ctrl[i], tips[(i + 1) % 4]
        for k in range(24):
            t = k / 24
            x = (1 - t) ** 2 * a[0] + 2 * (1 - t) * t * c[0] + t * t * b[0]
            y = (1 - t) ** 2 * a[1] + 2 * (1 - t) * t * c[1] + t * t * b[1]
            P.append((x * s, y * s + y0))
    return P


def _arc(cx, cy, r, a0, a1, n=32):
    return [(cx + r * math.cos(math.radians(a0 + (a1 - a0) * k / n)), cy + r * math.sin(math.radians(a0 + (a1 - a0) * k / n))) for k in range(n + 1)]


def _book_pts():
    return ([(-46, 30), (-46, -28)] + _arc(-27, -4, 24, -90, 0) + [(0, 1)]
            + _arc(27, -4, 24, 180, 270) + [(46, -28), (46, 30)])


def star_svg_d():
    s, y0 = STAR_S, STAR_Y
    f = lambda x, y: f"{x * s:.2f} {y * s + y0:.2f}"
    return (f"M{f(0, -22)} Q{f(2.6, -2.6)} {f(22, 0)} Q{f(2.6, 2.6)} {f(0, 22)} "
            f"Q{f(-2.6, 2.6)} {f(-22, 0)} Q{f(-2.6, -2.6)} {f(0, -22)} Z")


def svg(color="currentColor", size=None):
    """El logo como SVG de un solo trazado (la estrella es un hueco: se ve el fondo)."""
    w = f' width="{size}" height="{size * VIEW[3] / VIEW[2]:.0f}"' if size else ""
    return (f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="{" ".join(map(str, VIEW))}"{w} role="img" aria-label="BiblioScan">'
            f'<path fill="{color}" fill-rule="evenodd" d="{BOOK_D} {star_svg_d()}"/></svg>')


def render(size, bg=ORANGE, fg=INK, shape="rounded", mark=.64, radius=.22, star=None):
    """Icono cuadrado de `size` px: fondo (`rounded`, `circle`, `square` o None = transparente) y el logo
    ocupando `mark` del ancho. La estrella se pinta con `star` (por defecto, el color del fondo)."""
    from PIL import Image, ImageDraw
    k = 4                                   # supermuestreo para bordes suaves
    S = size * k
    img = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    if shape == "rounded":
        d.rounded_rectangle([0, 0, S - 1, S - 1], radius=S * radius, fill=bg)
    elif shape == "circle":
        d.ellipse([0, 0, S - 1, S - 1], fill=bg)
    elif shape == "square":
        d.rectangle([0, 0, S - 1, S - 1], fill=bg)
    u = S * mark / 92                       # px por unidad (el libro mide 92 de ancho)
    cy = S / 2 - u * 1                      # el libro va de -28 a 30: centro óptico en y = 1
    T = lambda pts: [(S / 2 + x * u, cy + y * u) for x, y in pts]
    d.polygon(T(_book_pts()), fill=fg)
    d.polygon(T(_star_pts()), fill=star or bg or (0, 0, 0, 0))
    return img.resize((size, size), Image.LANCZOS)


if __name__ == "__main__":
    here = os.path.dirname(os.path.abspath(__file__))
    out = os.path.join(here, "docs", "img")
    with open(os.path.join(out, "logo.svg"), "w", encoding="utf-8") as f:
        f.write(svg(INK) + "\n")
    render(512).save(os.path.join(out, "logo.png"))
    print("docs/img/logo.svg y docs/img/logo.png listos")
