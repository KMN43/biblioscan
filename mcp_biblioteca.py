"""BIBLIO/SCAN — conector MCP (solo lectura) para consultar el catálogo desde la app de Claude.

La app de Claude lo arranca por su cuenta y habla con él por stdin/stdout (JSON-RPC, protocolo MCP).
No necesita librerías externas. Abre biblioteca.db en modo SOLO LECTURA: no puede modificar nada.

Prueba manual:  python mcp_biblioteca.py --test
"""
import json
import os
import re
import sqlite3
import sys
import unicodedata

HERE = os.path.dirname(os.path.abspath(__file__))
DB_PATH = os.environ.get("BIBLIO_DB") or os.path.join(HERE, "biblioteca.db")
COLS = ["isbn", "title", "subtitle", "authors", "publisher", "year", "pages", "language", "notes", "cover_url", "updated_at"]


def norm(s):
    s = unicodedata.normalize("NFD", str(s or ""))
    return "".join(c for c in s if unicodedata.category(c) != "Mn").lower()


def connect():
    if not os.path.exists(DB_PATH):
        raise RuntimeError(f"No encuentro la base de datos en {DB_PATH}")
    con = sqlite3.connect(f"file:{DB_PATH}?mode=ro", uri=True)
    con.row_factory = sqlite3.Row
    con.create_function("norm", 1, norm, deterministic=True)
    return con


def year_int(y):
    m = re.search(r"\d{4}", str(y or ""))
    return int(m.group()) if m else None


def shelves():
    """Estanterías de la pestaña Biblioteca: [{label, books:[isbn]}]."""
    with connect() as con:
        try:
            r = con.execute("SELECT value FROM kv WHERE key = 'library'").fetchone()
        except sqlite3.OperationalError:  # base de datos de antes de la pestaña Biblioteca
            return []
    out = json.loads(r["value"]).get("shelves", []) if r else []
    for s in out:  # books = una lista por balda de [isbn, x] (versiones anteriores: isbn sueltos)
        rows = s.get("books", [])
        flat = rows and (not isinstance(rows[0], list) or (len(rows[0]) == 2 and isinstance(rows[0][1], (int, float))))
        rows = [rows] if flat else rows
        s["rows"] = [[e[0] if isinstance(e, list) else e for e in sorted(row, key=lambda e: e[1] if isinstance(e, list) else 0)]
                     for row in rows]
        s["books"] = [i for row in s["rows"] for i in row]
    return out


def shelf_of():
    out = {}
    for s in shelves():
        for r, row in enumerate(s["rows"]):
            for i, isbn in enumerate(row):
                out[isbn] = f"{s.get('label') or 'Sin etiqueta'} · balda {r + 1} · posición {i + 1}"
    return out


def fmt(b, full=False, where=None):
    d = {k: b[k] for k in COLS if b[k] not in (None, "")}
    if not full:
        d.pop("cover_url", None)
    if where is not None:
        d["estanteria"] = where.get(b["isbn"], "sin clasificar (en el montón)")
    return d


def list_shelves():
    with connect() as con:
        titles = {r["isbn"]: r["title"] for r in con.execute("SELECT isbn, title FROM books")}
    sh = shelves()
    placed = {i for s in sh for i in s.get("books", [])}
    return {"estanterias": [{"etiqueta": s.get("label") or "Sin etiqueta", "libros": len(s.get("books", [])),
                             "titulos": [titles.get(i, i) for i in s.get("books", []) if i in titles]} for s in sh],
            "sin_clasificar": len([i for i in titles if i not in placed])}


