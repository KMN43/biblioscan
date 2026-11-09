"""BIBLIO/SCAN — servidor local con base de datos SQLite.

Sirve index.html y una pequeña API:
  GET    /api/books               -> lista de libros (JSON)   ?download=1 para descargar
  POST   /api/books               -> guarda / actualiza un libro (JSON)
  DELETE /api/books/<isbn>        -> borra un libro
  GET    /api/export.csv          -> exporta el catálogo a CSV (para Excel)
  GET    /api/lookup?isbn=...     -> busca el libro en Google Books, todostuslibros y Open Library
  GET    /api/library             -> estanterías de la pestaña Biblioteca
  PUT    /api/library             -> guarda las estanterías {shelves:[{id,label,x,y,w,h,books:[[isbn…] por balda]}]}

Uso:  python server.py      y abre http://localhost:8765
Solo usa la librería estándar de Python. Los datos quedan en biblioteca.db.

Opcional: Google Books limita mucho las peticiones anónimas (error 429). Con una clave
gratuita de Google Cloud (API "Books API") desaparece el límite:
    set GOOGLE_BOOKS_API_KEY=tu_clave      (PowerShell: $env:GOOGLE_BOOKS_API_KEY="tu_clave")
"""
import csv
import html
import io
import json
import os
import re
import sqlite3
import sys
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, quote, unquote, urlparse

FROZEN = getattr(sys, "frozen", False)  # dentro de BiblioScan.exe (PyInstaller)
# la web va empaquetada dentro del .exe; la base de datos queda junto al .exe para que no se pierda
ROOT = getattr(sys, "_MEIPASS", os.path.dirname(os.path.abspath(__file__)))
DATA_DIR = os.path.dirname(sys.executable) if FROZEN else ROOT
DB_PATH = os.environ.get("BIBLIO_DB") or os.path.join(DATA_DIR, "biblioteca.db")
PORT = int(os.environ.get("BIBLIO_PORT", 8765))
FIELDS = ["isbn", "title", "subtitle", "authors", "publisher", "year", "pages",
          "language", "cover_url", "source", "notes"]
GOOGLE_KEY = os.environ.get("GOOGLE_BOOKS_API_KEY", "").strip()
UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) BiblioScan/1.0"


# ---------------------------------------------------------------- búsqueda ISBN
def http_get(url, timeout=8):
    req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept-Language": "es-ES,es;q=0.9"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.geturl(), r.read().decode("utf-8", "replace")


def src_google(isbn):
    url = f"https://www.googleapis.com/books/v1/volumes?q=isbn:{isbn}"
    if GOOGLE_KEY:
        url += f"&key={quote(GOOGLE_KEY)}"
    _, body = http_get(url)
    items = json.loads(body).get("items") or []
    if not items:
        return None
    v = items[0]["volumeInfo"]
    return {
        "title": v.get("title"), "subtitle": v.get("subtitle"),
        "authors": ", ".join(v.get("authors") or []), "publisher": v.get("publisher"),
        "year": (re.search(r"\d{4}", v.get("publishedDate") or "") or [None])[0],
        "pages": v.get("pageCount"), "language": v.get("language"),
        "cover_url": (v.get("imageLinks") or {}).get("thumbnail", "").replace("http:", "https:"),
    }


def src_openlibrary(isbn):
    _, body = http_get(f"https://openlibrary.org/api/books?bibkeys=ISBN:{isbn}&format=json&jscmd=data")
    b = json.loads(body).get(f"ISBN:{isbn}")
    if not b:
        return None
    return {
        "title": b.get("title"), "subtitle": b.get("subtitle"),
        "authors": ", ".join(a["name"] for a in b.get("authors", [])),
        "publisher": ", ".join(p["name"] for p in b.get("publishers", [])),
        "year": (re.search(r"\d{4}", b.get("publish_date") or "") or [None])[0],
        "pages": b.get("number_of_pages"), "cover_url": (b.get("cover") or {}).get("medium"),
    }


def _clean(s):
    return re.sub(r"\s+", " ", html.unescape(re.sub(r"<[^>]+>", " ", s or ""))).strip()


