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
    CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);`;
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
  // ancho (px) que necesitan las estanterías: lo usa la vista móvil para encoger la biblioteca y que quepa
  const libWidth = lib => Math.max(0, ...(lib.shelves || []).map(s => (s.x + s.w) * 20 + 20));

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
      return json({ ok: true, book: row });
    }
    if (path.startsWith('/api/books/') && method === 'DELETE') {
      db.run('DELETE FROM books WHERE isbn = ?', [decodeURIComponent(path.split('/').pop())]);
      const n = db.getRowsModified(); persist();
      return json({ ok: n > 0 });
    }
    if (path === '/api/library' && method === 'GET') {
      const lib = getLibrary();
      window.BIBLIO_MOBILE.libWidth = libWidth(lib);
      return json(lib);
    }
    if (path === '/api/library' && method === 'PUT') {
      let data; try { data = cleanLibrary(JSON.parse(body || '{}')); } catch { return json({ error: 'JSON no válido' }, 400); }
      setLibrary(data); persist();
      window.BIBLIO_MOBILE.libWidth = libWidth(data);
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
      if (kind === 'json') await saveFile(`biblioteca-${stamp()}.json`, 'application/json', JSON.stringify(allBooks(), null, 2));
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
        if (!books.length && !kv) throw new Error('El archivo no parece una base de datos de BiblioScan.');
        return { books, library: kv ? JSON.parse(kv.value) : null };
      } finally { src.close(); }
    }
    let data;
    try { data = JSON.parse(new TextDecoder().decode(bytes)); } catch { throw new Error('Formato no reconocido. Usa un .db o un .json exportado de BiblioScan.'); }
    if (Array.isArray(data)) return { books: data, library: null };
    if (Array.isArray(data?.books)) return { books: data.books, library: data.library || null };
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
      db.run('COMMIT');
      await flush();
      return n;
    } catch (e) { db.run('ROLLBACK'); throw e; }
  }

  // ------------------------------------------------------------ panel "Datos"
  const ICON = '<svg viewBox="0 0 24 24"><ellipse cx="12" cy="5.5" rx="7" ry="2.5"/><path d="M5 5.5v13c0 1.4 3.1 2.5 7 2.5s7-1.1 7-2.5v-13"/><path d="M5 12c0 1.4 3.1 2.5 7 2.5s7-1.1 7-2.5"/></svg>';
  function buildPanel() {
    const nav = document.querySelector('.tabs');
    if (!nav || document.getElementById('tabData')) return;
    nav.insertAdjacentHTML('beforeend', `<button id="tabData" title="Importar / exportar" aria-label="Datos">${ICON}</button>`);
    document.body.insertAdjacentHTML('beforeend', `
      <div class="modal hidden" id="dataModal">
        <div class="mcard datacard">
          <div class="bar mono-caps"><span>Datos · copia de seguridad</span><span id="dataCount"></span></div>
          <div class="datab">
            <p>Tu biblioteca se guarda solo en este móvil. Exporta una copia de vez en cuando, o pásala al ordenador
               (el archivo <b>.db</b> es el mismo <i>biblioteca.db</i> que usa BiblioScan.exe).</p>
            <div class="mono-caps lbl">Exportar</div>
            <div class="btns"><button data-exp="db" class="primary">Base de datos .db</button><button data-exp="csv">CSV (Excel)</button><button data-exp="json">JSON</button></div>
            <div class="mono-caps lbl">Importar</div>
            <p>Elige un <b>biblioteca.db</b> (del ordenador o de otro móvil) o un <b>.json</b> exportado de BiblioScan.</p>
            <div class="btns"><button id="impPick">Elegir archivo…</button><input id="impFile" type="file" hidden></div>
            <div id="impAsk" class="hidden">
              <p id="impMsg"></p>
              <div class="btns"><button id="impAdd" class="primary">Añadir a mi biblioteca</button><button id="impRep">Reemplazar todo</button></div>
            </div>
            <p id="impErr" class="err"></p>
          </div>
          <div class="mfoot"><span class="grow"></span><button id="dataClose">Cerrar</button></div>
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
          + `Ahora tienes ${have} libros. «Añadir» combina ambos (si un ISBN ya existe, se actualiza con los datos importados)`
          + `${sh ? ' y solo toma las estanterías si aún no tienes ninguna' : ''}. «Reemplazar» borra lo actual.`;
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
  const md = navigator.mediaDevices;
  if (md?.getUserMedia) {
    const gum = md.getUserMedia.bind(md);
    md.getUserMedia = c => {
      if (c?.video && typeof c.video === 'object' && !c.video.deviceId) c = { ...c, video: { ...c.video, facingMode: { ideal: 'environment' } } };
      return gum(c);
    };
  }

  // la biblioteca se dibuja con las medidas del PC; en pantalla estrecha se encoge para que quepan las estanterías
  const narrow = matchMedia('(max-width: 760px)');
  function fitLibrary() {
    const stage = document.getElementById('libStage'), view = document.getElementById('libView');
    if (!stage || !view || view.classList.contains('hidden')) return;
    if (!narrow.matches) { stage.style.cssText = ''; return; }
    const availW = view.clientWidth;
    const top = [...view.children].filter(el => el !== stage).reduce((h, el) => h + el.offsetHeight, 0);
    const availH = Math.max(200, view.clientHeight - top);
    const need = Math.max(availW, window.BIBLIO_MOBILE.libWidth || 0), k = availW / need;
    stage.style.cssText = `flex:none;width:${need}px;height:${availH / k}px;transform:scale(${k});transform-origin:0 0;`;
  }
  // antes que los manejadores de index.html (este script se carga primero)
  addEventListener('resize', fitLibrary);
  document.addEventListener('click', e => { if (e.target.closest?.('#tabLib')) requestAnimationFrame(() => { fitLibrary(); dispatchEvent(new Event('resize')); }); }, true);

  // ------------------------------------------------------------ navegador de baldas (Biblioteca en el móvil)
  // ↑ ↓ cambia de balda · ← → recorre los libros · el del centro se agranda y muestra el título · tocarlo abre la ficha
  const escH = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const TONES = ['#d6d3cb', '#cfccc3', '#c7c4bb', '#dedbd3', '#bfbcb3', '#d2cfc6'];
  const hash = s => { let h = 2166136261; for (const c of String(s)) { h ^= c.charCodeAt(0); h = Math.imul(h, 16777619); } return h >>> 0; };
  const surname = a => (String(a || '').split(',')[0].trim().split(/\s+/).pop() || '');
  let sbMode = (() => { try { return localStorage.getItem('libMode') || 'baldas'; } catch { return 'baldas'; } })();
  let sbRows = [];

  async function shelfRows() {
    await ready;
    const books = allBooks(), byIsbn = new Map(books.map(b => [b.isbn, b])), placed = new Set(), out = [];
    const lib = cleanLibrary(getLibrary());
    for (const s of lib.shelves) s.books.forEach((row, r) => {
      const list = row.map(e => Array.isArray(e) ? e : [e, 0]).sort((a, b) => a[1] - b[1])
        .map(e => byIsbn.get(e[0])).filter(b => b && !placed.has(b.isbn));
      list.forEach(b => placed.add(b.isbn));
      if (list.length) out.push({ label: s.label || 'Sin etiqueta', sub: `Balda ${r + 1}`, books: list });
    });
    const rest = books.filter(b => !placed.has(b.isbn))
      .sort((a, b) => surname(a.authors).localeCompare(surname(b.authors), 'es') || String(a.title).localeCompare(String(b.title), 'es'));
    if (rest.length) out.push({ label: out.length ? 'Sin clasificar' : 'Mi biblioteca', sub: out.length ? 'En el montón' : 'Por autor', books: rest });
    return out;
  }

  function spineHtml(b) {
    const p = parseInt(b.pages, 10), w = p ? Math.max(24, Math.min(64, Math.round(16 + p / 12))) : 34, h = hash(b.isbn);
    return `<button class="sp" data-isbn="${escH(b.isbn)}" style="--w:${w}px;--tone:${TONES[h % TONES.length]};--hh:${88 + (h >> 4) % 12}%">`
      + `<span class="spt">${escH(b.title)}</span><span class="spa">${escH(surname(b.authors))}</span></button>`;
  }

  async function renderShelves() {
    const sb = document.getElementById('sb');
    if (!sb) return;
    sbRows = await shelfRows();
    if (!sbRows.length) { sb.innerHTML = '<div class="sbempty mono-caps">Aún no hay libros. Escanea alguno o importa tu biblioteca desde «Datos».</div>'; return; }
    sb.innerHTML = sbRows.map((r, i) => `
      <section class="sbrow" data-row="${i}">
        <div class="sbhead"><div><b>${escH(r.label)}</b><span class="mono-caps">${escH(r.sub)} · ${r.books.length} libros</span></div>
          <span class="mono-caps sbn">${i + 1} / ${sbRows.length}</span></div>
        <div class="sbstrip"><i class="sbpad"></i>${r.books.map(spineHtml).join('')}<i class="sbpad"></i></div>
        <div class="sbinfo"><div class="t"></div><div class="a mono-caps"></div></div>
        <div class="sbnext mono-caps">${i + 1 < sbRows.length ? `↓ ${escH(sbRows[i + 1].label)} · ${escH(sbRows[i + 1].sub)}` : i ? '↑ Fin de la biblioteca' : ''}</div>
      </section>`).join('');
    sb.querySelectorAll('.sbstrip').forEach(strip => {
      let raf = 0;
      strip.addEventListener('scroll', () => { cancelAnimationFrame(raf); raf = requestAnimationFrame(() => pickCenter(strip)); }, { passive: true });
      pickCenter(strip);
    });
  }

  function pickCenter(strip) {
    const mid = strip.getBoundingClientRect().left + strip.clientWidth / 2;
    let best = null, bd = Infinity;
    strip.querySelectorAll('.sp').forEach(sp => {
      const r = sp.getBoundingClientRect(), d = Math.abs(r.left + r.width / 2 - mid);
      if (d < bd) { bd = d; best = sp; }
    });
    if (!best || best.classList.contains('on')) return;
    strip.querySelector('.sp.on')?.classList.remove('on');
    best.classList.add('on');
    const row = sbRows[+strip.closest('.sbrow').dataset.row], b = row.books.find(x => x.isbn === best.dataset.isbn), sec = strip.closest('.sbrow');
    sec.querySelector('.sbinfo .t').textContent = b.title;
    sec.querySelector('.sbinfo .a').textContent = [b.authors, b.year, b.publisher].filter(Boolean).join(' · ');
  }
  const centerOn = (sp, smooth = true) => sp.scrollIntoView({ inline: 'center', block: 'nearest', behavior: smooth ? 'smooth' : 'auto' });

  function buildShelfBrowser() {
    const view = document.getElementById('libView'), tools = view?.querySelector('.libtools');
    if (!tools || document.getElementById('sb')) return;
    tools.insertAdjacentHTML('beforeend', '<button id="sbMode" class="mono-caps flat" title="Cambiar entre baldas y plano de estanterías"></button>');
    view.insertAdjacentHTML('beforeend', '<div id="sb" class="sb"></div>');
    const sb = document.getElementById('sb');
    sb.addEventListener('click', e => {
      const sp = e.target.closest('.sp');
      if (!sp) return;
      if (!sp.classList.contains('on')) return centerOn(sp);
      const row = sbRows[+sp.closest('.sbrow').dataset.row];
      if (typeof openDetail === 'function') openDetail(sp.dataset.isbn, row.books.map(b => b.isbn));
    });
    // buscar: salta a la balda del primer libro que coincide y lo centra
    const norm = s => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
    document.getElementById('lq')?.addEventListener('input', e => {
      const q = norm(e.target.value).trim();
      if (sbMode !== 'baldas' || q.length < 2) return;
      for (let i = 0; i < sbRows.length; i++) {
        const b = sbRows[i].books.find(b => norm([b.title, b.authors, b.isbn, b.publisher].join(' ')).includes(q));
        if (!b) continue;
        const sec = sb.querySelector(`[data-row="${i}"]`);
        sb.scrollTo({ top: sec.offsetTop, behavior: 'smooth' });
        centerOn(sec.querySelector(`.sp[data-isbn="${CSS.escape(b.isbn)}"]`));
        return;
      }
    });
    document.getElementById('sbMode').onclick = () => {
      sbMode = sbMode === 'baldas' ? 'plano' : 'baldas';
      try { localStorage.setItem('libMode', sbMode); } catch {}
      applyMode();
      if (sbMode === 'plano') requestAnimationFrame(() => { fitLibrary(); dispatchEvent(new Event('resize')); });
    };
    narrow.addEventListener('change', applyMode);
    applyMode();
  }
  function applyMode() {
    const on = narrow.matches && sbMode === 'baldas';
    document.getElementById('libView')?.classList.toggle('sbmode', on);
    const btn = document.getElementById('sbMode');
    if (btn) { btn.textContent = sbMode === 'baldas' ? 'Ver plano' : 'Ver baldas'; btn.style.display = narrow.matches ? '' : 'none'; }
    if (on) renderShelves();
  }
  document.addEventListener('click', e => { if (e.target.closest?.('#tabLib')) requestAnimationFrame(() => { if (narrow.matches && sbMode === 'baldas') renderShelves(); }); }, true);

  document.addEventListener('DOMContentLoaded', () => { buildPanel(); buildShelfBrowser(); });
})();
