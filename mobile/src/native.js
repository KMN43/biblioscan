/* BIBLIO/SCAN — capa móvil.
 *
 * En el móvil no hay server.py: este archivo intercepta las llamadas a /api/... que hace index.html
 * y las resuelve en el propio teléfono.
 *   · Base de datos: SQLite (sql.js) con el MISMO esquema que biblioteca.db → se importa/exporta tal cual.
 *     El archivo se guarda en IndexedDB, dentro de los datos privados de la app.
 *   · Búsqueda de ISBN: Google Books, todostuslibros y Open Library con peticiones nativas (CapacitorHttp),
 *     que no sufren las restricciones CORS del navegador.
 *   · Exportar: CSV / JSON / .db mediante el menú "compartir" de Android.
 * En un navegador normal (para pruebas) funciona igual, salvo todostuslibros, que bloquea CORS.
 */
(() => {
  'use strict';
  const CAP = window.capacitorExports;
  const NATIVE = !!CAP?.Capacitor?.isNativePlatform?.();
  const Http = NATIVE ? CAP.CapacitorHttp : null;
  const Filesystem = NATIVE ? CAP.registerPlugin('Filesystem') : null;
  const Share = NATIVE ? CAP.registerPlugin('Share') : null;
  window.BIBLIO_MOBILE = { native: NATIVE };

  // ------------------------------------------------------------ base de datos
  const FIELDS = ['isbn', 'title', 'subtitle', 'authors', 'publisher', 'year', 'pages', 'language', 'cover_url', 'source', 'notes'];
  const SCHEMA = `
    CREATE TABLE IF NOT EXISTS books (
      isbn TEXT PRIMARY KEY, title TEXT NOT NULL, subtitle TEXT, authors TEXT, publisher TEXT, year TEXT, pages TEXT,
      language TEXT, cover_url TEXT, source TEXT, notes TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS wishlist (
      isbn TEXT PRIMARY KEY, title TEXT NOT NULL, subtitle TEXT, authors TEXT, publisher TEXT, year TEXT, pages TEXT,
      language TEXT, cover_url TEXT, source TEXT, notes TEXT, created_at TEXT NOT NULL);`;
  const DB_KEY = 'biblioteca.db';

  const idb = new Promise((res, rej) => {
    const r = indexedDB.open('biblioscan', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('files');
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
  const idbOp = (mode, fn) => idb.then(d => new Promise((res, rej) => {
    const tx = d.transaction('files', mode), req = fn(tx.objectStore('files'));
    tx.oncomplete = () => res(req.result); tx.onerror = () => rej(tx.error);
  }));
  const idbGet = k => idbOp('readonly', s => s.get(k));
  const idbPut = (k, v) => idbOp('readwrite', s => s.put(v, k));

  let SQL, db;
  const ready = (async () => {
    SQL = await initSqlJs({ locateFile: f => 'vendor/' + f });
    const saved = await idbGet(DB_KEY).catch(() => null);
    db = saved ? new SQL.Database(saved) : new SQL.Database();
    db.run(SCHEMA);
  })();

  let saveT = 0;
  const flush = () => { clearTimeout(saveT); saveT = 0; return idbPut(DB_KEY, db.export()); };
  const persist = () => { clearTimeout(saveT); saveT = setTimeout(flush, 200); };
  document.addEventListener('visibilitychange', () => { if (document.hidden && saveT) flush(); });

  function rows(sql, params = []) {
    const st = db.prepare(sql), out = [];
    st.bind(params);
    while (st.step()) out.push(st.getAsObject());
    st.free();
    return out;
  }
  const allBooks = () => rows('SELECT * FROM books ORDER BY updated_at DESC');
  const nowIso = () => {
    const d = new Date(), p = n => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
  };
  const cleanIsbn = s => String(s ?? '').toUpperCase().replace(/[^0-9X]/g, '');

  function upsertBook(data, keepDates = false) {
    const row = {};
    FIELDS.forEach(f => { row[f] = String(data[f] ?? '').trim(); });
    row.isbn = cleanIsbn(data.isbn); row.title = String(data.title ?? '').trim();
    const now = nowIso();
    const created = keepDates && data.created_at ? String(data.created_at) : now;
    const updated = keepDates && data.updated_at ? String(data.updated_at) : now;
    db.run(`INSERT INTO books (${FIELDS.join(', ')}, created_at, updated_at) VALUES (${FIELDS.map(() => '?').join(', ')}, ?, ?)
            ON CONFLICT(isbn) DO UPDATE SET ${FIELDS.filter(f => f !== 'isbn').map(f => `${f}=excluded.${f}`).join(', ')},
            updated_at=excluded.updated_at`, [...FIELDS.map(f => row[f]), created, updated]);
    return row;
  }

  // --- wishlist: libros consultados que quieres tener (tabla aparte; BiblioScan.exe la ignora) ---
  const wlAll = () => { try { return rows('SELECT * FROM wishlist ORDER BY created_at DESC'); } catch { return []; } };
  const wlGet = isbn => { try { return rows('SELECT * FROM wishlist WHERE isbn = ?', [cleanIsbn(isbn)])[0] || null; } catch { return null; } };
  function wlPut(b, keepDate = false) {
    const row = {}; FIELDS.forEach(f => { row[f] = String(b[f] ?? '').trim(); });
    row.isbn = cleanIsbn(b.isbn); if (!row.title) row.title = 'ISBN ' + row.isbn;
    db.run(`INSERT INTO wishlist (${FIELDS.join(', ')}, created_at) VALUES (${FIELDS.map(() => '?').join(', ')}, ?)
            ON CONFLICT(isbn) DO UPDATE SET ${FIELDS.filter(f => f !== 'isbn').map(f => `${f}=excluded.${f}`).join(', ')}`,
      [...FIELDS.map(f => row[f]), keepDate && b.created_at ? String(b.created_at) : nowIso()]);
    persist();
  }
  const wlDel = isbn => { db.run('DELETE FROM wishlist WHERE isbn = ?', [cleanIsbn(isbn)]); persist(); };

  function getLibrary() {
    const r = rows("SELECT value FROM kv WHERE key = 'library'")[0];
    return r ? JSON.parse(r.value) : { shelves: [] };
  }
  function setLibrary(lib) {
    db.run("INSERT INTO kv (key, value) VALUES ('library', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", [JSON.stringify(lib)]);
  }
  function cleanLibrary(data) {   // igual que clean_library() de server.py
    const isbn = i => cleanIsbn(i).slice(0, 13);
    const clamp = (v, hi) => Math.max(0, Math.min(hi, Math.trunc(parseFloat(v)) || 0));
    const entry = e => Array.isArray(e) && e.length ? [isbn(e[0]), e.length > 1 ? clamp(e[1], 8000) : 0] : isbn(e);
    const shelves = [];
    for (const s of ((data || {}).shelves || []).slice(0, 200)) {
      let rws = s.books || [];
      if (rws.length && (!Array.isArray(rws[0]) || (rws[0].length === 2 && typeof rws[0][1] === 'number'))) rws = [rws];
      shelves.push({
        id: String(s.id ?? '').slice(0, 40), label: String(s.label ?? '').slice(0, 60),
        x: clamp(s.x, 400), y: clamp(s.y, 400), w: clamp(s.w, 400), h: clamp(s.h, 400),
        books: rws.slice(0, 60).filter(Array.isArray).map(row => row.map(entry).filter(e => Array.isArray(e) ? e[0] : e).slice(0, 500)),
      });
    }
    return { shelves };
  }

  // ------------------------------------------------------------ búsqueda ISBN
  const UA = 'Mozilla/5.0 (Linux; Android 14) BiblioScan/1.0';
  const HEADERS = { 'User-Agent': UA, 'Accept-Language': 'es-ES,es;q=0.9' };
  class HttpError extends Error { constructor(code) { super('error ' + code); this.code = code; } }
  const withTimeout = (p, ms = 9000) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('Timeout')), ms))]);

  async function httpGet(url) {
    if (Http) {
      const r = await withTimeout(Http.get({ url, headers: HEADERS, responseType: 'text', connectTimeout: 8000, readTimeout: 8000 }));
      if (r.status >= 400) throw new HttpError(r.status);
      return [r.url || url, typeof r.data === 'string' ? r.data : JSON.stringify(r.data)];
    }
    const r = await withTimeout(fetch(url));
    if (!r.ok) throw new HttpError(r.status);
    return [r.url, await r.text()];
  }
  const year4 = s => (String(s || '').match(/\d{4}/) || [null])[0];
  const decoder = document.createElement('textarea');
  const unescape = s => { decoder.innerHTML = s; return decoder.value; };
  const clean = s => unescape(String(s || '').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();

  async function srcGoogle(isbn) {
    const [, body] = await httpGet(`https://www.googleapis.com/books/v1/volumes?q=isbn:${isbn}`);
    const v = (JSON.parse(body).items || [])[0]?.volumeInfo;
    if (!v) return null;
    return {
      title: v.title, subtitle: v.subtitle, authors: (v.authors || []).join(', '), publisher: v.publisher,
      year: year4(v.publishedDate), pages: v.pageCount, language: v.language,
      cover_url: (v.imageLinks?.thumbnail || '').replace('http:', 'https:'),
    };
  }
  async function srcOpenLibrary(isbn) {
    const [, body] = await httpGet(`https://openlibrary.org/api/books?bibkeys=ISBN:${isbn}&format=json&jscmd=data`);
    const b = JSON.parse(body)[`ISBN:${isbn}`];
    if (!b) return null;
    return {
      title: b.title, subtitle: b.subtitle, authors: (b.authors || []).map(a => a.name).join(', '),
      publisher: (b.publishers || []).map(p => p.name).join(', '), year: year4(b.publish_date),
      pages: b.number_of_pages, cover_url: b.cover?.medium,
    };
  }
  async function srcTodostuslibros(isbn) {   // catálogo de las librerías españolas (CEGAL)
    const [finalUrl, page] = await httpGet(`https://www.todostuslibros.com/busquedas?keyword=${isbn}`);
    if (!finalUrl.replace(/\D/g, '').includes(isbn) && !page.slice(0, 200000).replace(/\D/g, '').includes(isbn)) return null;
    const title = page.match(/<h1 class="title">([\s\S]*?)<\/h1>/);
    if (!title) return null;
    const authors = [...page.matchAll(/<a[^>]*class="author"[^>]*>([\s\S]*?)<\/a>/g)].map(m => clean(m[1]));
    const facts = [...page.matchAll(/<dt>([\s\S]*?)<\/dt>\s*<dd>([\s\S]*?)<\/dd>/g)].map(m => [clean(m[1]).replace(/[ :]+$/, ''), clean(m[2])]);
    const get = (...keys) => { for (const [k, v] of facts) for (const key of keys) if (v && k.toLowerCase().includes(key.toLowerCase())) return v; return null; };
    const cover = page.match(/<meta property="og:image" content="([^"]+)"/);
    return {
      title: clean(title[1]),
      authors: [...new Set(authors.filter(a => a && !/^(trad|tr|il|ilus|ilustr|ed|pr[oó]l|coord|sel|adapt|introd?)\.?\s/i.test(a)))].join(', '),
      publisher: get('Editorial'), year: year4(get('Fecha')),
      pages: (String(get('Páginas', 'paginas') || '').match(/\d+/) || [null])[0],
      language: get('Idioma de publicación'), cover_url: cover ? cover[1] : null,
    };
  }
  const SOURCES = { 'Google Books': srcGoogle, 'todostuslibros': srcTodostuslibros, 'Open Library': srcOpenLibrary };
  const cache = new Map();

  async function lookup(isbn) {
    if (cache.has(isbn)) return cache.get(isbn);
    const results = {}, errors = {};
    await Promise.all(Object.entries(SOURCES).map(async ([name, fn]) => {
      try { const d = await fn(isbn); if (d) results[name] = d; }
      catch (e) { errors[name] = e.code ? `error ${e.code}${e.code === 429 ? ' (límite de peticiones)' : ''}` : (e.name === 'Error' ? e.message : e.name); }
    }));
    const order = isbn.startsWith('97884') ? ['todostuslibros', 'Google Books', 'Open Library'] : ['Google Books', 'todostuslibros', 'Open Library'];
    const merged = {};
    for (const f of ['title', 'subtitle', 'authors', 'publisher', 'year', 'pages', 'language', 'cover_url']) {
      const s = order.find(s => results[s]?.[f]);
      merged[f] = s ? String(results[s][f]) : '';
    }
    const out = { found: Object.keys(results).length > 0, book: merged, sources: order.filter(s => results[s]), errors };
    if (out.found) cache.set(isbn, out);
    return out;
  }

  // ------------------------------------------------------------ API /api/... (sustituye a server.py)
  const json = (obj, status = 200) => new Response(JSON.stringify(obj, null, 2), { status, headers: { 'Content-Type': 'application/json; charset=utf-8' } });

  async function api(url, method, body) {
    const path = url.pathname;
    if (path === '/api/books' && method === 'GET') return json(allBooks());
    if (path === '/api/books' && method === 'POST') {
      let data; try { data = JSON.parse(body || '{}'); } catch { return json({ error: 'JSON no válido' }, 400); }
      const isbn = cleanIsbn(data.isbn);
      if (![10, 13].includes(isbn.length)) return json({ error: 'ISBN no válido' }, 400);
      if (!String(data.title ?? '').trim()) return json({ error: 'El título es obligatorio' }, 400);
      const row = upsertBook(data); persist();
      if (wlGet(isbn)) { wlDel(isbn); setTimeout(() => window.BIBLIO_MOBILE.toast?.('♡ De tu wishlist a tu biblioteca'), 300); }
      return json({ ok: true, book: row });
    }
    if (path.startsWith('/api/books/') && method === 'DELETE') {
      db.run('DELETE FROM books WHERE isbn = ?', [decodeURIComponent(path.split('/').pop())]);
      const n = db.getRowsModified(); persist();
      return json({ ok: n > 0 });
    }
    if (path === '/api/library' && method === 'GET') {
      const lib = getLibrary();
      return json(lib);
    }
    if (path === '/api/library' && method === 'PUT') {
      let data; try { data = cleanLibrary(JSON.parse(body || '{}')); } catch { return json({ error: 'JSON no válido' }, 400); }
      setLibrary(data); persist();
      return json({ ok: true, shelves: data.shelves.length });
    }
    if (path === '/api/lookup') {
      const isbn = (url.searchParams.get('isbn') || '').replace(/\D/g, '');
      if (isbn.length !== 13) return json({ error: 'ISBN-13 no válido' }, 400);
      return json(await lookup(isbn));
    }
    return json({ error: 'No encontrado' }, 404);
  }

  const realFetch = window.fetch.bind(window);
  window.fetch = async (input, init = {}) => {
    const url = new URL(typeof input === 'string' ? input : input.url, location.href);
    if (url.origin !== location.origin || !url.pathname.startsWith('/api/')) return realFetch(input, init);
    await ready;
    try { return await api(url, String(init.method || 'GET').toUpperCase(), init.body); }
    catch (e) { console.error(e); return json({ error: String(e?.message || e) }, 500); }
  };

  // ------------------------------------------------------------ exportar
  const stamp = () => new Date().toISOString().slice(0, 10);
  function toCsv() {
    const cols = [...FIELDS, 'created_at', 'updated_at'];
    const q = v => { v = String(v ?? ''); return /[;"\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v; };
    return '﻿' + [cols.join(';'), ...allBooks().map(b => cols.map(c => q(b[c])).join(';'))].join('\r\n') + '\r\n';
  }
  const toB64 = bytes => { let s = ''; for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000)); return btoa(s); };

  async function saveFile(name, mime, data) {
    const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data;
    if (NATIVE) {
      const { uri } = await Filesystem.writeFile({ path: name, data: toB64(bytes), directory: 'CACHE' });
      await Share.share({ title: name, dialogTitle: 'Guardar o enviar ' + name, files: [uri] });
      return;
    }
    const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(new Blob([bytes], { type: mime })), download: name });
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  }
  async function exportAs(kind) {
    await ready;
    try {
      if (kind === 'csv') await saveFile(`biblioteca-${stamp()}.csv`, 'text/csv', toCsv());
      if (kind === 'json') await saveFile(`biblioteca-${stamp()}.json`, 'application/json', JSON.stringify({ books: allBooks(), library: getLibrary(), wishlist: wlAll() }, null, 2));
      if (kind === 'db') { await flush(); await saveFile(`biblioteca-${stamp()}.db`, 'application/x-sqlite3', db.export()); }
    } catch (e) {
      if (!/cancel/i.test(String(e?.message || e))) alert('No se pudo exportar: ' + (e?.message || e));
    }
  }
  // los enlaces CSV / JSON de index.html apuntan a /api/...: aquí se convierten en "compartir"
  document.addEventListener('click', e => {
    const a = e.target.closest?.('a[href^="/api/"]');
    if (!a) return;
    e.preventDefault(); e.stopPropagation();
    exportAs(a.getAttribute('href').includes('csv') ? 'csv' : 'json');
  }, true);

  // ------------------------------------------------------------ importar
  async function readImport(file) {
    const bytes = new Uint8Array(await file.arrayBuffer());
    const head = new TextDecoder().decode(bytes.subarray(0, 16));
    if (head.startsWith('SQLite format 3')) {
      const src = new SQL.Database(bytes);
      try {
        const q = sql => { try { const st = src.prepare(sql), out = []; while (st.step()) out.push(st.getAsObject()); st.free(); return out; } catch { return []; } };
        const books = q('SELECT * FROM books');
        const kv = q("SELECT value FROM kv WHERE key = 'library'")[0];
        const wishlist = q('SELECT * FROM wishlist');
        if (!books.length && !kv && !wishlist.length) throw new Error('El archivo no parece una base de datos de BiblioScan.');
        return { books, library: kv ? JSON.parse(kv.value) : null, wishlist };
      } finally { src.close(); }
    }
    let data;
    try { data = JSON.parse(new TextDecoder().decode(bytes)); } catch { throw new Error('Formato no reconocido. Usa un .db o un .json exportado de BiblioScan.'); }
    if (Array.isArray(data)) return { books: data, library: null };
    if (Array.isArray(data?.books)) return { books: data.books, library: data.library || null, wishlist: Array.isArray(data.wishlist) ? data.wishlist : [] };
    throw new Error('El JSON no contiene una lista de libros.');
  }
  async function applyImport(imp, replace) {
    await ready;
    db.run('BEGIN');
    try {
      if (replace) { db.run('DELETE FROM books'); db.run("DELETE FROM kv WHERE key = 'library'"); }
      let n = 0;
      for (const b of imp.books) {
        const isbn = cleanIsbn(b.isbn);
        if (![10, 13].includes(isbn.length) || !String(b.title ?? '').trim()) continue;
        upsertBook(b, true); n++;
      }
      if (imp.library && (replace || !getLibrary().shelves.length)) setLibrary(cleanLibrary(imp.library));
      if (replace && imp.wishlist) db.run('DELETE FROM wishlist');
      const owned = new Set(rows('SELECT isbn FROM books').map(r => r.isbn));
      for (const w of imp.wishlist || []) if ([10, 13].includes(cleanIsbn(w.isbn).length) && !owned.has(cleanIsbn(w.isbn))) wlPut(w, true);
      db.run('COMMIT');
      await flush();
      return n;
    } catch (e) { db.run('ROLLBACK'); throw e; }
  }

  // ------------------------------------------------------------ iconos (los botones del móvil van sin texto)
  const IC = {
    db: '<ellipse cx="12" cy="5.5" rx="7" ry="2.5"/><path d="M5 5.5v13c0 1.4 3.1 2.5 7 2.5s7-1.1 7-2.5v-13"/><path d="M5 12c0 1.4 3.1 2.5 7 2.5s7-1.1 7-2.5"/>',
    filter: '<path d="M4 6.5h16M7.5 12h9M10.5 17.5h3"/>',
    chart: '<rect x="4" y="9" width="3.2" height="10" rx="1.6"/><rect x="10.4" y="4.5" width="3.2" height="14.5" rx="1.6"/><rect x="16.8" y="11.5" width="3.2" height="7.5" rx="1.6"/>',
    list: '<path d="M5 7h14M5 12h14M5 17h9"/>',
    feed: '<rect x="6" y="3.5" width="12" height="17" rx="2.5"/><path d="M9 14.5h6M9 17h4"/>',
    image: '<rect x="3.5" y="5" width="17" height="14" rx="2.5"/><circle cx="9" cy="10" r="1.6"/><path d="M4.5 17.5l4.5-4.5 3.5 3.5 2.5-2.5 4.5 4.5"/>',
    dots: '<circle cx="5.5" cy="12" r="1.2" fill="currentColor"/><circle cx="12" cy="12" r="1.2" fill="currentColor"/><circle cx="18.5" cy="12" r="1.2" fill="currentColor"/>',
    eye: '<path d="M2.5 12s3.5-6.5 9.5-6.5 9.5 6.5 9.5 6.5-3.5 6.5-9.5 6.5S2.5 12 2.5 12z"/><circle cx="12" cy="12" r="2.8"/>',
    edit: '<path d="M4 20h4L19.5 8.5l-4-4L4 16v4z"/><path d="M13.5 6.5l4 4"/>',
    trash: '<path d="M4.5 7h15M9.5 7V4.5h5V7M6.5 7l1 13h9l1-13"/>',
    x: '<path d="M6 6l12 12M18 6L6 18"/>',
    check: '<path d="M4.5 12.5l5 5L19.5 7"/>',
    prev: '<path d="M15 5l-7 7 7 7"/>', next: '<path d="M9 5l7 7-7 7"/>',
    pause: '<path d="M8.5 5v14M15.5 5v14"/>', play: '<path d="M7.5 5l11 7-11 7z"/>',
    rotate: '<path d="M19.5 12a7.5 7.5 0 1 1-2.2-5.3"/><path d="M19.5 4v4h-4"/>',
    contrast: '<circle cx="12" cy="12" r="8"/><path d="M12 4a8 8 0 0 1 0 16z" fill="currentColor"/>',
    text: '<path d="M5 6.5h14M12 6.5V19M9 19h6"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    upload: '<path d="M12 19V8M7 12.5l5-5 5 5M5 4.5h14"/>',
    download: '<path d="M12 4v11M7 10.5l5 5 5-5M5 20h14"/>',
    grid: '<rect x="4" y="4" width="16" height="16" rx="2.5"/><path d="M4 10h16M4 15h16M10 4v16"/>',
    braces: '<path d="M9 4.5c-2 0-3 1-3 3v2c0 1.3-.8 2.2-2 2.5 1.2.3 2 1.2 2 2.5v2c0 2 1 3 3 3M15 4.5c2 0 3 1 3 3v2c0 1.3.8 2.2 2 2.5-1.2.3-2 1.2-2 2.5v2c0 2-1 3-3 3"/>',
    swap: '<path d="M4 8h14l-3.5-3.5M20 16H6l3.5 3.5"/>',
    search: '<circle cx="10.5" cy="10.5" r="6"/><path d="M15 15l5 5"/>',
    heart: '<path d="M12 19.5s-7-4.3-7-9.6A3.9 3.9 0 0 1 12 7.6a3.9 3.9 0 0 1 7 2.3c0 5.3-7 9.6-7 9.6z"/>',
    heartOn: '<path d="M12 19.5s-7-4.3-7-9.6A3.9 3.9 0 0 1 12 7.6a3.9 3.9 0 0 1 7 2.3c0 5.3-7 9.6-7 9.6z" fill="currentColor"/>',
    books: '<path d="M3.5 20h17"/><rect x="5" y="7" width="3" height="13"/><rect x="9.5" y="4.5" width="3" height="15.5"/><path d="M14.6 8.2l2.9-.8 3.3 12.2-2.9.8z"/>',
    sliders: '<path d="M5 7h9M18 7h1M5 17h3M12 17h7"/><circle cx="16" cy="7" r="2"/><circle cx="10" cy="17" r="2"/>',
    inbox: '<path d="M4 13.5l2.2-8h11.6l2.2 8V19a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1z"/><path d="M4 13.5h4.5l1 2.5h5l1-2.5H20"/>',
    orbit: '<circle cx="8" cy="13" r="3.2"/><circle cx="16.5" cy="8.5" r="2.4"/><path d="M3.5 18.5c3-6 11-12 17-13.5"/>',
    qr: '<rect x="4" y="4" width="6" height="6" rx="1"/><rect x="14" y="4" width="6" height="6" rx="1"/><rect x="4" y="14" width="6" height="6" rx="1"/><path d="M14 14h2v2h-2zM18 14h2M14 18h2M18 18h2v2h-2z"/>',
    share: '<circle cx="17.5" cy="6" r="2.5"/><circle cx="6.5" cy="12" r="2.5"/><circle cx="17.5" cy="18" r="2.5"/><path d="M8.7 10.8l6.6-3.6M8.7 13.2l6.6 3.6"/>',
    home: '<path d="M4 11.2L12 4.5l8 6.7V19a1 1 0 0 1-1 1h-4.5v-5.5h-5V20H5a1 1 0 0 1-1-1z"/>',
    info: '<circle cx="12" cy="12" r="8.5"/><path d="M12 11v5.5"/><circle cx="12" cy="7.9" r=".6" fill="currentColor"/>',
    ext: '<path d="M14 4.5h5.5V10M19.5 4.5L11 13M17 14v5.5H4.5V7H10"/>',
  };
  const svg = n => `<svg class="ic" viewBox="0 0 24 24" aria-hidden="true">${IC[n]}</svg>`;
  const maskUrl = n => `url("data:image/svg+xml,${encodeURIComponent(`<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='black' stroke-width='1.7' stroke-linecap='round' stroke-linejoin='round'>${IC[n].replace(/currentColor/g, 'black')}</svg>`)}")`;
  const ib = (id, icon, label, extra = '') => `<button id="${id}" class="ibtn" aria-label="${label}" title="${label}" ${extra}>${svg(icon)}</button>`;
  // botones de index.html: su texto lo cambia la propia app (p. ej. «Pausa»/«Reanudar»), así que el icono va por CSS (máscara)
  function iconizeButtons() {
    const map = { filterBtn: ['contrast', 'Filtro de imagen'], rotBtn: ['rotate', 'Girar texto OCR'], pauseBtn: ['pause', 'Pausa', 'play'],
      dPrev: ['prev', 'Anterior'], dNext: ['next', 'Siguiente'], dEdit: ['edit', 'Editar ficha'], dClose: ['x', 'Cerrar'],
      mOcr: ['text', 'Usar texto OCR'], mNo: ['x', 'Descartar'], mYes: ['check', 'Guardar'] };
    for (const [id, [icon, label, on]] of Object.entries(map)) {
      const b = document.getElementById(id);
      if (!b) continue;
      b.classList.add('icb'); b.setAttribute('aria-label', label); b.title = label;
      b.style.setProperty('--ic', maskUrl(icon));
      if (on) b.style.setProperty('--ic-on', maskUrl(on));
    }
  }

  // ------------------------------------------------------------ panel "Información" (versión, GitHub, actualizar, datos)
  const ICON = svg('info');
  function buildPanel() {
    const nav = document.querySelector('.tabs');
    if (!nav || document.getElementById('tabData')) return;
    nav.insertAdjacentHTML('beforeend', `<button id="tabData" title="Información, actualizaciones y copia de seguridad" aria-label="Información">${ICON}</button>`);
    document.body.insertAdjacentHTML('beforeend', `
      <div class="modal hidden" id="dataModal">
        <div class="mcard datacard">
          <div class="bar mono-caps"><span>Información</span><span id="dataCount"></span></div>
          <div class="datab">
            <div class="infoh"><div class="ilogo">B/S</div><div><b>BiblioScan</b><span class="mono-caps">Versión ${escH(window.BIBLIO_VERSION || '—')}</span></div></div>
            <a class="ilink mono-caps" href="https://github.com/KMN43/biblioscan" target="_blank" rel="noopener">${svg('ext')}<span>github.com/KMN43/biblioscan</span></a>
            <div class="btns iupd">${ib('updCheck', 'rotate', 'Buscar actualizaciones')}<button id="updGet" class="ibtn primary" hidden aria-label="Descargar e instalar" title="Descargar e instalar">${svg('download')}</button><span id="updMsg" class="mono-caps"></span></div>
            <div class="mono-caps lbl">Compartir BiblioScan</div>
            <div class="btns">${ib('shareQR', 'qr', 'Mostrar el QR para descargar la app', 'data-pri')}${ib('shareLink', 'share', 'Enviar el enlace de descarga')}</div>
            <div id="qrBox" class="qrbox" hidden></div>
            <div class="mono-caps lbl">Copia de seguridad</div>
            <p>Tu biblioteca se guarda solo en este móvil. Exporta una copia de vez en cuando, o pásala al ordenador
               (el archivo <b>.db</b> es el mismo <i>biblioteca.db</i> que usa BiblioScan.exe).</p>
            <div class="mono-caps lbl">Exportar</div>
            <div class="btns"><button data-exp="db" class="ibtn primary" aria-label="Exportar base de datos .db" title="Base de datos .db">${svg('db')}</button><button data-exp="csv" class="ibtn" aria-label="Exportar CSV para Excel" title="CSV (Excel)">${svg('grid')}</button><button data-exp="json" class="ibtn" aria-label="Exportar JSON" title="JSON">${svg('braces')}</button></div>
            <p class="hint mono-caps">.db · csv · json</p>
            <div class="mono-caps lbl">Importar</div>
            <p>Elige un <b>biblioteca.db</b> (del ordenador o de otro móvil) o un <b>.json</b> exportado de BiblioScan.</p>
            <div class="btns">${ib('impPick', 'upload', 'Elegir archivo')}<input id="impFile" type="file" hidden></div>
            <div id="impAsk" class="hidden">
              <p id="impMsg"></p>
              <div class="btns">${ib('impAdd', 'plus', 'Añadir a mi biblioteca', 'data-pri')}${ib('impRep', 'swap', 'Reemplazar todo')}</div>
            </div>
            <p id="impErr" class="err"></p>
          </div>
          <div class="mfoot"><span class="grow"></span>${ib('dataClose', 'x', 'Cerrar')}</div>
        </div>
      </div>`);
    const $ = id => document.getElementById(id), modal = $('dataModal');
    let pending = null;
    const close = () => { modal.classList.add('hidden'); $('impAsk').classList.add('hidden'); $('impErr').textContent = ''; pending = null; };
    $('tabData').onclick = async () => {
      await ready;
      $('dataCount').textContent = `${rows('SELECT count(*) n FROM books')[0].n} libros`;
      modal.classList.remove('hidden');
    };
    $('dataClose').onclick = close;
    $('shareQR').onclick = showShareQR;
    $('shareLink').onclick = shareLink;
    $('updCheck').onclick = async () => {
      const msg = $('updMsg'), get = $('updGet');
      msg.textContent = 'Buscando…'; get.hidden = true; $('updCheck').disabled = true;
      try {
        const u = await latestRelease();
        if (u.apk && newer(u.tag, window.BIBLIO_VERSION)) {
          msg.textContent = `Nueva versión ${u.tag.replace(/^v/i, '')}`; get.hidden = false;
          get.onclick = () => installUpdate(u.apk, { msg: t => { msg.textContent = t; }, progress: pct => { msg.textContent = pct >= 0 ? `Descargando ${pct} %` : 'Descargando…'; } });
        }
        else msg.textContent = 'Tienes la última versión';
      } catch { msg.textContent = 'Sin conexión con GitHub'; }
      $('updCheck').disabled = false;
    };
    modal.addEventListener('click', e => { if (e.target === modal) close(); });
    modal.querySelectorAll('[data-exp]').forEach(b => b.onclick = () => exportAs(b.dataset.exp));
    $('impPick').onclick = () => $('impFile').click();
    $('impFile').onchange = async e => {
      const f = e.target.files[0]; e.target.value = '';
      if (!f) return;
      $('impErr').textContent = ''; $('impAsk').classList.add('hidden');
      try {
        await ready;
        pending = await readImport(f);
        const have = rows('SELECT count(*) n FROM books')[0].n, sh = pending.library?.shelves?.length || 0;
        $('impMsg').innerHTML = `<b>${f.name}</b>: ${pending.books.length} libros${sh ? ` y ${sh} estanterías` : ''}.<br>`
          + `Ahora tienes ${have} libros. ＋ combina ambos (si un ISBN ya existe, se actualiza con los datos importados)`
          + `${sh ? ' y solo toma las estanterías si aún no tienes ninguna' : ''}. ⇄ reemplaza y borra lo actual.`;
        $('impAsk').classList.remove('hidden');
      } catch (err) { $('impErr').textContent = err.message || String(err); }
    };
    const run = async replace => {
      if (!pending) return;
      if (replace && !confirm('¿Seguro? Se borrará la biblioteca actual de este móvil y se sustituirá por la importada.')) return;
      try { const n = await applyImport(pending, replace); alert(`Importados ${n} libros.`); location.reload(); }
      catch (err) { $('impErr').textContent = 'Error al importar: ' + (err.message || err); }
    };
    $('impAdd').onclick = () => run(false);
    $('impRep').onclick = () => run(true);
  }

  // ------------------------------------------------------------ ajustes de móvil
  // cámara trasera por defecto (index.html no indica cuál usar)
  // en el móvil la cámara solo se enciende en la pestaña Scan: las peticiones hechas fuera de ella esperan
  const isPhone = () => matchMedia('(max-width: 760px)').matches;
  let homeOn = true;                        // la app arranca en Home (en pantalla grande no hay Home: se desactiva al cargar)
  let scanMode = null;                      // null = círculos de entrada · 'add' · 'look'
  let camWaiters = [];
  const scanVisible = () => !isPhone() || (!homeOn && !!scanMode && !document.hidden && !document.getElementById('scanView')?.classList.contains('hidden'));
  const md = navigator.mediaDevices;
  if (md?.getUserMedia) {
    const gum = md.getUserMedia.bind(md);
    md.getUserMedia = c => {
      if (c?.video && typeof c.video === 'object' && !c.video.deviceId) c = { ...c, video: { ...c.video, facingMode: { ideal: 'environment' } } };
      if (c?.video && !scanVisible()) return new Promise((res, rej) => camWaiters.push(() => gum(c).then(res, rej)));
      return gum(c);
    };
  }
  function cameraFor(on) {
    if (!isPhone()) return;
    if (on) {
      const w = camWaiters; camWaiters = [];
      if (w.length) w.forEach(f => f());
      else if (typeof startCam === 'function' && !(typeof stream !== 'undefined' && stream?.active))
        startCam(lsGet('cam', '') || undefined).then(() => typeof listCams === 'function' && listCams()).catch(() => {});
    } else {
      try { if (typeof stream !== 'undefined' && stream) { stream.getTracks().forEach(t => t.stop()); stream = null; } } catch {}
    }
  }
  document.addEventListener('visibilitychange', () => { if (!isPhone()) return; if (document.hidden) cameraFor(false); else if (scanVisible()) cameraFor(true); });

  const narrow = matchMedia('(max-width: 760px)');
  const $id = id => document.getElementById(id);
  const escH = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const normS = s => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
  const hash = s => { let h = 2166136261; for (const c of String(s)) { h ^= c.charCodeAt(0); h = Math.imul(h, 16777619); } return h >>> 0; };
  const yearOfB = b => { const m = String(b.year || '').match(/\d{4}/); return m ? +m[0] : null; };
  const surname = a => (String(a || '').split(',')[0].trim().split(/\s+/).pop() || '');
  const lsGet = (k, d) => { try { return localStorage.getItem(k) ?? d; } catch { return d; } };
  const lsSet = (k, v) => { try { localStorage.setItem(k, v); } catch {} };
  const books = () => (typeof catalog !== 'undefined' && Array.isArray(catalog)) ? catalog : [];
  let toastT = 0;
  function mtoast(msg) {
    let t = $id('mToast');
    if (!t) { document.body.insertAdjacentHTML('beforeend', '<div id="mToast" class="mono-caps"></div>'); t = $id('mToast'); }
    t.textContent = msg; t.classList.add('on');
    clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove('on'), 2200);
  }

  // ============================================================ CATÁLOGO (móvil)
  const MC = { view: lsGet('mcView', 'feed'), q: '', pub: '', lang: '', sort: 'rec', yr: null, src: 'lib' };
  const srcBooks = () => MC.src === 'wish' ? wlAll() : books();
  const SORTS = [['rec', 'Recomendados'], ['recent', 'Añadidos recientes'], ['title', 'Título A–Z'], ['author', 'Autor A–Z'], ['new', 'Año: nuevos'], ['old', 'Año: antiguos']];

  function mcBase() {   // todos los filtros menos el del año (el timeline muestra la distribución sin él)
    const terms = normS(MC.q).split(/\s+/).filter(Boolean);
    return srcBooks().filter(b => (!MC.pub || b.publisher === MC.pub) && (!MC.lang || b.language === MC.lang)
      && (!terms.length || terms.every(t => normS([b.title, b.subtitle, b.authors, b.publisher, b.isbn, b.notes, b.year].join(' ')).includes(t))));
  }
  function mcList() {
    let list = mcBase();
    if (MC.yr) list = list.filter(b => { const y = yearOfB(b); return y && y >= MC.yr[0] && y <= MC.yr[1]; });
    const day = new Date().toISOString().slice(0, 10), cmp = (a, b) => String(a || '').localeCompare(String(b || ''), 'es');
    const by = {
      rec: (a, b) => hash(a.isbn + day) - hash(b.isbn + day),
      recent: (a, b) => cmp(b.created_at || b.updated_at, a.created_at || a.updated_at),
      title: (a, b) => cmp(a.title, b.title),
      author: (a, b) => cmp(surname(a.authors), surname(b.authors)) || cmp(a.title, b.title),
      new: (a, b) => (yearOfB(b) || 0) - (yearOfB(a) || 0),
      old: (a, b) => (yearOfB(a) || 9999) - (yearOfB(b) || 9999),
    }[MC.sort];
    return [...list].sort(by);
  }

  const BG = ['rgba(255,79,18,.34)', 'rgba(255,128,74,.30)', 'rgba(255,186,150,.45)', 'rgba(18,18,18,.10)', 'rgba(205,201,190,.75)', 'rgba(255,79,18,.18)'];
  function bgFor(isbn) {   // degradado difuso aleatorio (pero estable por libro) con la paleta de la app
    let h = hash(isbn); const r = () => { h = Math.imul(h ^ (h >>> 15), 2246822507) >>> 0; return (h % 1000) / 1000; };
    const blob = () => `radial-gradient(circle at ${Math.round(r() * 100)}% ${Math.round(r() * 100)}%, ${BG[Math.floor(r() * BG.length)]} 0, transparent ${Math.round(45 + r() * 25)}%)`;
    return `${blob()}, ${blob()}, ${blob()}, #ecebe6`;
  }
  const titleSize = t => { const n = String(t || '').length; return n < 18 ? 46 : n < 34 ? 38 : n < 60 ? 30 : 24; };

  function buildMobileCatalog() {
    const cv = $id('catView');
    if (!cv || $id('mcat')) return;
    cv.insertAdjacentHTML('beforeend', `
      <div id="mcat">
        <div class="mchead">
          <div class="mct"><b>Catálogo</b><span id="mcCount" class="mono-caps"></span></div>
          <div class="mcbtns">${ib('mcFilt', 'filter', 'Buscar y filtrar')}${ib('mcStatsB', 'chart', 'Estadísticas y línea de tiempo')}${ib('mcViewB', 'list', 'Cambiar vista')}</div>
        </div>
        <div id="mcFilters" class="mcpanel" hidden>
          <div class="mcsrc">${ib('mcSrcLib', 'books', 'Mi biblioteca')}${ib('mcSrcWish', 'heart', 'Wishlist')}<span id="mcSrcT" class="mono-caps"></span></div>
          <input id="mcQ" type="text" placeholder="Buscar título, autor, editorial, ISBN…" autocomplete="off">
          <div class="mcsel"><select id="mcPub" aria-label="Editorial"></select><select id="mcLang" aria-label="Idioma"></select>
            <select id="mcSort" aria-label="Orden">${SORTS.map(([v, t]) => `<option value="${v}">${t}</option>`).join('')}</select>
            ${ib('mcClear', 'x', 'Quitar filtros')}</div>
        </div>
        <div id="mcStatsP" class="mcpanel" hidden>
          <div class="mckpis" id="mcKpis"></div>
          <div class="mctl"><div class="mctlh mono-caps"><span>Año de edición</span><span id="mcTlInfo"></span></div><svg id="mcTl"></svg>
            <div class="mctlx mono-caps"><span id="mcTl0"></span><span id="mcTl1"></span></div></div>
        </div>
        <div id="mcBody" class="mcbody"></div>
      </div>
      <div id="mcSheet" class="msheet" hidden><div class="msin"><div class="msh"><b id="mcSheetT"></b><span id="mcSheetA" class="mono-caps"></span></div>
        <div class="msb">${ib('mcSView', 'eye', 'Ver ficha')}${ib('mcSEdit', 'edit', 'Editar')}${ib('mcSDel', 'trash', 'Borrar')}${ib('mcSClose', 'x', 'Cerrar')}</div></div></div>
      <div id="mcCover" class="mcover" hidden></div>`);
    document.body.append($id('mcSheet'), $id('mcCover'));   // fuera de #catView (allí todo lo demás va oculto)
    const toggle = (btn, panel) => { const p = $id(panel); p.hidden = !p.hidden; $id(btn).classList.toggle('on', !p.hidden); if (panel === 'mcStatsP' && !p.hidden) mcStats(); };
    $id('mcFilt').onclick = () => { toggle('mcFilt', 'mcFilters'); if (!$id('mcFilters').hidden) $id('mcQ').focus(); };
    $id('mcStatsB').onclick = () => toggle('mcStatsB', 'mcStatsP');
    $id('mcViewB').onclick = () => { MC.view = MC.view === 'feed' ? 'list' : 'feed'; lsSet('mcView', MC.view); mcRender(); };
    let qT = 0;
    $id('mcQ').oninput = e => { clearTimeout(qT); qT = setTimeout(() => { MC.q = e.target.value; mcRender(); }, 180); };
    $id('mcPub').onchange = e => { MC.pub = e.target.value; mcRender(); };
    $id('mcLang').onchange = e => { MC.lang = e.target.value; mcRender(); };
    $id('mcSort').onchange = e => { MC.sort = e.target.value; mcRender(); };
    $id('mcClear').onclick = () => { Object.assign(MC, { q: '', pub: '', lang: '', sort: 'rec', yr: null, src: 'lib' }); $id('mcQ').value = ''; mcRender(); };
    $id('mcSrcLib').onclick = () => { MC.src = 'lib'; MC.pub = MC.lang = ''; MC.yr = null; mcRender(); };
    $id('mcSrcWish').onclick = () => { MC.src = 'wish'; MC.pub = MC.lang = ''; MC.yr = null; mcRender(); };
    $id('mcBody').addEventListener('click', e => {
      const cov = e.target.closest('.mfcov'), dots = e.target.closest('.mld'), item = e.target.closest('[data-isbn]');
      if (!item) return;
      const isbn = item.dataset.isbn;
      if (cov) return showCover(isbn);
      if (MC.src === 'wish') return openLook(isbn);              // la wishlist no está en el catálogo: ficha de consulta
      if (dots) return openSheet(isbn);
      if (typeof openDetail === 'function') openDetail(isbn, mcList().map(b => b.isbn));
    });
    // hoja de acciones (los ⋯ de la lista): evita borrar o editar sin querer
    let sheetIsbn = null;
    function openSheet(isbn) {
      const b = books().find(x => x.isbn === isbn); if (!b) return;
      sheetIsbn = isbn; $id('mcSheetT').textContent = b.title; $id('mcSheetA').textContent = [b.authors, b.year].filter(Boolean).join(' · ');
      $id('mcSheet').hidden = false;
    }
    const closeSheet = () => { $id('mcSheet').hidden = true; sheetIsbn = null; };
    $id('mcSheet').addEventListener('click', e => { if (e.target.id === 'mcSheet') closeSheet(); });
    $id('mcSClose').onclick = closeSheet;
    $id('mcSView').onclick = () => { const i = sheetIsbn; closeSheet(); openDetail(i, mcList().map(b => b.isbn)); };
    $id('mcSEdit').onclick = () => { const i = sheetIsbn; closeSheet(); try { handled.delete(i); } catch {} openConfirm(i); };
    $id('mcSDel').onclick = async () => {
      const b = books().find(x => x.isbn === sheetIsbn); if (!b) return;
      if (!confirm(`¿Borrar «${b.title}» del catálogo?`)) return;
      const i = sheetIsbn; closeSheet();
      await fetch(`/api/books/${encodeURIComponent(i)}`, { method: 'DELETE' });
      loadCatalog(); mtoast('Libro borrado');
    };
    $id('mcCover').onclick = () => { $id('mcCover').hidden = true; };
    // el catálogo se vuelve a pintar cada vez que index.html recarga los libros
    new MutationObserver(() => { mcRender(); if (!$id('libView').classList.contains('hidden')) renderShelves(); }).observe($id('catCount'), { childList: true, characterData: true, subtree: true });
    mcRender();
  }

  function showCover(isbn) {
    const b = srcBooks().find(x => x.isbn === isbn); if (!b) return;
    const c = $id('mcCover');
    c.innerHTML = `<div class="mcovin">${typeof coverHtml === 'function' ? coverHtml(b, true) : `<img src="${escH(b.cover_url)}" alt="">`}</div>`;
    c.querySelectorAll('img').forEach(img => { img.style.filter = 'none'; img.onerror = () => img.remove(); });
    c.hidden = false;
  }

  function mcFillSelects() {
    const base = srcBooks(), count = k => base.reduce((m, b) => (b[k] && m.set(b[k], (m.get(b[k]) || 0) + 1), m), new Map());
    const opts = (m, all) => `<option value="">${all}</option>` + [...m].sort((a, b) => a[0].localeCompare(b[0], 'es')).map(([v, n]) => `<option value="${escH(v)}">${escH(v)} (${n})</option>`).join('');
    $id('mcPub').innerHTML = opts(count('publisher'), 'Todas las editoriales'); $id('mcPub').value = MC.pub;
    $id('mcLang').innerHTML = opts(count('language'), 'Todos los idiomas'); $id('mcLang').value = MC.lang;
    $id('mcSort').value = MC.sort;
  }

  function mcRender() {
    const body = $id('mcBody'); if (!body) return;
    mcFillSelects();
    const list = mcList(), all = srcBooks().length, filtered = list.length !== all, wish = MC.src === 'wish';
    $id('mcCount').textContent = (filtered ? `${list.length} de ${all}` : `${all} ${all === 1 ? 'libro' : 'libros'}`) + (wish ? ' · wishlist' : '');
    $id('mcFilt').classList.toggle('dot', !!(MC.q || MC.pub || MC.lang || MC.yr || MC.sort !== 'rec' || wish));
    $id('mcSrcLib').classList.toggle('on', !wish); $id('mcSrcWish').classList.toggle('on', wish);
    $id('mcSrcT').textContent = wish ? `Wishlist · ${wlAll().length}` : `Mi biblioteca · ${books().length}`;
    $id('mcViewB').innerHTML = svg(MC.view === 'feed' ? 'list' : 'feed');
    body.className = 'mcbody ' + MC.view;
    if (!list.length) body.innerHTML = `<div class="sbempty mono-caps">${all ? 'Ningún libro coincide con los filtros.' : wish ? 'Tu wishlist está vacía. En Scan, usa la lupa para consultar un libro y toca ♡.' : 'Aún no hay libros. Escanea alguno o importa tu biblioteca desde Info.'}</div>`;
    else if (MC.view === 'feed') body.innerHTML = list.map((b, i) => `
      <article class="mfc" data-isbn="${escH(b.isbn)}" style="background:${bgFor(b.isbn)}">
        <div class="mfk mono-caps"><span>${i + 1} / ${list.length}</span></div>
        <div class="mft"><h2>${escH(b.title)}</h2></div>
        <div class="mfm">
          <hr>
          <div class="mfa">${escH(b.authors || 'Autor desconocido')}</div>
          <div class="mfy mono-caps">${escH([b.year, b.publisher].filter(Boolean).join(' · '))}</div>
        </div>
        <button class="mfcov ibtn" aria-label="Ver portada" title="Ver portada">${svg('image')}</button>
      </article>`).join('');
    else body.innerHTML = list.map(b => `
      <div class="mlr" data-isbn="${escH(b.isbn)}"><div class="mlt"><div class="t">${escH(b.title)}</div>
        <div class="a">${escH([b.authors, b.year].filter(Boolean).join(' · '))}</div></div>
        <button class="mld ibtn" aria-label="Opciones" title="Opciones">${svg('dots')}</button></div>`).join('');
    if (!$id('mcStatsP').hidden) mcStats();
    if (MC.view === 'feed') observeTitles();
  }

  // título del feed: el mayor tamaño que quepa en su hueco sin partir ninguna palabra
  function fitTitle(card) {
    const box = card.querySelector('.mft'), h2 = box?.querySelector('h2');
    if (!h2 || !box.clientHeight) return;
    const W = box.clientWidth, H = box.clientHeight;
    const fits = px => { h2.style.fontSize = px + 'px'; return h2.scrollWidth <= W + 1 && h2.offsetHeight <= H; };
    let lo = 14, hi = 190;
    while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (fits(mid)) lo = mid; else hi = mid; }
    fits(lo);
    card.dataset.fit = `${W}x${H}`;
  }
  // ajusta la tarjeta visible y sus vecinas (al pintar, al desplazarse y al cambiar el tamaño)
  function fitNear() {
    const body = $id('mcBody'); if (!body || MC.view !== 'feed' || !body.clientHeight) return;
    const cards = body.querySelectorAll('.mfc'), i = Math.round(body.scrollTop / body.clientHeight);
    for (let k = Math.max(0, i - 1); k <= Math.min(cards.length - 1, i + 2); k++) {
      const box = cards[k].querySelector('.mft');
      if (cards[k].dataset.fit !== `${box.clientWidth}x${box.clientHeight}`) fitTitle(cards[k]);
    }
  }
  function observeTitles() {
    const body = $id('mcBody');
    if (!body.dataset.fitBound) {
      let t = 0; body.dataset.fitBound = '1';
      body.addEventListener('scroll', () => { clearTimeout(t); t = setTimeout(fitNear, 40); }, { passive: true });
    }
    setTimeout(fitNear, 0);
  }
  document.fonts?.ready.then(() => { $id('mcBody')?.querySelectorAll('.mfc').forEach(c => { delete c.dataset.fit; }); fitNear(); });
  addEventListener('resize', () => setTimeout(fitNear, 60));

  function mcStats() {
    const base = mcBase(), list = mcList();
    const authors = new Set(list.flatMap(b => String(b.authors || '').split(',').map(s => s.trim()).filter(Boolean)));
    const pubs = new Set(list.map(b => b.publisher).filter(Boolean));
    const pages = list.reduce((n, b) => n + (parseInt(b.pages, 10) || 0), 0);
    const k = (v, l) => `<div class="mck"><span class="mono-caps">${l}</span><b>${v.toLocaleString('es-ES')}</b></div>`;
    $id('mcKpis').innerHTML = k(list.length, 'Libros') + k(authors.size, 'Autores') + k(pubs.size, 'Editoriales') + k(pages, 'Páginas');
    // línea de tiempo: píldoras centradas, alto según el nº de libros de cada año (o lustro, si el periodo es largo)
    const ys = base.map(yearOfB).filter(Boolean), svgEl = $id('mcTl'), W = svgEl.clientWidth || 340, H = 96;
    if (!ys.length) { svgEl.innerHTML = ''; $id('mcTl0').textContent = $id('mcTl1').textContent = ''; $id('mcTlInfo').textContent = 'Sin años'; return; }
    const lo = Math.min(...ys), hi = Math.max(...ys), step = hi - lo > 36 ? 5 : 1, start = Math.floor(lo / step) * step;
    const n = Math.floor((hi - start) / step) + 1, cnt = Array(n).fill(0);
    ys.forEach(y => cnt[Math.floor((y - start) / step)]++);
    const max = Math.max(...cnt), slot = W / n, bw = Math.max(3, Math.min(16, slot * .62));
    svgEl.setAttribute('viewBox', `0 0 ${W} ${H}`);
    svgEl.innerHTML = cnt.map((c, i) => {
      const y0 = start + i * step, y1 = y0 + step - 1, on = MC.yr && MC.yr[0] === y0;
      if (!c) return `<circle cx="${slot * i + slot / 2}" cy="${H / 2}" r="1.2" fill="#c9c6bd"/>`;
      const h = Math.max(bw, (c / max) * (H - 8)), fill = on ? '#121212' : MC.yr ? '#d6d3cb' : '#ff4f12';
      return `<rect data-y0="${y0}" data-y1="${y1}" x="${slot * i + (slot - bw) / 2}" y="${(H - h) / 2}" width="${bw}" height="${h}" rx="${bw / 2}" fill="${fill}"><title>${step > 1 ? `${y0}–${y1}` : y0}: ${c}</title></rect>`
        + `<rect data-y0="${y0}" data-y1="${y1}" x="${slot * i}" y="0" width="${slot}" height="${H}" fill="transparent"/>`;
    }).join('');
    $id('mcTl0').textContent = start; $id('mcTl1').textContent = start + (n - 1) * step + step - 1;
    $id('mcTlInfo').innerHTML = MC.yr ? `${MC.yr[0]}${MC.yr[1] !== MC.yr[0] ? '–' + MC.yr[1] : ''} · ${list.length} <u data-clr>quitar</u>` : 'Toca un año para filtrar';
    svgEl.onclick = e => {
      const r = e.target.closest('[data-y0]'); if (!r) return;
      const y0 = +r.dataset.y0, y1 = +r.dataset.y1;
      MC.yr = MC.yr && MC.yr[0] === y0 ? null : [y0, y1]; mcRender();
    };
    $id('mcTlInfo').onclick = e => { if (e.target.closest('[data-clr]')) { MC.yr = null; mcRender(); } };
  }

  // ============================================================ BIBLIOTECA · baldas (móvil)
  // ↑↓ cambia de balda · ←→ recorre los libros · tocar el central abre su ficha
  // mantener pulsado el central → aparecen las baldas como destinos: arrástralo a una (o a «+» para crear otra)
  let sbRows = [];
  const thick = b => { const p = parseInt(b?.pages, 10); return p ? Math.max(7, Math.min(40, Math.round(5 + p / 18))) : 15; };
  const nRowsOf = s => Math.max(1, Math.round((s.h || 6) / 6));
  const entries = row => row.map(e => Array.isArray(e) ? e : [e, 0]);

  async function shelfRows() {
    await ready;
    const all = allBooks(), byIsbn = new Map(all.map(b => [b.isbn, b])), placed = new Set(), out = [];
    for (const s of cleanLibrary(getLibrary()).shelves) s.books.forEach((row, r) => {
      const list = entries(row).sort((a, b) => a[1] - b[1]).map(e => byIsbn.get(e[0])).filter(b => b && !placed.has(b.isbn));
      list.forEach(b => placed.add(b.isbn));
      if (list.length) out.push({ sid: s.id, r, label: s.label || 'Sin etiqueta', sub: nRowsOf(s) > 1 ? `Balda ${r + 1}` : 'Balda', books: list });
    });
    const rest = all.filter(b => !placed.has(b.isbn))
      .sort((a, b) => surname(a.authors).localeCompare(surname(b.authors), 'es') || String(a.title).localeCompare(String(b.title), 'es'));
    if (rest.length) out.push({ sid: null, r: 0, label: out.length ? 'Sin clasificar' : 'Mi biblioteca', sub: out.length ? 'En el montón' : 'Por autor', books: rest });
    return out;
  }
  const spineHtml = b => { const h = hash(b.isbn), w = Math.max(26, Math.min(80, Math.round(thick(b) * 2)));
    return `<button class="sp" data-isbn="${escH(b.isbn)}" aria-label="${escH(b.title)}" style="--w:${w}px;--hh:${72 + (h >> 3) % 22}%"></button>`; };

  async function renderShelves(focus) {
    const sb = $id('sb'); if (!sb) return;
    if (!focus) {   // conserva la balda y el libro que estabas mirando
      const sec = [...sb.querySelectorAll('.sbrow')].find(s => Math.abs(s.offsetTop - sb.scrollTop) < s.offsetHeight / 2);
      if (sec) focus = { sid: sbRows[+sec.dataset.row]?.sid, r: sbRows[+sec.dataset.row]?.r, isbn: sec.querySelector('.sp.on')?.dataset.isbn };
    }
    sbRows = await shelfRows();
    const unc = sbRows.find(r => r.sid === null && sbRows.length > 1);
    if ($id('sbUncN')) { $id('sbUncN').textContent = unc ? unc.books.length : ''; $id('sbUnc').classList.toggle('dim', !unc); }
    if (!sbRows.length) { sb.innerHTML = '<div class="sbempty mono-caps">Aún no hay libros. Escanea alguno o importa tu biblioteca desde Datos.</div>'; return; }
    sb.innerHTML = sbRows.map((r, i) => `
      <section class="sbrow" data-row="${i}">
        <div class="sbhead"><div><b>${escH(r.label)}</b><span class="mono-caps">${escH(r.sub)} · ${r.books.length} libros</span></div>
          <span class="mono-caps sbn">${i + 1} / ${sbRows.length}</span></div>
        <div class="sbstrip"><i class="sbpad"></i>${r.books.map(spineHtml).join('')}<i class="sbpad"></i></div>
        <div class="sbshelf"></div>
        <div class="sbinfo"><h2 class="t"></h2><hr><div class="a"></div><div class="y mono-caps"></div></div>
        <div class="sbnext mono-caps">${i + 1 < sbRows.length ? `↓ ${escH(sbRows[i + 1].label)}` : i ? '↑ Fin de la biblioteca' : ''}</div>
      </section>`).join('');
    sb.querySelectorAll('.sbstrip').forEach(strip => {
      let raf = 0;
      strip.addEventListener('scroll', () => { cancelAnimationFrame(raf); raf = requestAnimationFrame(() => pickCenter(strip)); }, { passive: true });
      pickCenter(strip);
    });
    if (focus) {
      const i = sbRows.findIndex(r => r.sid === focus.sid && r.r === focus.r);
      if (i >= 0) {
        const sec = sb.querySelector(`[data-row="${i}"]`); sb.scrollTop = sec.offsetTop;
        const sp = focus.isbn && sec.querySelector(`.sp[data-isbn="${CSS.escape(focus.isbn)}"]`);
        if (sp) { centerOn(sp, false); pickCenter(sec.querySelector('.sbstrip')); }
      }
    }
  }
  function pickCenter(strip) {
    const mid = strip.getBoundingClientRect().left + strip.clientWidth / 2;
    let best = null, bd = Infinity;
    strip.querySelectorAll('.sp').forEach(sp => { const r = sp.getBoundingClientRect(), d = Math.abs(r.left + r.width / 2 - mid); if (d < bd) { bd = d; best = sp; } });
    if (!best) return;
    strip.querySelector('.sp.on')?.classList.remove('on');
    best.classList.add('on');
    const sec = strip.closest('.sbrow'), b = sbRows[+sec.dataset.row].books.find(x => x.isbn === best.dataset.isbn);
    sec.querySelector('.sbinfo .t').textContent = b.title;
    sec.querySelector('.sbinfo .a').textContent = b.authors || 'Autor desconocido';
    sec.querySelector('.sbinfo .y').textContent = [b.year, b.publisher].filter(Boolean).join(' · ');
  }
  const centerOn = (sp, smooth = true) => sp.scrollIntoView({ inline: 'center', block: 'nearest', behavior: smooth ? 'smooth' : 'auto' });

  // --- mover libros entre baldas (mismo formato que la pestaña Biblioteca del PC) ---
  async function saveLib(lib, focus) {
    setLibrary(cleanLibrary(lib)); persist();
    if (typeof loadLibrary === 'function') { try { await loadLibrary(); } catch {} }   // que el plano del PC no pise el cambio
    await renderShelves(focus);
  }
  function placeBook(lib, isbn, sid, r) {
    const byIsbn = new Map(allBooks().map(b => [b.isbn, b]));
    lib.shelves.forEach(s => { s.books = s.books.map(row => entries(row).filter(e => e[0] !== isbn)); });
    if (!sid) return;
    const s = lib.shelves.find(x => x.id === sid); if (!s) return;
    while (s.books.length <= r) s.books.push([]);
    const row = s.books[r], used = row.reduce((m, e) => Math.max(m, e[1] + thick(byIsbn.get(e[0]))), 0);
    row.push([isbn, used]);
    const need = Math.ceil((used + thick(byIsbn.get(isbn)) + 12) / 20);
    const free = lib.shelves.every(o => o === s || !(s.x < o.x + o.w && o.x < s.x + need && s.y - 2 < o.y + o.h && o.y - 2 < s.y + s.h));
    if (need > s.w && free) s.w = need;
  }
  async function moveBook(isbn, sid, r) {
    await ready;
    const lib = cleanLibrary(getLibrary());
    placeBook(lib, isbn, sid, r);
    await saveLib(lib, { sid, r, isbn });
    const s = lib.shelves.find(x => x.id === sid);
    mtoast(s ? `→ ${s.label}${nRowsOf(s) > 1 ? ' · balda ' + (r + 1) : ''}` : '→ Sin clasificar');
  }
  async function newShelfWith(isbn, label) {
    await ready;
    const lib = cleanLibrary(getLibrary());
    const x = lib.shelves.length ? Math.min(...lib.shelves.map(s => s.x)) : 2;
    const y = lib.shelves.length ? Math.max(...lib.shelves.map(s => s.y + s.h)) + 2 : 6;
    const s = { id: 's' + Date.now().toString(36), label: label.slice(0, 60), x, y, w: 20, h: 6, books: [[]] };
    lib.shelves.push(s);
    placeBook(lib, isbn, s.id, 0);
    await saveLib(lib, { sid: s.id, r: 0, isbn });
    mtoast(`Nueva balda · ${s.label}`);
  }

  function dropTargets() {
    const lib = cleanLibrary(getLibrary()), out = [];
    for (const s of lib.shelves) for (let r = 0; r < nRowsOf(s); r++)
      out.push({ sid: s.id, r, name: s.label || 'Sin etiqueta', sub: nRowsOf(s) > 1 ? `balda ${r + 1}` : '', n: (s.books[r] || []).length });
    return out;
  }

  function buildShelfBrowser() {
    const view = $id('libView');
    if (!view || $id('sb')) return;
    view.insertAdjacentHTML('beforeend', `<div id="sb" class="sb"></div>
      <div id="sbDrop" class="sbdrop" aria-hidden="true"><div class="sbdh"><span class="mono-caps">Toca una balda o arrastra el libro</span>${ib('sbDropX', 'x', 'Cancelar')}</div><div class="sbgrid" id="sbGrid"></div></div>
      <div id="sbGhost" class="sbghost" hidden></div>
      <div id="sbNew" class="msheet" hidden><div class="msin"><div class="msh"><b>Nueva balda</b><span class="mono-caps" id="sbNewB"></span></div>
        <input id="sbNewIn" type="text" maxlength="40" placeholder="Nombre (p. ej. FANTASÍA)">
        <div class="msb">${ib('sbNewOk', 'check', 'Crear balda')}${ib('sbNewNo', 'x', 'Cancelar')}</div></div></div>`);
    const sb = $id('sb');
    let justDragged = false, pick = null;   // pick = menú de baldas abierto con el dedo ya levantado
    sb.addEventListener('click', e => {
      if (pick) { closeMenu(); return; }      // tocar fuera del menú lo cierra
      const sp = e.target.closest('.sp');
      if (!sp || justDragged) return;
      if (!sp.classList.contains('on')) return centerOn(sp);
      const row = sbRows[+sp.closest('.sbrow').dataset.row];
      if (typeof openDetail === 'function') openDetail(sp.dataset.isbn, row.books.map(b => b.isbn));
    });
    sb.addEventListener('contextmenu', e => e.preventDefault());

    // --- mantener pulsado + arrastrar ---
    let lp = null, drag = null;
    const ghost = $id('sbGhost'), grid = $id('sbGrid');
    sb.addEventListener('pointerdown', e => {
      const sp = e.target.closest('.sp.on'); if (!sp) return;
      lp = { sp, x: e.clientX, y: e.clientY, t: setTimeout(() => startDrag(), 420) };
    });
    const cancelLp = () => { if (lp) clearTimeout(lp.t); lp = null; };
    function startDrag() {
      const sp = lp.sp, r = sp.getBoundingClientRect();
      drag = { isbn: sp.dataset.isbn, x: lp.x, y: lp.y, over: null }; lp = null;
      navigator.vibrate?.(18);
      grid.innerHTML = dropTargets().map(t => `<div class="sbt" data-sid="${escH(t.sid)}" data-r="${t.r}"><b>${escH(t.name)}</b><span class="mono-caps">${escH(t.sub)}${t.sub ? ' · ' : ''}${t.n}</span></div>`).join('')
        + '<div class="sbt" data-sid="" data-r="0"><b>Sin clasificar</b><span class="mono-caps">montón</span></div>'
        + `<div class="sbt plus" data-new="1">${svg('plus')}</div>`;
      Object.assign(ghost.style, { width: r.width + 'px', height: r.height + 'px' });
      ghost.hidden = false; moveGhost(drag.x, drag.y);
      view.classList.add('sbdrag'); sp.classList.add('lifted');
    }
    function moveGhost(x, y) {
      ghost.style.transform = `translate(${x - ghost.offsetWidth / 2}px, ${y - ghost.offsetHeight / 2}px) rotate(-6deg)`;
      const t = document.elementFromPoint(x, y)?.closest('.sbt');
      if (t !== drag.over) { drag.over?.classList.remove('hov'); t?.classList.add('hov'); drag.over = t; }
      const gr = grid.getBoundingClientRect();   // auto-scroll si hay muchas baldas
      if (y > gr.bottom - 30) grid.scrollTop += 10; else if (y < gr.top + 20 && y > gr.top - 40) grid.scrollTop -= 10;
    }
    function closeMenu() {
      pick = null; ghost.hidden = true;
      view.classList.remove('sbdrag'); sb.querySelector('.sp.lifted')?.classList.remove('lifted');
      grid.querySelector('.hov')?.classList.remove('hov');
    }
    function act(isbn, t) {
      closeMenu();
      if (t.dataset.new) return askNewShelf(isbn);
      moveBook(isbn, t.dataset.sid || null, +t.dataset.r || 0);
    }
    function endDrag() {
      const d = drag; drag = null; ghost.hidden = true;
      justDragged = true; setTimeout(() => { justDragged = false; }, 350);
      if (d?.over) return act(d.isbn, d.over);              // arrastrado y soltado sobre una balda
      pick = { isbn: d.isbn };                              // soltado fuera: el menú se queda abierto para tocar o desplazar
    }
    grid.addEventListener('click', e => { const t = e.target.closest('.sbt'); if (t && pick) act(pick.isbn, t); });
    $id('sbDropX').onclick = closeMenu;
    document.addEventListener('pointermove', e => {
      if (lp && Math.hypot(e.clientX - lp.x, e.clientY - lp.y) > 8) cancelLp();
      if (drag) { drag.x = e.clientX; drag.y = e.clientY; moveGhost(e.clientX, e.clientY); }
    });
    document.addEventListener('pointerup', () => { cancelLp(); if (drag) endDrag(); });
    document.addEventListener('pointercancel', () => { cancelLp(); if (drag) endDrag(); });
    // mientras se arrastra, el dedo no debe desplazar las baldas
    document.addEventListener('touchmove', e => { if (drag) e.preventDefault(); }, { passive: false });

    let newIsbn = null;
    function askNewShelf(isbn) {
      newIsbn = isbn; const b = allBooks().find(x => x.isbn === isbn);
      $id('sbNewB').textContent = b ? b.title : ''; $id('sbNewIn').value = '';
      $id('sbNew').hidden = false; setTimeout(() => $id('sbNewIn').focus(), 50);
    }
    const closeNew = () => { $id('sbNew').hidden = true; newIsbn = null; };
    $id('sbNewNo').onclick = closeNew;
    $id('sbNew').addEventListener('click', e => { if (e.target.id === 'sbNew') closeNew(); });
    const okNew = () => { const v = $id('sbNewIn').value.trim(); if (!v) return $id('sbNewIn').focus(); const i = newIsbn; closeNew(); newShelfWith(i, v); };
    $id('sbNewOk').onclick = okNew;
    $id('sbNewIn').addEventListener('keydown', e => { if (e.key === 'Enter') okNew(); if (e.key === 'Escape') closeNew(); });

    // buscar: salta a la balda del primer libro que coincide y lo centra
    $id('lq')?.addEventListener('input', e => {
      const q = normS(e.target.value).trim();
      if (!narrow.matches || q.length < 2) return;
      for (let i = 0; i < sbRows.length; i++) {
        const b = sbRows[i].books.find(b => normS([b.title, b.authors, b.isbn, b.publisher].join(' ')).includes(q));
        if (!b) continue;
        const sec = sb.querySelector(`[data-row="${i}"]`);
        sb.scrollTo({ top: sec.offsetTop, behavior: 'smooth' });
        centerOn(sec.querySelector(`.sp[data-isbn="${CSS.escape(b.isbn)}"]`));
        return;
      }
    });
    // acceso directo al montón «Sin clasificar»
    view.querySelector('.libtools')?.insertAdjacentHTML('beforeend', `<button id="sbUnc" class="ibtn uncl" aria-label="Ir a Sin clasificar" title="Sin clasificar">${svg('inbox')}<b id="sbUncN"></b></button>`);
    $id('sbUnc').onclick = () => {
      const i = sbRows.findIndex(r => r.sid === null);
      if (i < 0) return mtoast('Todos tus libros están en una balda');
      sb.scrollTo({ top: sb.querySelector(`[data-row="${i}"]`).offsetTop, behavior: 'smooth' });
    };
    const apply = () => { view.classList.toggle('sbmode', narrow.matches); if (narrow.matches) renderShelves(); };
    narrow.addEventListener('change', apply);
    apply();
  }
  document.addEventListener('click', e => {
    if (!narrow.matches) return;
    if (e.target.closest?.('#tabLib')) requestAnimationFrame(() => renderShelves());
    if (e.target.closest?.('#tabCat')) requestAnimationFrame(() => mcRender());
  }, true);

  // ============================================================ aviso de nueva versión
  // al abrir la app mira la última Release de GitHub; si es más nueva, ofrece descargar la APK (Android la instala encima,
  // sin perder la biblioteca, porque va firmada con la misma clave)
  const REPO = 'KMN43/biblioscan';
  const vparts = v => String(v || '').replace(/^v/i, '').split('.').map(n => parseInt(n, 10) || 0);
  const newer = (a, b) => { const x = vparts(a), y = vparts(b); for (let i = 0; i < 3; i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0); return false; };
  async function latestRelease() {
    const [, body] = await httpGet(`https://api.github.com/repos/${REPO}/releases/latest`);
    const rel = JSON.parse(body), apk = (rel.assets || []).find(a => /\.apk$/i.test(a.name));
    return { tag: rel.tag_name, apk: apk?.browser_download_url || null };
  }
  // descarga la APK dentro de la app y abre el instalador de Android (un toque: «Actualizar»)
  const Installer = NATIVE ? CAP.registerPlugin('ApkInstaller') : null;
  let installing = false;
  // tras abrir Ajustes no llega ningún aviso de «has vuelto» a la web: se comprueba el permiso cada segundo (máx. 3 min)
  const waitPermission = () => new Promise(res => {
    const t0 = Date.now();
    const tick = async () => {
      let ok = false;
      try { ok = (await Installer.canInstall()).allowed; } catch {}
      if (ok || Date.now() - t0 > 180000) return res(ok);
      setTimeout(tick, 1000);
    };
    setTimeout(tick, 1000);
  });
  async function installUpdate(url, ui) {
    if (!Installer) { location.href = url; return; }          // navegador: descarga normal
    if (installing) return;
    installing = true;
    try {
      if (!(await Installer.canInstall()).allowed) {           // solo la primera vez
        ui.msg('Activa «Permitir de esta fuente» y vuelve');
        await Installer.openInstallSettings();
        if (!(await waitPermission())) { ui.msg('Sin permiso para instalar · vuelve a intentarlo'); return; }
        ui.msg('Permiso concedido · descargando…');
      }
      ui.progress(0);
      const h = await Installer.addListener('progress', p => ui.progress(p.percent));
      let res;
      try { res = await Installer.download({ url }); } finally { h.remove(); }
      ui.msg('Abriendo el instalador…');
      await Installer.install({ path: res.path });
    } catch (e) {
      if (e?.code === 'UNIMPLEMENTED') { location.href = url; return; }
      ui.msg('No se pudo actualizar: ' + (e?.message || e));
    } finally { installing = false; }
  }

  async function checkUpdate() {
    const mine = window.BIBLIO_VERSION;
    if (!NATIVE || !mine) return;
    try {
      const { tag: latest, apk } = await latestRelease();
      if (!apk || !newer(latest, mine) || lsGet('skipVersion', '') === latest) return;
      document.body.insertAdjacentHTML('beforeend', `
        <div id="upd" class="upd"><div><b>Nueva versión ${escH(latest.replace(/^v/i, ''))}</b><span class="mono-caps">Tienes la ${escH(mine)}</span></div>
          ${ib('updGo', 'download', 'Descargar e instalar', 'data-pri')}
          ${ib('updNo', 'x', 'Ahora no')}<div class="updbar"><i id="updBar"></i></div></div>`);
      const sub = $id('upd').querySelector('span'), bar = $id('updBar');
      $id('updNo').onclick = () => { lsSet('skipVersion', latest); $id('upd').remove(); };
      $id('updGo').onclick = () => installUpdate(apk, {
        msg: t => { sub.textContent = t; },
        progress: pct => { sub.textContent = pct >= 0 ? `Descargando ${pct} %` : 'Descargando…'; bar.style.width = Math.max(0, pct) + '%'; $id('upd').classList.add('dl'); },
      });
    } catch {}   // sin conexión o límite de la API de GitHub: ya avisará la próxima vez
  }

  // ============================================================ SCAN (móvil): «+» añadir · lupa consultar
  // la pantalla de entrada no enciende la cámara; solo los dos modos
  function setScanMode(m) {
    scanMode = m;
    const v = $id('scanView'); if (!v) return;
    v.dataset.mode = m || 'home';
    const badge = $id('scMode'); if (badge) badge.innerHTML = m ? svg(m === 'look' ? 'search' : 'plus') : '';
    cameraFor(!!m);
  }
  function buildScan() {
    const v = $id('scanView');
    if (!v || $id('scanHome')) return;
    v.insertAdjacentHTML('afterbegin', `
      <div id="scanHome" class="schome">
        <button id="scAdd" class="scc big" aria-label="Añadir libros a la biblioteca" title="Añadir libros">${svg('plus')}</button>
        <button id="scLook" class="scc small" aria-label="Consultar un libro sin añadirlo" title="Consultar">${svg('search')}</button>
      </div>`);
    v.querySelector('.viewport')?.insertAdjacentHTML('beforeend', `<div class="scbar">${ib('scBack', 'prev', 'Volver')}<span id="scMode" class="scmode"></span></div>`);
    $id('scAdd').onclick = () => setScanMode('add');
    $id('scLook').onclick = () => setScanMode('look');
    $id('scBack').onclick = () => setScanMode(null);
    $id('tabScan').addEventListener('click', () => setScanMode(null));   // cada visita empieza en los círculos
    setScanMode(null);
  }

  // --- modo consulta: ficha sin guardar, dónde lo tienes y ♡ wishlist ---
  let lookIsbn = null;
  function buildLook() {
    if ($id('lookSheet')) return;
    document.body.insertAdjacentHTML('beforeend', `
      <div id="lookSheet" class="msheet" hidden><div class="msin look">
        <div class="lkrow"><div class="lkcov" id="lkCov"></div>
          <div class="lkinfo"><div class="mono-caps lkst" id="lkSt"></div><h2 id="lkT"></h2><div class="lka" id="lkA"></div><div class="mono-caps lky" id="lkY"></div></div></div>
        <div id="lkWhere" class="lkwhere mono-caps" hidden></div>
        <div class="msb">${ib('lkWish', 'heart', 'Añadir a la wishlist')}${ib('lkAdd', 'plus', 'Añadir a mi biblioteca')}${ib('lkClose', 'x', 'Cerrar')}</div>
      </div></div>`);
    const close = () => {
      $id('lookSheet').hidden = true;
      try { if (lookIsbn) handled.set(lookIsbn, performance.now()); modalOpen = false; } catch {}
      lookIsbn = null;
    };
    $id('lkClose').onclick = close;
    $id('lookSheet').addEventListener('click', e => { if (e.target.id === 'lookSheet') close(); });
    $id('lkWish').onclick = async () => {
      await ready;
      const i = lookIsbn, w = wlGet(i);
      if (w) { wlDel(i); mtoast('Quitado de la wishlist'); }
      else { wlPut({ ...(lookData || {}), isbn: i }); mtoast('♡ Añadido a tu wishlist'); }
      paintWish(); if (MC.src === 'wish') mcRender();
    };
    $id('lkAdd').onclick = () => { const i = lookIsbn; close(); try { handled.delete(i); } catch {} origConfirm(i); };
  }
  let lookData = null;
  function paintWish() {
    const on = !!wlGet(lookIsbn), b = $id('lkWish');
    b.innerHTML = svg(on ? 'heartOn' : 'heart'); b.classList.toggle('primary', on);
    b.setAttribute('aria-label', on ? 'Quitar de la wishlist' : 'Añadir a la wishlist'); b.title = b.getAttribute('aria-label');
  }
  async function openLook(isbn) {
    await ready;
    isbn = cleanIsbn(isbn); lookIsbn = isbn; lookData = null;
    try { modalOpen = true; } catch {}
    const owned = books().find(b => b.isbn === isbn), wish = wlGet(isbn);
    const show = (b, status) => {
      lookData = b;
      $id('lkSt').textContent = status;
      $id('lkT').textContent = b?.title || `ISBN ${isbn}`;
      $id('lkA').textContent = b?.authors || '';
      $id('lkY').textContent = [b?.year, b?.publisher].filter(Boolean).join(' · ');
      const cov = b?.cover_url;
      $id('lkCov').innerHTML = cov ? `<img src="${escH(cov)}" alt="">` : '';
      $id('lkCov').querySelector('img')?.addEventListener('error', e => e.target.remove());
    };
    $id('lkWhere').hidden = !owned;
    $id('lkWish').hidden = !!owned; $id('lkAdd').hidden = !!owned;
    if (owned) {
      const where = (typeof shelfOf === 'function' && shelfOf(isbn)) || 'Sin clasificar · en el montón';
      $id('lkWhere').innerHTML = `<b>Ya lo tienes</b><span>${escH(where)}</span>`;
    }
    paintWish();
    $id('lookSheet').hidden = false;
    if (owned || wish) return show(owned || wish, owned ? 'En tu biblioteca' : '♡ En tu wishlist');
    show(null, 'Buscando…');
    try {
      const j = await (await fetch(`/api/lookup?isbn=${isbn}`)).json();
      if (lookIsbn !== isbn) return;
      if (j.found) show({ ...j.book, isbn, source: j.sources.join(' + ') }, `Encontrado en ${j.sources.join(' + ')}`);
      else show(null, 'No encontrado en Google Books, todostuslibros ni Open Library');
    } catch { if (lookIsbn === isbn) show(null, 'Sin conexión'); }
  }

  // en modo consulta, lo que index.html abriría como «confirmar y guardar» se abre como ficha de consulta
  let origConfirm = isbn => openConfirm(isbn);
  function hookConfirm() {
    if (typeof window.openConfirm !== 'function' || window.openConfirm.__bs) return;
    const orig = window.openConfirm;
    origConfirm = isbn => {
      const r = orig(isbn);
      if (wlGet(isbn)) Promise.resolve(r).then(() => { const st = $id('mStatus'); st.textContent = '♡ Está en tu wishlist · al guardarlo pasa a tu biblioteca'; st.className = 'mono-caps warn'; });
      return r;
    };
    const wrapped = isbn => (isPhone() && scanMode === 'look' && !$id('scanView').classList.contains('hidden')) ? openLook(isbn) : origConfirm(isbn);
    wrapped.__bs = true;
    window.openConfirm = wrapped;
  }

  // ============================================================ HOME · el sol de tu biblioteca
  // · un punto por página (hasta maxPoints) · semilla fija = nº de libros + nº de páginas (misma biblioteca → mismo sol)
  // · cada libro es un pozo de gravedad invisible en la esfera; sus páginas giran a su alrededor (granulación)
  //   y otras fluyen en arcos hacia los libros enlazados (protuberancias, «atmósfera»)
  // · los enlaces entre libros se reescriben poco a poco con una regla tipo Wolfram: {x,y} → {x,y},{y,z}
  // · se gira con el dedo, con inercia; solo visual. Mismo motor que el «Afinador del Sol».
  const SUN_DEFAULTS = {   // estética elegida con el afinador
    maxPoints: 36000, minPoints: 10500, radius: .22, cam: 1.6, spreadBase: .295, spreadMass: 1.05, swirl: .4, turb: .04,
    promFrac: .13, arcHeight: .75, arcSpeed: 1, links2: .45, drift: 1.9, rewire: 2.3, morph: 4.6, spin: .08, inertia: 1.2,
    dragGain: .8, bgColor: '#ff4f12', ptColor: '#fff4e1', dustColor: '#121212', ptSize: 2, front: .34, limb: 0, dust: .56,
    occlude: 0, glowBlur: 9, glowAlpha: .51, res: 1.7,
  };
  const SUN_REBUILD = new Set(['maxPoints', 'minPoints', 'spreadBase', 'spreadMass', 'turb', 'promFrac', 'links2', 'dust']);
  let SP = { ...SUN_DEFAULTS };
  try { SP = { ...SUN_DEFAULTS, ...JSON.parse(localStorage.getItem('sunPrefs') || '{}') }; } catch {}
  const saveSun = () => { try { localStorage.setItem('sunPrefs', JSON.stringify(SP)); } catch {} };
  const SUN = { on: false, raf: 0, key: '', S: null };

  function mulberry(a) { return () => { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
  const norm3 = v => { const l = Math.hypot(v[0], v[1], v[2]) || 1; return [v[0] / l, v[1] / l, v[2] / l]; };
  const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const randUnit = rnd => { const z = rnd() * 2 - 1, t = rnd() * 6.283185, r = Math.sqrt(1 - z * z); return [r * Math.cos(t), r * Math.sin(t), z]; };
  const basis = n => { const a = Math.abs(n[0]) < .9 ? [1, 0, 0] : [0, 1, 0], e1 = norm3(cross(n, a)); return [e1, cross(n, e1)]; };
  function rotAxis(v, k, ang) { const c = Math.cos(ang), s = Math.sin(ang), d = dot(k, v), cr = cross(k, v); return [v[0] * c + cr[0] * s + k[0] * d * (1 - c), v[1] * c + cr[1] * s + k[1] * d * (1 - c), v[2] * c + cr[2] * s + k[2] * d * (1 - c)]; }
  function slerp(a, b, t) { const d = Math.max(-1, Math.min(1, dot(a, b))), om = Math.acos(d); if (om < 1e-4) return a; const s = Math.sin(om), k1 = Math.sin((1 - t) * om) / s, k2 = Math.sin(t * om) / s; return [a[0] * k1 + b[0] * k2, a[1] * k1 + b[1] * k2, a[2] * k1 + b[2] * k2]; }

  function buildSun(list) {
    const P = SP;
    const pages = list.map(b => Math.max(40, parseInt(b.pages, 10) || 200)), total = pages.reduce((a, b) => a + b, 0);
    const seed = hash(`${list.length}:${total}`), rnd = mulberry(seed);
    const n = Math.max(P.minPoints, Math.min(P.maxPoints, total));
    const wells = pages.map(p => ({ u: randUnit(rnd), m: p / (total || 1), axis: randUnit(rnd), spin: (rnd() - .5) * .12 }));
    wells.forEach(w => { w.b = basis(w.u); });
    const links = [];
    const near = i => wells.map((w, j) => [j, dot(w.u, wells[i].u)]).filter(([j]) => j !== i).sort((a, b) => b[1] - a[1]).map(([j]) => j);
    if (wells.length > 1) wells.forEach((_, i) => { const nb = near(i); links.push({ a: i, b: nb[0], from: nb[0], mix: 1 }); if (rnd() < P.links2 && nb[1] != null) links.push({ a: i, b: nb[1], from: nb[1], mix: 1 }); });
    const S = { n, total, seed, rnd, wells, links, rewireAt: 3,
      own: new Int32Array(n), kind: new Uint8Array(n), r: new Float32Array(n), ph: new Float32Array(n), w: new Float32Array(n),
      t: new Float32Array(n), sp: new Float32Array(n), lk: new Int32Array(n), hh: new Float32Array(n), bri: new Float32Array(n) };
    const real = Math.min(n, total), cum = []; let acc = 0; pages.forEach(p => { acc += p; cum.push(acc); });
    const byWell = wells.map(() => []); links.forEach((l, i) => byWell[l.a].push(i));
    for (let i = 0, k = 0; i < n; i++) {
      S.bri[i] = .55 + rnd() * .45;
      if (i >= real || !wells.length) { S.kind[i] = 2; S.own[i] = -1; S.ph[i] = rnd(); S.r[i] = rnd(); S.w[i] = (rnd() - .5) * .05; S.bri[i] *= P.dust; continue; }
      const target = (i / real) * total; while (cum[k] < target && k < cum.length - 1) k++;
      S.own[i] = k;
      const my = byWell[k];
      if (my.length && rnd() < P.promFrac) {
        S.kind[i] = 1; S.lk[i] = my[Math.floor(rnd() * my.length)]; S.t[i] = rnd(); S.sp[i] = .03 + rnd() * .07;
        S.hh[i] = .06 + rnd() * .22 * (.5 + wells[k].m * 8);
      } else {
        S.kind[i] = 0;
        const spread = P.spreadBase + Math.sqrt(wells[k].m) * P.spreadMass;
        S.r[i] = Math.abs((rnd() + rnd() + rnd() - 1.5) / 1.5) * spread;
        S.ph[i] = rnd() * 6.283185; S.w[i] = (.25 + rnd() * .6) / (.15 + S.r[i] * 3) * (rnd() < .5 ? -1 : 1);
        S.hh[i] = rnd() * P.turb;
      }
    }
    return S;
  }
  // regla de reescritura (inspirada en Wolfram Physics): un enlace {x,y} se conserva y uno de los de y pasa a {y,z}
  function rewire(S) {
    if (S.links.length < 2 || S.wells.length < 3) return;
    const L = S.links[Math.floor(S.rnd() * S.links.length)], y = L.b, cand = S.links.filter(l => l.a === y), z = Math.floor(S.rnd() * S.wells.length);
    if (z === y || !cand.length) return;
    const tg = cand[Math.floor(S.rnd() * cand.length)]; if (tg.b === z) return;
    tg.from = tg.b; tg.b = z; tg.mix = 0;
  }
  const hexRgb = h => { const n = parseInt(String(h).slice(1), 16) || 0; return [n >> 16 & 255, n >> 8 & 255, n & 255]; };

  function startSun() {
    const cv = $id('sunCanvas'); if (!cv) return;
    $id('homeView').style.background = SP.bgColor;
    const list = books();
    const key = `${list.length}:${list.reduce((a, b) => a + (parseInt(b.pages, 10) || 0), 0)}`;
    if (SUN.key !== key || !SUN.S) { SUN.S = buildSun(list); SUN.key = key; }
    if (SUN.on) return;
    SUN.on = true;
    const ctx = cv.getContext('2d'), buf = document.createElement('canvas'), bctx = buf.getContext('2d');
    let W = 0, H = 0, img = null, px = null, scale = 1, last = performance.now(), slow = 0, M = SUN.M || [1, 0, 0, 0, 1, 0, 0, 0, 1];
    const rot = { vx: 0, vy: SP.spin, drag: null };
    const size = () => {
      scale = Math.min(devicePixelRatio || 1, SP.res);
      W = Math.max(1, Math.round(cv.clientWidth * scale)); H = Math.max(1, Math.round(cv.clientHeight * scale));
      cv.width = buf.width = W; cv.height = buf.height = H;
      img = bctx.createImageData(W, H); px = new Uint32Array(img.data.buffer);
    };
    size(); SUN.resize = size;
    const rx = (a, m) => { const c = Math.cos(a), s = Math.sin(a); return [m[0], m[1], m[2], c * m[3] - s * m[6], c * m[4] - s * m[7], c * m[5] - s * m[8], s * m[3] + c * m[6], s * m[4] + c * m[7], s * m[5] + c * m[8]]; };
    const ry = (a, m) => { const c = Math.cos(a), s = Math.sin(a); return [c * m[0] + s * m[6], c * m[1] + s * m[7], c * m[2] + s * m[8], m[3], m[4], m[5], -s * m[0] + c * m[6], -s * m[1] + c * m[7], -s * m[2] + c * m[8]]; };
    const applyRot = (ax, ay) => { M = ry(ay, rx(ax, M)); SUN.M = M; };
    cv.onpointerdown = e => { cv.setPointerCapture?.(e.pointerId); rot.drag = { x: e.clientX, y: e.clientY, t: performance.now() }; };
    cv.onpointermove = e => {
      const d = rot.drag; if (!d) return;
      const now = performance.now(), dt = Math.max(8, now - d.t) / 1000, k = SP.dragGain / Math.min(cv.clientWidth, cv.clientHeight);
      const dx = (e.clientX - d.x) * k, dy = (e.clientY - d.y) * k;
      applyRot(dy, dx); rot.vx = rot.vx * .4 + dy / dt * .6; rot.vy = rot.vy * .4 + dx / dt * .6; d.x = e.clientX; d.y = e.clientY; d.t = now;
    };
    cv.onpointerup = cv.onpointercancel = () => { rot.drag = null; };

    const frame = now => {
      if (!SUN.on) return;
      const P = SP, S = SUN.S, dt = Math.min(.05, (now - last) / 1000); last = now; const T = now / 1000;
      if (!rot.drag) { const f = 1 - Math.exp(-dt * P.inertia); rot.vx += (0 - rot.vx) * f; rot.vy += (P.spin - rot.vy) * f; applyRot(rot.vx * dt, rot.vy * dt); }
      for (const wl of S.wells) { wl.u = norm3(rotAxis(wl.u, wl.axis, wl.spin * P.drift * dt)); wl.b = basis(wl.u); }
      S.rewireAt -= dt; if (S.rewireAt <= 0) { rewire(S); S.rewireAt = P.rewire * (.67 + S.rnd() * .66); }
      for (const l of S.links) if (l.mix < 1) l.mix = Math.min(1, l.mix + dt / P.morph);
      px.fill(0);
      const R = Math.min(W, H) * P.radius, cx = W / 2, cy = H / 2, cam = P.cam, m = M, PT = hexRgb(P.ptColor), DU = hexRgb(P.dustColor), sz = P.ptSize | 0;
      for (let i = 0; i < S.n; i++) {
        let p, alt; const k = S.kind[i];
        if (k === 0) {
          const wl = S.wells[S.own[i]]; S.ph[i] += S.w[i] * P.swirl * dt;
          const a = S.ph[i], rr = S.r[i], c = Math.cos(rr), s = Math.sin(rr), e1 = wl.b[0], e2 = wl.b[1], ca = Math.cos(a), sa = Math.sin(a);
          p = [wl.u[0] * c + (e1[0] * ca + e2[0] * sa) * s, wl.u[1] * c + (e1[1] * ca + e2[1] * sa) * s, wl.u[2] * c + (e1[2] * ca + e2[2] * sa) * s];
          alt = 1 + S.hh[i] * (1 + Math.sin(T * 1.7 + i));
        } else if (k === 1) {
          const L = S.links[S.lk[i]], wa = S.wells[L.a].u, wb = S.wells[L.b].u;
          S.t[i] += S.sp[i] * P.arcSpeed * dt; if (S.t[i] > 1) S.t[i] -= 1;
          const tt = S.t[i]; let q = slerp(wa, wb, tt);
          if (L.mix < 1) q = slerp(slerp(wa, S.wells[L.from].u, tt), q, L.mix * L.mix * (3 - 2 * L.mix));
          p = q; alt = 1 + S.hh[i] * P.arcHeight * Math.sin(Math.PI * tt) * (.85 + .15 * Math.sin(T * 2 + i));
        } else {
          const a = S.ph[i] * 6.2832 + T * S.w[i], z = S.r[i] * 2 - 1, rr = Math.sqrt(1 - z * z); p = [rr * Math.cos(a), z, rr * Math.sin(a)]; alt = 1.002;
        }
        const x = (m[0] * p[0] + m[1] * p[1] + m[2] * p[2]) * alt, y = (m[3] * p[0] + m[4] * p[1] + m[5] * p[2]) * alt, z = (m[6] * p[0] + m[7] * p[1] + m[8] * p[2]) * alt;
        const f = cam / (cam - z), sx = (cx + x * R * f) | 0, sy = (cy - y * R * f) | 0;
        if (sx < 0 || sy < 0 || sx >= W || sy >= H) continue;
        if (P.occlude && z < 0 && Math.hypot(x, y) < .99) continue;
        const front = z >= 0, a = Math.min(1, (front ? P.front * (1 + z) : P.limb) * S.bri[i]);
        if (a <= 0) continue;
        const col = k === 2 && !front ? DU : PT, idx = sy * W + sx, prev = px[idx], pa = prev >>> 24, na = Math.min(255, pa + (a * 255 | 0));
        const mix = (sh, c) => { const pc = (prev >>> sh) & 255; return pa ? Math.round(pc + (c - pc) * a) : c; };
        const v = (na << 24) | (mix(16, col[2]) << 16) | (mix(8, col[1]) << 8) | mix(0, col[0]);
        const s2 = k === 2 ? 1 : sz;
        for (let oy = 0; oy < s2; oy++) for (let ox = 0; ox < s2; ox++) {
          if (sx + ox >= W || sy + oy >= H) continue;
          const q = idx + oy * W + ox; if (ox || oy) { if ((px[q] >>> 24) < (v >>> 24)) px[q] = v; } else px[q] = v;
        }
      }
      bctx.putImageData(img, 0, 0);
      ctx.clearRect(0, 0, W, H);
      if (SUN.glow !== false && P.glowBlur > 0 && P.glowAlpha > 0) { ctx.globalAlpha = P.glowAlpha; ctx.filter = `blur(${Math.round(P.glowBlur * scale)}px)`; ctx.drawImage(buf, 0, 0); }
      ctx.globalAlpha = 1; ctx.filter = 'none'; ctx.drawImage(buf, 0, 0);
      // si el móvil va justo: primero menos puntos, después sin resplandor
      if (dt > .034) slow++; else slow = Math.max(0, slow - 1);
      if (slow > 90) { if (S.n > 8000) S.n = Math.round(S.n * .65); else SUN.glow = false; slow = 0; }
      SUN.raf = requestAnimationFrame(frame);
    };
    SUN.raf = requestAnimationFrame(frame);
  }
  function stopSun() { SUN.on = false; cancelAnimationFrame(SUN.raf); }
  addEventListener('resize', () => SUN.on && SUN.resize?.());
  document.addEventListener('visibilitychange', () => { if (document.hidden) stopSun(); else if (homeOn && isPhone()) startSun(); });

  // --- configurador de la Home: lo básico para personalizar el sol (se guarda en este móvil) ---
  const THEMES = {
    sol:   { label: 'Sol', bgColor: '#ff4f12', ptColor: '#fff4e1', dustColor: '#121212' },
    noche: { label: 'Noche', bgColor: '#121212', ptColor: '#ffb08a', dustColor: '#ff4f12' },
    papel: { label: 'Papel', bgColor: '#ecebe6', ptColor: '#121212', dustColor: '#ff4f12' },
  };
  const SUN_UI = [
    ['maxPoints', 'Densidad', 6000, 40000, 500, v => `${Math.round(v / 1000)} mil puntos`],
    ['radius', 'Tamaño del sol', .14, .42, .01, v => `${Math.round(v * 100)} %`],
    ['spin', 'Velocidad de giro', 0, .6, .01, v => v < .005 ? 'quieto' : v.toFixed(2)],
    ['promFrac', 'Plasma entre libros', 0, .6, .01, v => `${Math.round(v * 100)} %`],
    ['swirl', 'Remolino de páginas', 0, 2, .05, v => v.toFixed(2)],
    ['front', 'Brillo', .1, 1, .01, v => `${Math.round(v * 100)} %`],
    ['glowAlpha', 'Resplandor', 0, 1, .01, v => `${Math.round(v * 100)} %`],
  ];
  function buildSunConfig() {
    const hv = $id('homeView'); if (!hv || $id('sunCfgBtn')) return;
    hv.insertAdjacentHTML('beforeend', `${ib('sunCfgBtn', 'sliders', 'Personalizar')}`);
    document.body.insertAdjacentHTML('beforeend', `
      <div id="sunCfg" class="msheet sunsheet" hidden><div class="msin">
        <div class="msh"><b>Personalizar</b><span class="mono-caps">Se guarda en este móvil</span></div>
        <div class="sthemes">${Object.entries(THEMES).map(([k, t]) => `<button class="sth" data-theme="${k}" aria-label="Tema ${t.label}" title="${t.label}" style="--a:${t.bgColor};--b:${t.ptColor}"></button>`).join('')}</div>
        <div class="sctl">${SUN_UI.map(([k, label, min, max, step]) => `
          <label class="sc"><span>${label}</span><output id="so_${k}"></output>
            <input type="range" id="sc_${k}" data-k="${k}" min="${min}" max="${max}" step="${step}"></label>`).join('')}</div>
        <div class="msb">${ib('sunReset', 'rotate', 'Restablecer')}${ib('sunCfgOk', 'check', 'Listo')}</div>
      </div></div>`);
    const sheet = $id('sunCfg');
    const paint = () => {
      SUN_UI.forEach(([k, , , , , fmtv]) => { $id('sc_' + k).value = SP[k]; $id('so_' + k).textContent = fmtv(+SP[k]); });
      sheet.querySelectorAll('.sth').forEach(b => b.classList.toggle('on', THEMES[b.dataset.theme].bgColor === SP.bgColor && THEMES[b.dataset.theme].ptColor === SP.ptColor));
      $id('homeView').style.background = SP.bgColor;
    };
    let rbT = 0;
    const apply = k => {
      saveSun(); paint();
      if (SUN_REBUILD.has(k)) { clearTimeout(rbT); rbT = setTimeout(() => { SUN.S = buildSun(books()); }, 200); }
    };
    sheet.querySelectorAll('input[type=range]').forEach(el => el.addEventListener('input', () => { SP[el.dataset.k] = +el.value; apply(el.dataset.k); }));
    sheet.querySelectorAll('.sth').forEach(b => b.onclick = () => { const t = THEMES[b.dataset.theme]; Object.assign(SP, { bgColor: t.bgColor, ptColor: t.ptColor, dustColor: t.dustColor }); apply('bgColor'); });
    $id('sunReset').onclick = () => { SP = { ...SUN_DEFAULTS }; SUN.glow = undefined; apply('maxPoints'); };
    const close = () => { sheet.hidden = true; };
    $id('sunCfgOk').onclick = close;
    sheet.addEventListener('click', e => { if (e.target === sheet) close(); });
    $id('sunCfgBtn').onclick = () => { paint(); sheet.hidden = false; };
  }

  // ============================================================ JUNTAR SOLES
  // Proximidad: busca otro móvil cercano con «Juntar soles» abierto; al acercarlos los soles se atraen, se pasan
  // plasma y, en contacto, colisionan entre las dos pantallas. Colisión: demostración con un amigo simulado.
  // Física del encuentro: Narasimha Rao, Alladin y Narasimhan (1994).
  const DUO_P = {   // estética elegida con el prototipo «Colisión de Soles»
    vRatio: 1.15, pRatio: 2.08, halo: 1, tidal: 2.95, speed: .55, far: 22, near: 6, contact: 1.5,
    bulge: 1.5, tail: .51, pull: .84, repel: .3, transfer: .59, bridgeH: 1.35, damp: .35, heat: 0, spinUp: 1.2, grow: .6, points: 9000,
  };
  const DUO = { on: false, mode: lsGet('duoMode', 'prox'), friend: lsGet('duoFriend', 'mid'), raf: 0, suns: null, mine: null, distS: 20, enc: {}, setup: true, glow: true };
  const smoothstep = (a, b, x) => { const t = Math.max(0, Math.min(1, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
  function duoFriendList(kind) {
    const n = { small: 25, mid: 120, big: 400 }[kind] || 120, r = mulberry(hash('amigo:' + kind));
    return Array.from({ length: n }, () => ({ pages: Math.round(80 + r() * r() * 700) }));
  }
  function duoMakeSun(list, si) {
    const keep = SP;
    SP = { ...SP, maxPoints: DUO_P.points, minPoints: 3000 };
    const S = buildSun(list);
    SP = keep;
    S.br = new Float32Array(S.n); S.bt = new Float32Array(S.n);
    for (let i = 0; i < S.n; i++) { S.br[i] = S.rnd(); S.bt[i] = S.rnd(); }
    S.M = [1, 0, 0, 0, 1, 0, 0, 0, 1]; S.rot = { vx: 0, vy: .08 * (si ? -1 : 1), drag: null };
    return S;
  }
  function duoBuild() {
    DUO.mine = duoMakeSun(books(), 0);
    DUO.suns = [DUO.mine, duoMakeSun(duoFriendList(DUO.friend), 1)]; DUO.setup = true;
  }
  // --- física del encuentro (unidades: R = 1, G (M1 + M2) = 1) ---
  function duoEncSetup(rStart, m1, m2) {
    const shared = m1 != null, P = DUO_P, M1 = shared ? m1 : DUO.suns[0].total, M2 = shared ? m2 : DUO.suns[1].total, Mt = M1 + M2;
    const E = DUO.enc = { M1, M2, phase: 'run', merged: 0, t: 0, shared };
    E.eps = Math.SQRT2 * (1 / 6 + P.halo * (1 / 2 - 1 / 6)) * 2.2;
    const p = E.p = Math.min(P.pRatio * E.eps, rStart * .8);
    E.vesc = Math.sqrt(2 / Math.sqrt(p * p + E.eps * E.eps)); E.vp = P.vRatio * E.vesc; E.h = p * E.vp; E.bound = P.vRatio <= 1.0001;
    E.xi = [M2, M1].map(Mo => 3 * (2 * Mo / Mt) * .5 / (E.vp * E.vp * E.eps) * Math.exp(-p / E.eps)); E.acc = [0, 0];
    if (!E.bound) {
      E.vinf = Math.sqrt(Math.max(1e-6, E.vp * E.vp - E.vesc * E.vesc));
      const pe = p / E.eps, a = pe <= .5 ? 1 : pe <= 1.2 ? 1.5 : 2;
      E.phi = Math.max(.02, Math.min(Math.PI * .97, a * (1 - Math.exp(-pe)) * Math.atan(1 / (E.h * E.vinf))));
      E.e = 1 / Math.sin(E.phi / 2); E.ell = p * (1 + E.e); E.thInf = Math.acos(-1 / E.e);
      E.th0 = -Math.acos(Math.max(-1, Math.min(1, (E.ell / rStart - 1) / E.e))); E.theta = E.th0; E.rot = -E.th0;
    } else {
      const r0 = rStart, En = E.vp * E.vp / 2 - 1 / Math.sqrt(p * p + E.eps * E.eps), v0 = Math.sqrt(Math.max(0, 2 * (En + 1 / Math.sqrt(r0 * r0 + E.eps * E.eps))));
      const vt = Math.min(v0, E.h / r0); E.r = [r0, 0]; E.v = [-Math.sqrt(Math.max(0, v0 * v0 - vt * vt)), vt];
    }
  }
  function duoEncStep(dt, rStart) {
    const E = DUO.enc, sp = DUO_P.speed * 1.4;
    if (E.phase === 'pause') { E.pause -= dt; if (E.pause <= 0) { if (E.shared) LINK.shared = null; else duoEncSetup(rStart); } return; }
    let qx, qy;
    if (!E.bound) {
      const r = E.ell / (1 + E.e * Math.cos(E.theta)); E.theta += E.h / (r * r) * dt * sp;
      const rr = E.ell / (1 + E.e * Math.cos(E.theta)); qx = rr * Math.cos(E.theta + E.rot); qy = rr * Math.sin(E.theta + E.rot);
      if (E.theta > -E.th0 * 1.25 || E.theta > E.thInf * .995 || rr > rStart * 1.9) { E.phase = 'pause'; E.pause = 1.6; }
    } else {
      for (let k = 0; k < 6; k++) {
        const h = dt * sp / 6, x = E.r[0], y = E.r[1], f = -1 / Math.pow(x * x + y * y + E.eps * E.eps, 1.5), close = Math.max(0, 1 - Math.hypot(x, y) / (E.eps * 1.8));
        E.v[0] += x * f * h; E.v[1] += y * f * h; E.v[0] *= 1 - close * 1.6 * h; E.v[1] *= 1 - close * 1.6 * h; E.r[0] += E.v[0] * h; E.r[1] += E.v[1] * h;
      }
      qx = E.r[0]; qy = E.r[1];
      if (Math.hypot(qx, qy) < .25) E.merged = Math.min(1, E.merged + dt * .5);
      if (E.merged >= 1) { E.t += dt; if (E.t > 4) { E.phase = 'pause'; E.pause = 1; } }
    }
    E.rel = [qx, qy];
    const d = Math.hypot(qx, qy), nearF = Math.exp(-Math.pow(Math.max(0, d - E.p) / (E.eps * 1.2), 2)), after = !E.bound ? (E.theta > 0 ? 2 : 1) : 1.5;
    for (let s = 0; s < 2; s++) E.acc[s] = Math.min(E.xi[s] * 3, E.acc[s] + E.xi[s] * nearF * after * dt * sp * .9);
  }
  const xiType = x => x < 1e-3 ? 'A1' : x < 1e-2 ? 'A2' : x < .1 ? 'A3' : x < .4 ? 'B1' : x < .7 ? 'B2' : x < 1 ? 'B3' : 'disrupción';

  // ---------- conexión real con otro móvil (complemento nativo SunLink: Nearby Connections + Bluetooth LE) ----------
  // Se intercambia solo la «huella» (páginas de cada libro, sin títulos ni ISBN). La distancia sale de la señal
  // Bluetooth que mide cada móvil del otro (media de los dos). Los móviles se juntan por la parte de arriba:
  // cada pantalla dibuja su sol y el del amigo queda al otro lado del borde superior.
  const SunLink = NATIVE ? CAP.registerPlugin('SunLink') : null;
  const LINK = { state: 'off', tag: '', peerTag: '', peerSun: null, peerN: 0, rs: [], peerRssi: null, dist: null, sentAt: 0,
                 rtt: 120, contactT: 0, armed: true, shared: null, err: '', subs: null };
  // señal Bluetooth → cm: con los móviles tocándose la señal ronda RSSI_C (−42 dBm); cada 17 dB menos, ×10 la distancia
  // (−50 ≈ 3 cm · −60 ≈ 13 cm · −70 ≈ 50 cm). Aproximado: depende del móvil, la funda y la mano.
  const RSSI_C = +lsGet('duoRssiC', -42);
  function linkDist() {
    if (!LINK.rs.length) return;
    const mine = [...LINK.rs].sort((a, b) => a - b)[LINK.rs.length >> 1];
    const both = LINK.peerRssi == null ? mine : (mine + LINK.peerRssi) / 2;
    LINK.dist = Math.max(0, Math.min(300, 1.2 * Math.pow(10, (RSSI_C - both) / 17)));
    return mine;
  }
  const linkTag = () => Array.from(crypto.getRandomValues(new Uint8Array(4)), b => b.toString(16).padStart(2, '0')).join('');
  const lowMe = () => LINK.tag < LINK.peerTag;   // el «sol 1» del encuentro es el del móvil con la marca menor
  function linkSend(o) { if (SunLink && LINK.state === 'on') SunLink.send({ data: JSON.stringify(o) }).catch(() => {}); }
  function linkStartShared(m1, m2) { LINK.shared = { m1, m2 }; LINK.armed = false; LINK.contactT = 0; DUO.setup = true; }
  function linkBoom() {
    if (LINK.state !== 'on' || !LINK.peerSun || LINK.shared) return;
    const me = DUO.mine.total, fr = LINK.peerSun.total, m1 = lowMe() ? me : fr, m2 = lowMe() ? fr : me;
    linkSend({ t: 'boom', m1, m2 });
    setTimeout(() => linkStartShared(m1, m2), Math.min(400, LINK.rtt / 2));   // el otro empieza al recibirlo
  }
  function linkEvent(ev, d = {}) {
    if (ev === 'found') { if (LINK.state === 'search') LINK.state = 'found'; }
    else if (ev === 'connected') {
      LINK.state = 'on'; LINK.err = '';
      linkSend({ t: 'hi', v: 1, tag: LINK.tag, pages: books().slice(0, 4000).map(b => parseInt(b.pages, 10) || 0) });
      linkSend({ t: 'ping', at: performance.now() });
    } else if (ev === 'disconnected') {
      Object.assign(LINK, { peerSun: null, peerTag: '', peerN: 0, rs: [], peerRssi: null, dist: null, shared: null });
      if (LINK.state !== 'off') linkStart();   // vuelve a buscar
    } else if (ev === 'error') { LINK.err = d.message || 'Error'; }
    else if (ev === 'rssi') {
      if (!LINK.peerTag || d.tag !== LINK.peerTag) return;
      LINK.rs.push(d.rssi); if (LINK.rs.length > 9) LINK.rs.shift();
      const mine = linkDist(), now = performance.now(); if (now - LINK.sentAt > 300) { LINK.sentAt = now; linkSend({ t: 'd', r: mine }); }
    } else if (ev === 'message') {
      let m; try { m = JSON.parse(d.data); } catch { return; }
      if (m.t === 'hi' && Array.isArray(m.pages)) {
        LINK.peerTag = String(m.tag || ''); LINK.peerN = m.pages.length;
        LINK.peerSun = duoMakeSun(m.pages.map(p => ({ pages: p })), 1);
      } else if (m.t === 'ping') linkSend({ t: 'pong', at: m.at });
      else if (m.t === 'pong') LINK.rtt = performance.now() - m.at;
      else if (m.t === 'd') { LINK.peerRssi = m.r; linkDist(); }
      else if (m.t === 'boom' && !LINK.shared) linkStartShared(m.m1, m.m2);
    }
  }
  async function linkStart() {
    if (!SunLink) { LINK.state = 'nativo'; return; }
    try {
      if (!LINK.subs) LINK.subs = ['found', 'connected', 'disconnected', 'message', 'rssi', 'error'].map(ev => SunLink.addListener(ev, d => linkEvent(ev, d)));
      const p = await SunLink.ensurePermissions();
      if (!p.granted) { LINK.state = 'perm'; return; }
      LINK.tag = linkTag(); LINK.state = 'search';
      await SunLink.start({ tag: LINK.tag });
    } catch (e) { LINK.state = 'error'; LINK.err = e.message || String(e); }
  }
  function linkStop() {
    Object.assign(LINK, { state: 'off', peerSun: null, peerTag: '', peerN: 0, rs: [], peerRssi: null, dist: null, shared: null });
    SunLink?.stop().catch(() => {});
  }
  if (!NATIVE) window.__sunlink = linkEvent;   // solo en el navegador, para probar la interfaz sin dos móviles

  function buildDuo() {
    const hv = $id('homeView'); if (!hv || $id('duo')) return;
    hv.insertAdjacentHTML('beforeend', `${ib('duoBtn', 'orbit', 'Juntar soles')}
      <div id="duo" class="duo" hidden>
        <canvas id="duoCanvas" aria-label="Tu sol y el de un amigo"></canvas>
        <div class="duotop">${ib('duoBack', 'prev', 'Volver')}
          <div class="dseg" role="group" aria-label="Modo"><button id="duoProx" type="button">Proximidad</button><button id="duoEnc" type="button">Colisión</button></div>
          ${ib('duoAgain', 'rotate', 'Repetir la colisión')}</div>
        <div class="duohud mono-caps" id="duoHud"></div>
        <div class="duofoot"><select id="duoFriend" aria-label="Biblioteca del amigo">
          <option value="small">Amigo con 25 libros</option><option value="mid">Amigo con 120 libros</option><option value="big">Amigo con 400 libros</option></select>
          <span class="mono-caps" id="duoHint"></span></div>
      </div>`);
    $id('duoFriend').value = DUO.friend;
    $id('duoBtn').onclick = openDuo;
    $id('duoBack').onclick = closeDuo;
    $id('duoProx').onclick = () => setDuoMode('prox');
    $id('duoEnc').onclick = () => setDuoMode('enc');
    $id('duoAgain').onclick = () => { if (DUO.mode === 'prox') linkBoom(); else DUO.setup = true; };
    $id('duoFriend').onchange = e => { DUO.friend = e.target.value; lsSet('duoFriend', DUO.friend); duoBuild(); };
    // arrastrar gira un sol: en proximidad el tuyo; en la demo, el que tocas
    const cv = $id('duoCanvas'); let drag = null;
    cv.addEventListener('pointerdown', e => { cv.setPointerCapture?.(e.pointerId); drag = { x: e.clientX, y: e.clientY, fx: DUO.fx, fy: DUO.fy, t: performance.now(), si: DUO.mode === 'enc' && e.clientY < cv.clientHeight / 2 ? 1 : 0 }; });
    cv.addEventListener('pointermove', e => {
      if (!drag) return;
      {
        const S = drag.si ? DUO.suns[1] : DUO.mine, now = performance.now(), dt = Math.max(8, now - drag.t) / 1000, k = .8 / Math.min(cv.clientWidth, cv.clientHeight);
        const dx = (e.clientX - drag.x) * k, dy = (e.clientY - drag.y) * k;
        S.M = rotY(dx, rotX(dy, S.M)); S.rot.vx = S.rot.vx * .4 + dy / dt * .6; S.rot.vy = S.rot.vy * .4 + dx / dt * .6;
        drag.x = e.clientX; drag.y = e.clientY; drag.t = now;
      }
    });
    const up = () => { drag = null; };
    cv.addEventListener('pointerup', up); cv.addEventListener('pointercancel', up);
  }
  function setDuoMode(m) {
    DUO.mode = m; lsSet('duoMode', m); DUO.setup = true;
    $id('duoProx').classList.toggle('on', m === 'prox'); $id('duoEnc').classList.toggle('on', m === 'enc');
    $id('duoAgain').hidden = m !== 'enc';
    $id('duoFriend').hidden = m !== 'enc';
    $id('duoHint').textContent = m === 'prox' ? '' : 'Demostración con un amigo simulado · arrastra un sol para girarlo';
    if (m === 'prox') linkStart(); else linkStop();
  }
  function openDuo() {
    stopSun(); $id('duo').hidden = false; $id('sunCfgBtn').hidden = true; $id('duoBtn').hidden = true;
    if (!DUO.suns) duoBuild();
    setDuoMode(DUO.mode); startDuo();
  }
  function closeDuo() {
    stopDuo(); linkStop(); $id('duo').hidden = true; $id('sunCfgBtn').hidden = false; $id('duoBtn').hidden = false; startSun();
  }
  const rotX = (a, m) => { const c = Math.cos(a), s = Math.sin(a); return [m[0], m[1], m[2], c * m[3] - s * m[6], c * m[4] - s * m[7], c * m[5] - s * m[8], s * m[3] + c * m[6], s * m[4] + c * m[7], s * m[5] + c * m[8]]; };
  const rotY = (a, m) => { const c = Math.cos(a), s = Math.sin(a); return [c * m[0] + s * m[6], c * m[1] + s * m[7], c * m[2] + s * m[8], m[3], m[4], m[5], -s * m[0] + c * m[6], -s * m[1] + c * m[7], -s * m[2] + c * m[8]]; };

  function startDuo() {
    if (DUO.on) return; DUO.on = true;
    const cv = $id('duoCanvas'), ctx = cv.getContext('2d'), buf = document.createElement('canvas'), bctx = buf.getContext('2d');
    let W = 0, H = 0, img, px, scale = 1, last = performance.now(), slow = 0;
    const size = () => {
      scale = Math.min(devicePixelRatio || 1, 1.5);
      W = Math.max(1, Math.round(cv.clientWidth * scale)); H = Math.max(1, Math.round(cv.clientHeight * scale));
      cv.width = buf.width = W; cv.height = buf.height = H; img = bctx.createImageData(W, H); px = new Uint32Array(img.data.buffer); DUO.setup = true;
    };
    size(); DUO.resize = size;
    const PT = hexRgb(SP.ptColor), HOT = [255, 255, 255], BGC = SP.bgColor;
    const frame = now => {
      if (!DUO.on) return;
      const P = DUO_P, dt = Math.min(.05, (now - last) / 1000); last = now; const T = now / 1000;
      const R = Math.min(W, H) * .2, pxPerCm = W / 7;          // una pantalla ≈ 7 cm de ancho
      const prox = DUO.mode === 'prox', HOME = 2.2 * R;          // en proximidad, tu sol a 2,2 R del borde de arriba
      let A, B, suns, st = [{}, {}], hudTxt = '', hint = '', enc = !prox, encA, encB, swap = false;
      if (prox) {
        const peer = LINK.state === 'on' ? LINK.peerSun : null;
        suns = peer ? [DUO.mine, peer] : [DUO.mine];
        DUO.distS += ((LINK.dist ?? 12) - DUO.distS) * (1 - Math.exp(-dt / P.damp));
        A = [W / 2, HOME]; B = [W / 2, -HOME - DUO.distS * pxPerCm];    // el sol del amigo, al otro lado del borde superior
        if (LINK.shared && peer) {                                   // colisión entre las dos pantallas, juntas por arriba
          enc = true; swap = !lowMe();
          encA = swap ? [W / 2, -HOME] : [W / 2, HOME]; encB = swap ? [W / 2, HOME] : [W / 2, -HOME];
        } else if (peer) {
          const K = 1 - smoothstep(P.near, P.far, DUO.distS), C = 1 - smoothstep(P.contact * .5, P.contact * 1.6 + .2, DUO.distS);
          for (let si = 0; si < 2; si++) {
            const dir = si ? -1 : 1, pull = dir * (P.pull * K - P.repel * C) * R * .9, H0 = si ? B : A;
            st[si] = { cx: H0[0], cy: H0[1] - pull, d: [0, -dir], K, C, spin: dir };
          }
          if (DUO.distS < P.contact) { LINK.contactT += dt; if (LINK.armed && LINK.contactT > 1.2 && lowMe()) linkBoom(); }
          else { LINK.contactT = 0; if (DUO.distS > P.contact * 3) LINK.armed = true; }
          hudTxt = `${LINK.dist == null ? '¿? cm' : DUO.distS.toFixed(1) + ' cm'} · ${C > .5 ? 'contacto' : K > .5 ? 'cerca' : K > .02 ? 'se notan' : 'lejos'}`;
          hint = `Sol de ${LINK.peerN} libros conectado · juntad los móviles por la parte de arriba`;
        } else {
          st[0] = { cx: A[0], cy: A[1], d: [0, -1], K: 0, C: 0, spin: 1 };
          const S = LINK.state;
          hudTxt = S === 'nativo' ? 'Solo en la app de Android' : S === 'perm' ? 'Sin permiso de dispositivos cercanos' : S === 'error' ? 'No se pudo buscar'
            : S === 'on' ? 'Conectado · recibiendo su sol…' : S === 'found' ? 'Sol encontrado · conectando…' : 'Buscando otro sol cerca' + '.'.repeat(1 + (T | 0) % 3);
          hint = S === 'perm' ? 'Permite «Dispositivos cercanos» y vuelve a entrar' : S === 'error' ? LINK.err
            : 'Pide a tu amigo que abra Juntar soles → Proximidad';
          if (LINK.err && S !== 'error') hint = LINK.err;
        }
        $id('duoAgain').hidden = !peer || !!LINK.shared;
      } else {
        suns = DUO.suns; A = [W / 2, H * .72]; B = [W / 2, H * .28]; encA = A; encB = B;
      }
      if (enc) {
        const vx0 = encB[0] - encA[0], vy0 = encB[1] - encA[1], cd = Math.hypot(vx0, vy0) || 1, ux = vx0 / cd, uy = vy0 / cd;
        const rStart = cd / R, sh = prox ? LINK.shared : null;
        if (DUO.setup) { sh ? duoEncSetup(rStart, sh.m1, sh.m2) : duoEncSetup(rStart); DUO.setup = false; }
        duoEncStep(dt, rStart);
        const E = DUO.enc, rel = E.rel || [rStart, 0], psi = Math.atan2(uy, ux), Mt = E.M1 + E.M2;
        const qx = rel[0] * Math.cos(psi) + rel[1] * Math.sin(psi), qy = rel[0] * Math.sin(psi) - rel[1] * Math.cos(psi);
        const bx = (E.M1 * encA[0] + E.M2 * encB[0]) / Mt, by = (E.M1 * encA[1] + E.M2 * encB[1]) / Mt;
        const c = [[bx - qx * R * E.M2 / Mt, by - qy * R * E.M2 / Mt], [bx + qx * R * E.M1 / Mt, by + qy * R * E.M1 / Mt]];
        const dist = Math.hypot(qx, qy), dx = qx / (dist || 1), dy = qy / (dist || 1), contact = 1 - smoothstep(E.eps * .35, E.eps * 1.3, dist);
        for (let si = 0; si < 2; si++) {
          const K = Math.min(1.4, E.acc[si] * P.tidal + (1 - smoothstep(E.eps * .8, E.eps * 3.5, dist)) * .35);
          st[swap ? 1 - si : si] = { cx: c[si][0], cy: c[si][1], d: si ? [-dx, -dy] : [dx, dy], K, C: contact, spin: si ? -1 : 1, merge: E.merged };
        }
        hudTxt = E.bound ? `fusión ${Math.round(E.merged * 100)} % · ξ ${xiType(E.xi[0])}` : `desviación ${(E.phi * 180 / Math.PI).toFixed(1)}° · marea ${xiType(E.xi[0])} / ${xiType(E.xi[1])}`;
        if (prox) hint = '¡Colisión!';
      }
      if (suns.length > 1) { st[0].ox = st[1].cx; st[0].oy = st[1].cy; st[1].ox = st[0].cx; st[1].oy = st[0].cy; }
      $id('duoHud').textContent = hudTxt;
      if (prox && $id('duoHint').textContent !== hint) $id('duoHint').textContent = hint;
      px.fill(0);
      for (let si = 0; si < suns.length; si++) {
        const S = suns[si], o = st[si], K = o.K, C = o.C, Rs = R * (1 + P.grow * Math.min(1, K)) * (1 - .25 * (o.merge || 0));
        const dwx = o.d[0], dwy = -o.d[1], m0 = S.rot;
        if (!m0.drag) { const f = 1 - Math.exp(-dt * SP.inertia), base = .08 * (1 + P.spinUp * Math.min(1, K)) * o.spin; m0.vx += -m0.vx * f; m0.vy += (base - m0.vy) * f; S.M = rotY(m0.vy * dt, rotX(m0.vx * dt, S.M)); }
        for (const wl of S.wells) { wl.u = norm3(rotAxis(wl.u, wl.axis, wl.spin * SP.drift * dt)); wl.b = basis(wl.u); }
        S.rewireAt -= dt; if (S.rewireAt <= 0) { rewire(S); S.rewireAt = SP.rewire * (.67 + S.rnd() * .66); }
        for (const l of S.links) if (l.mix < 1) l.mix = Math.min(1, l.mix + dt / SP.morph);
        const m = S.M, cam = SP.cam;
        for (let i = 0; i < S.n; i++) {
          let p, alt; const k = S.kind[i];
          if (k === 2) continue;
          if (k === 0) { const wl = S.wells[S.own[i]]; S.ph[i] += S.w[i] * SP.swirl * (1 + P.spinUp * Math.min(1, K) * .5) * dt;
            const a = S.ph[i], rr = S.r[i], c = Math.cos(rr), s = Math.sin(rr), e1 = wl.b[0], e2 = wl.b[1], ca = Math.cos(a), sa = Math.sin(a);
            p = [wl.u[0] * c + (e1[0] * ca + e2[0] * sa) * s, wl.u[1] * c + (e1[1] * ca + e2[1] * sa) * s, wl.u[2] * c + (e1[2] * ca + e2[2] * sa) * s]; alt = 1 + S.hh[i] * (1 + Math.sin(T * 1.7 + i)); }
          else { const L = S.links[S.lk[i]], wa = S.wells[L.a].u, wb = S.wells[L.b].u; S.t[i] += S.sp[i] * SP.arcSpeed * dt; if (S.t[i] > 1) S.t[i] -= 1;
            const tt = S.t[i]; let q = slerp(wa, wb, tt); if (L.mix < 1) q = slerp(slerp(wa, S.wells[L.from].u, tt), q, L.mix * L.mix * (3 - 2 * L.mix));
            p = q; alt = 1 + S.hh[i] * SP.arcHeight * Math.sin(Math.PI * tt) * (.85 + .15 * Math.sin(T * 2 + i)); }
          let x = (m[0] * p[0] + m[1] * p[1] + m[2] * p[2]) * alt, y = (m[3] * p[0] + m[4] * p[1] + m[5] * p[2]) * alt, z = (m[6] * p[0] + m[7] * p[1] + m[8] * p[2]) * alt;
          const face = Math.max(0, x * dwx + y * dwy), amt = K * (P.bulge * face * face + (k === 1 ? P.tail * face * face * face : 0)) * .9;
          x += dwx * amt; y += dwy * amt;
          const f = cam / (cam - z); let sx = o.cx + x * Rs * f, sy = o.cy - y * Rs * f, hot = Math.min(1, K) * face * P.heat;
          if (k === 1 && C > 0 && S.br[i] < P.transfer) {
            S.bt[i] += dt * (.18 + S.sp[i] * 2); if (S.bt[i] > 1) S.bt[i] -= 1;
            const bt = S.bt[i], tx = o.ox - o.d[0] * R * .85, ty = o.oy - o.d[1] * R * .85, nx = -o.d[1], ny = o.d[0];
            const lift = Math.sin(Math.PI * bt) * P.bridgeH * R * (.4 + S.hh[i] * 2);
            sx += ((sx + (tx - sx) * bt + nx * lift) - sx) * C; sy += ((sy + (ty - sy) * bt + ny * lift) - sy) * C; hot = Math.max(hot, C * P.heat);
          }
          if (z < 0) continue;
          const lx = sx | 0, ly = sy | 0;
          if (lx < 0 || ly < 0 || lx >= W - 1 || ly >= H - 1) continue;
          const a = Math.min(1, SP.front * (1 + z) * S.bri[i] * (1 + hot * .8));
          const r0 = PT[0] + (HOT[0] - PT[0]) * hot, g0 = PT[1] + (HOT[1] - PT[1]) * hot, b0 = PT[2] + (HOT[2] - PT[2]) * hot;
          const idx = ly * W + lx, prev = px[idx], pa = prev >>> 24, na = Math.min(255, pa + (a * 255 | 0));
          const mix = (sh, cc) => { const pc = (prev >>> sh) & 255; return pa ? Math.round(pc + (cc - pc) * a) : cc | 0; };
          const val = (na << 24) | (mix(16, b0) << 16) | (mix(8, g0) << 8) | mix(0, r0);
          px[idx] = val; if ((px[idx + 1] >>> 24) < na) px[idx + 1] = val; if ((px[idx + W] >>> 24) < na) px[idx + W] = val; if ((px[idx + W + 1] >>> 24) < na) px[idx + W + 1] = val;
        }
      }
      bctx.putImageData(img, 0, 0);
      ctx.fillStyle = BGC; ctx.fillRect(0, 0, W, H);
      if (DUO.glow) { ctx.globalAlpha = SP.glowAlpha; ctx.filter = `blur(${Math.round(SP.glowBlur * scale)}px)`; ctx.drawImage(buf, 0, 0); }
      ctx.globalAlpha = 1; ctx.filter = 'none'; ctx.drawImage(buf, 0, 0);
      if (dt > .034) slow++; else slow = Math.max(0, slow - 1);
      if (slow > 90) { if (suns[0].n > 4000) suns.forEach(S => { S.n = Math.round(S.n * .7); }); else DUO.glow = false; slow = 0; }
      DUO.raf = requestAnimationFrame(frame);
    };
    DUO.raf = requestAnimationFrame(frame);
  }
  function stopDuo() { DUO.on = false; cancelAnimationFrame(DUO.raf); }
  addEventListener('resize', () => DUO.on && DUO.resize?.());
  document.addEventListener('visibilitychange', () => { if (document.hidden) stopDuo(); else if (homeOn && !$id('duo')?.hidden) startDuo(); });

  // ============================================================ compartir la app (pestaña Info)
  const APP_URL = 'https://github.com/KMN43/biblioscan/releases/latest/download/BiblioScan.apk';
  function showShareQR() {
    const box = $id('qrBox');
    if (!box.hidden) { box.hidden = true; return; }
    try {
      const q = qrcode(0, 'M'); q.addData(APP_URL); q.make();
      box.innerHTML = `<div class="qrsvg">${q.createSvgTag(6, 2)}</div><p class="mono-caps">Escanéalo con la cámara del otro móvil · descarga directa de BiblioScan.apk</p><p class="qrurl">${escH(APP_URL)}</p>`;
    } catch (e) { box.textContent = 'No se pudo generar el QR: ' + (e?.message || e); }
    box.hidden = false;
  }
  async function shareLink() {
    try {
      if (NATIVE) await Share.share({ title: 'BiblioScan', text: 'Descarga BiblioScan para Android', url: APP_URL, dialogTitle: 'Compartir BiblioScan' });
      else { await navigator.clipboard.writeText(APP_URL); mtoast('Enlace copiado'); }
    } catch (e) { if (!/cancel/i.test(String(e?.message || e))) mtoast('No se pudo compartir'); }
  }

  // ============================================================ navegación: 5 pestañas, Home en el centro
  // Biblioteca · Info · Home · Scan · Catálogo
  function showHome() {
    homeOn = true;
    ['scanView', 'catView', 'libView'].forEach(v => $id(v)?.classList.add('hidden'));
    ['tabScan', 'tabCat', 'tabLib'].forEach(t => $id(t)?.classList.remove('active'));
    $id('homeView').hidden = false; $id('tabHome').classList.add('active');
    history.replaceState(null, '', location.pathname);
    cameraFor(false); renderHome();
  }
  function renderHome() { if (!$id('homeView').hidden) startSun(); }
  function buildNav() {
    const nav = document.querySelector('.tabs');
    if (!nav || $id('tabHome')) return;
    if (!isPhone()) { homeOn = false; cameraFor(true); return; }   // PC / tablet: como siempre, sin Home
    nav.insertAdjacentHTML('beforeend', `<button id="tabHome" class="home" aria-label="Inicio" title="Inicio">${svg('home')}</button>`);
    ['tabLib', 'tabData', 'tabHome', 'tabScan', 'tabCat'].forEach(id => $id(id) && nav.append($id(id)));
    $id('libView').insertAdjacentHTML('afterend', `
      <div id="homeView" class="homev" hidden><canvas id="sunCanvas" aria-label="Tu biblioteca como un sol de páginas"></canvas></div>`);
    buildSunConfig(); buildDuo();
    $id('tabHome').onclick = showHome;
    ['tabScan', 'tabCat', 'tabLib'].forEach(id => $id(id).addEventListener('click', () => {   // después del setTab de index.html
      homeOn = false; $id('homeView').hidden = true; $id('tabHome').classList.remove('active'); stopSun();
      cameraFor(id === 'tabScan' && !!scanMode);
    }));
    new MutationObserver(() => { if (homeOn) { stopSun(); renderHome(); } }).observe($id('catCount'), { childList: true, characterData: true, subtree: true });
    showHome();
  }

  document.addEventListener('DOMContentLoaded', () => {
    window.BIBLIO_MOBILE.toast = mtoast;
    iconizeButtons(); buildPanel(); buildMobileCatalog(); buildShelfBrowser();
    if (isPhone()) { buildScan(); buildLook(); hookConfirm(); }
    buildNav(); setTimeout(checkUpdate, 2500);
  });
})();