def src_todostuslibros(isbn):
    """Catálogo de las librerías españolas (CEGAL): muy completo para libros editados en España."""
    final_url, page = http_get(f"https://www.todostuslibros.com/busquedas?keyword={isbn}")
    # la búsqueda redirige a la ficha solo si encuentra el ISBN exacto
    if isbn not in re.sub(r"\D", "", final_url) and isbn not in re.sub(r"\D", "", page[:200000]):
        return None
    title = re.search(r'<h1 class="title">([\s\S]*?)</h1>', page)
    if not title:
        return None
    authors = re.findall(r'<a[^>]*class="author"[^>]*>([\s\S]*?)</a>', page)
    facts = {_clean(k).rstrip(" :"): _clean(v) for k, v in re.findall(r"<dt>([\s\S]*?)</dt>\s*<dd>([\s\S]*?)</dd>", page)}
    get = lambda *keys: next((v for k, v in facts.items() for key in keys if key.lower() in k.lower() and v), None)
    cover = re.search(r'<meta property="og:image" content="([^"]+)"', page)
    return {
        "title": _clean(title.group(1)),
        # fuera traductores, ilustradores, prologuistas… ("Trad. Fulano", "Il. Mengano")
        "authors": ", ".join(dict.fromkeys(
            _clean(a) for a in authors
            if _clean(a) and not re.match(r"(?i)(trad|tr|il|ilus|ilustr|ed|pr[oó]l|coord|sel|adapt|introd?)\.?\s", _clean(a)))),
        "publisher": get("Editorial"),
        "year": (re.search(r"\d{4}", get("Fecha") or "") or [None])[0],
        "pages": (re.search(r"\d+", get("Páginas", "paginas") or "") or [None])[0],
        "language": get("Idioma de publicación"),
        "cover_url": cover.group(1) if cover else None,
    }


SOURCES = {"Google Books": src_google, "todostuslibros": src_todostuslibros, "Open Library": src_openlibrary}
_cache = {}


def lookup(isbn):
    if isbn in _cache:
        return _cache[isbn]
    results, errors = {}, {}

    def run(name):
        try:
            return name, SOURCES[name](isbn), None
        except urllib.error.HTTPError as e:
            return name, None, f"error {e.code}" + (" (límite de peticiones)" if e.code == 429 else "")
        except Exception as e:  # red caída, timeout, HTML inesperado…
            return name, None, type(e).__name__

    with ThreadPoolExecutor(len(SOURCES)) as pool:
        for name, data, err in pool.map(run, SOURCES):
            if data:
                results[name] = data
            elif err:
                errors[name] = err
    # prioridad: para libros españoles (978-84) manda todostuslibros
    order = ["todostuslibros", "Google Books", "Open Library"] if isbn.startswith("97884") \
        else ["Google Books", "todostuslibros", "Open Library"]
    merged = {}
    for f in ["title", "subtitle", "authors", "publisher", "year", "pages", "language", "cover_url"]:
        merged[f] = next((str(results[s][f]) for s in order if s in results and results[s].get(f)), "")
    out = {"found": bool(results), "book": merged, "sources": [s for s in order if s in results], "errors": errors}
    if results:  # no cachear fallos: puede ser un 429 temporal
        _cache[isbn] = out
    return out


def connect():
    con = sqlite3.connect(DB_PATH)
    con.row_factory = sqlite3.Row
    return con


def init_db():
    with connect() as con:
        con.execute("""
            CREATE TABLE IF NOT EXISTS books (
                isbn       TEXT PRIMARY KEY,
                title      TEXT NOT NULL,
                subtitle   TEXT,
                authors    TEXT,
                publisher  TEXT,
                year       TEXT,
                pages      TEXT,
                language   TEXT,
                cover_url  TEXT,
                source     TEXT,
                notes      TEXT,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            )""")
        # disposición de la pestaña Biblioteca (estanterías + qué libros hay en cada una), como JSON
        con.execute("CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL)")


def get_library():
    with connect() as con:
        r = con.execute("SELECT value FROM kv WHERE key = 'library'").fetchone()
    return json.loads(r["value"]) if r else {"shelves": []}


def clean_library(data):
    isbn = lambda i: re.sub(r"[^0-9X]", "", str(i).upper())[:13]

    def entry(e):  # [isbn, x en px dentro de la balda]  (versiones anteriores: solo el isbn)
        if isinstance(e, list) and e:
            try:
                return [isbn(e[0]), max(0, min(8000, int(float(e[1]) if len(e) > 1 else 0)))]
            except (TypeError, ValueError):
                return [isbn(e[0]), 0]
        return isbn(e)
    shelves = []
    for s in (data or {}).get("shelves", [])[:200]:
        rows = s.get("books", [])
        if rows and (not isinstance(rows[0], list) or (len(rows[0]) == 2 and isinstance(rows[0][1], (int, float)))):
            rows = [rows]  # formato antiguo: una sola balda
        shelves.append({
            "id": str(s.get("id", ""))[:40],
            "label": str(s.get("label", ""))[:60],
            **{k: max(0, min(400, int(s.get(k, 0)))) for k in ("x", "y", "w", "h")},
            "books": [[e for e in map(entry, row) if (e[0] if isinstance(e, list) else e)][:500]
                      for row in rows[:60] if isinstance(row, list)],  # una lista por balda
        })
    return {"shelves": shelves}