# ------------------------------------------------------------------ herramientas
def search_books(query="", author="", publisher="", language="", year_from=None, year_to=None,
                 missing=None, shelf="", sort="updated_at", limit=50):
    where, args = [], []
    for term in norm(query).split():
        where.append("norm(coalesce(title,'')||' '||coalesce(subtitle,'')||' '||coalesce(authors,'')||' '||"
                     "coalesce(publisher,'')||' '||coalesce(isbn,'')||' '||coalesce(notes,'')) LIKE ?")
        args.append(f"%{term}%")
    for col, val in (("authors", author), ("publisher", publisher), ("language", language)):
        if val:
            where.append(f"norm({col}) LIKE ?")
            args.append(f"%{norm(val)}%")
    if missing in ("cover_url", "year", "pages", "authors", "publisher", "language"):
        where.append(f"coalesce({missing},'') = ''")
    order = {"updated_at": "updated_at DESC", "title": "norm(title)", "authors": "norm(authors)",
             "year": "year DESC", "year_asc": "year", "pages": "CAST(pages AS INTEGER) DESC"}.get(sort, "updated_at DESC")
    sql = f"SELECT * FROM books {'WHERE ' + ' AND '.join(where) if where else ''} ORDER BY {order}"
    with connect() as con:
        rows = con.execute(sql, args).fetchall()
    if year_from or year_to:
        lo, hi = int(year_from or 0), int(year_to or 9999)
        rows = [r for r in rows if (y := year_int(r["year"])) and lo <= y <= hi]
    limit = max(1, min(int(limit or 50), 500))
    where = shelf_of()
    if shelf:
        rows = [r for r in rows if norm(shelf) in norm(where.get(r["isbn"], "sin clasificar"))]
    return {"total": len(rows), "mostrando": min(len(rows), limit), "libros": [fmt(r, where=where) for r in rows[:limit]]}


def get_book(isbn):
    isbn = re.sub(r"[^0-9X]", "", str(isbn).upper())
    with connect() as con:
        r = con.execute("SELECT * FROM books WHERE isbn = ?", (isbn,)).fetchone()
    return fmt(r, full=True, where=shelf_of()) if r else {"error": f"No hay ningún libro con ISBN {isbn} en el catálogo"}


def library_stats():
    with connect() as con:
        rows = con.execute("SELECT * FROM books").fetchall()
    count = lambda key: sorted(((k, v) for k, v in _tally(rows, key).items()), key=lambda x: -x[1])
    years = [y for r in rows if (y := year_int(r["year"]))]
    decades = {}
    for y in years:
        decades[f"{y // 10 * 10}s"] = decades.get(f"{y // 10 * 10}s", 0) + 1
    return {
        "libros": len(rows),
        "paginas_totales": sum(int(r["pages"]) for r in rows if str(r["pages"] or "").isdigit()),
        "periodo": f"{min(years)}–{max(years)}" if years else None,
        "por_decada": dict(sorted(decades.items())),
        "autores_top": count("authors")[:15],
        "editoriales_top": count("publisher")[:15],
        "idiomas": count("language"),
        "sin_datos": {f: sum(1 for r in rows if not r[f]) for f in ("cover_url", "year", "pages", "authors", "publisher")},
        "ultimos_añadidos": [fmt(r) for r in sorted(rows, key=lambda r: r["updated_at"] or "", reverse=True)[:5]],
    }


def _tally(rows, key):
    out = {}
    for r in rows:
        vals = re.split(r"\s*[,;]\s*", r[key]) if key == "authors" and r[key] else [r[key] or "—"]
        for v in vals:
            if v:
                out[v] = out.get(v, 0) + 1
    return out


def list_values(field):
    col = {"authors": "authors", "autores": "authors", "publishers": "publisher", "editoriales": "publisher",
           "languages": "language", "idiomas": "language"}.get(field)
    if not col:
        return {"error": "field debe ser authors, publishers o languages"}
    with connect() as con:
        rows = con.execute("SELECT * FROM books").fetchall()
    return dict(sorted(_tally(rows, col).items(), key=lambda x: (-x[1], norm(x[0]))))