def all_books():
    with connect() as con:
        return [dict(r) for r in con.execute("SELECT * FROM books ORDER BY updated_at DESC")]


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=ROOT, **kwargs)

    def end_headers(self):
        # sin esto el navegador puede seguir mostrando una versión vieja de la página tras actualizarla
        self.send_header("Cache-Control", "no-cache")
        super().end_headers()

    def log_message(self, fmt, *args):  # solo registra las llamadas a la API
        if "/api/" in self.path:
            super().log_message(fmt, *args)

    def send_json(self, obj, code=200, download=None):
        body = json.dumps(obj, ensure_ascii=False, indent=2).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        if download:
            self.send_header("Content-Disposition", f'attachment; filename="{download}"')
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        url = urlparse(self.path)
        if url.path == "/api/books":
            dl = "download" in parse_qs(url.query)
            return self.send_json(all_books(), download="biblioteca.json" if dl else None)
        if url.path == "/api/library":
            return self.send_json(get_library())
        if url.path == "/api/lookup":
            isbn = re.sub(r"\D", "", (parse_qs(url.query).get("isbn") or [""])[0])
            if len(isbn) != 13:
                return self.send_json({"error": "ISBN-13 no válido"}, 400)
            return self.send_json(lookup(isbn))
        if url.path == "/api/export.csv":
            buf = io.StringIO()
            w = csv.writer(buf, delimiter=";")  # ";" para que Excel en español lo abra en columnas
            cols = FIELDS + ["created_at", "updated_at"]
            w.writerow(cols)
            for b in all_books():
                w.writerow([b.get(c) or "" for c in cols])
            body = ("﻿" + buf.getvalue()).encode("utf-8")  # BOM: acentos correctos en Excel
            self.send_response(200)
            self.send_header("Content-Type", "text/csv; charset=utf-8")
            self.send_header("Content-Disposition", 'attachment; filename="biblioteca.csv"')
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            return self.wfile.write(body)
        if url.path.endswith((".db", ".py")):
            return self.send_error(404)
        return super().do_GET()

    def do_PUT(self):
        if urlparse(self.path).path != "/api/library":
            return self.send_error(404)
        try:
            data = clean_library(json.loads(self.rfile.read(int(self.headers.get("Content-Length", 0))) or b"{}"))
        except (json.JSONDecodeError, TypeError, ValueError):
            return self.send_json({"error": "JSON no válido"}, 400)
        with connect() as con:
            con.execute("INSERT INTO kv (key, value) VALUES ('library', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                        (json.dumps(data, ensure_ascii=False),))
        return self.send_json({"ok": True, "shelves": len(data["shelves"])})

    def do_POST(self):
        if urlparse(self.path).path != "/api/books":
            return self.send_error(404)
        try:
            data = json.loads(self.rfile.read(int(self.headers.get("Content-Length", 0))) or b"{}")
        except json.JSONDecodeError:
            return self.send_json({"error": "JSON no válido"}, 400)
        isbn = re.sub(r"[^0-9X]", "", str(data.get("isbn", "")).upper())
        title = str(data.get("title", "")).strip()
        if len(isbn) not in (10, 13):
            return self.send_json({"error": "ISBN no válido"}, 400)
        if not title:
            return self.send_json({"error": "El título es obligatorio"}, 400)
        now = datetime.now().isoformat(timespec="seconds")
        row = {f: str(data.get(f) or "").strip() for f in FIELDS}
        row.update(isbn=isbn, title=title)
        with connect() as con:
            con.execute(f"""
                INSERT INTO books ({", ".join(FIELDS)}, created_at, updated_at)
                VALUES ({", ".join("?" * len(FIELDS))}, ?, ?)
                ON CONFLICT(isbn) DO UPDATE SET
                  {", ".join(f"{f}=excluded.{f}" for f in FIELDS if f != "isbn")},
                  updated_at=excluded.updated_at""",
                [row[f] for f in FIELDS] + [now, now])
        return self.send_json({"ok": True, "book": row})

    def do_DELETE(self):
        path = urlparse(self.path).path
        if not path.startswith("/api/books/"):
            return self.send_error(404)
        isbn = unquote(path.rsplit("/", 1)[1])
        with connect() as con:
            n = con.execute("DELETE FROM books WHERE isbn = ?", (isbn,)).rowcount
        return self.send_json({"ok": bool(n)})


def make_server(port=PORT):
    init_db()
    return ThreadingHTTPServer(("127.0.0.1", port), Handler)


if __name__ == "__main__":
    httpd = make_server()
    print(f"BIBLIO/SCAN en http://localhost:{PORT}  ·  base de datos: {DB_PATH}")
    print("Google Books:", "con clave de API" if GOOGLE_KEY else "sin clave (puede dar error 429)")
    httpd.serve_forever()