STR, INT = {"type": "string"}, {"type": "integer"}
TOOLS = {
    "search_books": (search_books, "Busca libros en el catálogo personal del usuario (su biblioteca física). "
                     "Todos los filtros son opcionales y combinables; la búsqueda ignora mayúsculas y tildes. "
                     "Sin filtros devuelve los últimos añadidos.", {
        "query": {**STR, "description": "Palabras a buscar en título, subtítulo, autor, editorial, ISBN y notas"},
        "author": {**STR, "description": "Filtrar por autor (coincidencia parcial)"},
        "publisher": {**STR, "description": "Filtrar por editorial (coincidencia parcial)"},
        "language": {**STR, "description": "Filtrar por idioma, p. ej. 'castellano', 'es', 'inglés'"},
        "year_from": {**INT, "description": "Año de edición mínimo"},
        "year_to": {**INT, "description": "Año de edición máximo"},
        "missing": {**STR, "enum": ["cover_url", "year", "pages", "authors", "publisher", "language"],
                    "description": "Solo libros a los que les falta este dato"},
        "shelf": {**STR, "description": "Solo libros de la estantería con esta etiqueta (p. ej. 'Fantasía'); 'sin clasificar' para los del montón"},
        "sort": {**STR, "enum": ["updated_at", "title", "authors", "year", "year_asc", "pages"], "description": "Orden"},
        "limit": {**INT, "description": "Máximo de resultados (por defecto 50, máx. 500)"},
    }, []),
    "get_book": (get_book, "Ficha completa de un libro del catálogo por su ISBN.",
                 {"isbn": {**STR, "description": "ISBN-10 o ISBN-13"}}, ["isbn"]),
    "library_stats": (library_stats, "Resumen del catálogo: número de libros, páginas, periodo, libros por década, "
                      "autores y editoriales más frecuentes, idiomas, fichas incompletas y últimos añadidos.", {}, []),
    "list_shelves": (list_shelves, "Estanterías físicas que el usuario ha organizado en la pestaña Biblioteca: etiqueta, "
                     "cuántos libros tiene y sus títulos en orden, más cuántos libros quedan sin clasificar.", {}, []),
    "list_values": (list_values, "Lista todos los autores, editoriales o idiomas del catálogo con cuántos libros tiene cada uno.",
                    {"field": {**STR, "enum": ["authors", "publishers", "languages"]}}, ["field"]),
}


# ------------------------------------------------------------------ protocolo MCP (stdio)
def handle(msg):
    method, mid, params = msg.get("method"), msg.get("id"), msg.get("params") or {}
    if mid is None:  # notificaciones (initialized, cancelled…): no se responden
        return None
    ok = lambda result: {"jsonrpc": "2.0", "id": mid, "result": result}
    if method == "initialize":
        return ok({"protocolVersion": params.get("protocolVersion", "2025-06-18"),
                   "capabilities": {"tools": {}},
                   "serverInfo": {"name": "biblioteca", "version": "1.0.0"},
                   "instructions": "Catálogo de la biblioteca personal del usuario (libros físicos que tiene en casa). "
                                   "Úsalo cuando pregunte qué libros tiene, de qué autor, editorial o época, o pida recomendaciones de su propia biblioteca."})
    if method == "ping":
        return ok({})
    if method == "tools/list":
        return ok({"tools": [{"name": n, "description": d, "annotations": {"readOnlyHint": True},
                              "inputSchema": {"type": "object", "properties": p, "required": req}}
                             for n, (_, d, p, req) in TOOLS.items()]})
    if method == "tools/call":
        name, args = params.get("name"), params.get("arguments") or {}
        if name not in TOOLS:
            return {"jsonrpc": "2.0", "id": mid, "error": {"code": -32602, "message": f"Herramienta desconocida: {name}"}}
        try:
            data = TOOLS[name][0](**args)
            return ok({"content": [{"type": "text", "text": json.dumps(data, ensure_ascii=False, indent=1)}]})
        except Exception as e:
            return ok({"content": [{"type": "text", "text": f"Error: {e}"}], "isError": True})
    return {"jsonrpc": "2.0", "id": mid, "error": {"code": -32601, "message": f"Método no soportado: {method}"}}


def main():
    sys.stdin.reconfigure(encoding="utf-8")
    sys.stdout.reconfigure(encoding="utf-8", newline="\n")
    for line in sys.stdin:
        line = line.lstrip("﻿").strip()
        if not line:
            continue
        try:
            msg = json.loads(line)
        except json.JSONDecodeError:
            continue
        for m in (msg if isinstance(msg, list) else [msg]):
            resp = handle(m)
            if resp is not None:
                sys.stdout.write(json.dumps(resp, ensure_ascii=False) + "\n")
                sys.stdout.flush()


if __name__ == "__main__":
    if "--test" in sys.argv:
        sys.stdout.reconfigure(encoding="utf-8")
        print("Base de datos:", DB_PATH)
        s = library_stats()
        print(f"{s['libros']} libros · {s['paginas_totales']} páginas · {s['periodo']}")
        print("Autores top:", s["autores_top"][:5])
        print("Búsqueda 'garcia':", [b["title"] for b in search_books("garcia")["libros"]][:5])
    else:
        main()
