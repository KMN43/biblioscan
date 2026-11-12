// Galaxia BiblioScan: guarda el «sol» de cada lector (solo números) y devuelve la galaxia entera.
//
//   GET    /            → el visualizador (public/index.html)
//   GET    /galaxy      → { suns: [{ id, books: [[páginas, alta_ms], …], joined }], readers, books, pages }
//   PUT    /sun         { id, key, books: [[312, 1767225600000], …] }   crea o actualiza tu sol
//   DELETE /sun         { id, key }                                       quita tu sol
//
// id: 16 caracteres hex que genera el móvil. key: secreto de 32 hex que solo conoce ese móvil
// (aquí se guarda su SHA-256), así nadie más puede cambiar ni borrar tu sol. Sin cuentas ni datos personales.

const MAX_BOOKS = 5000, MAX_PAGES = 20000, T_MIN = Date.UTC(1990, 0, 1);
const UPDATE_EVERY_S = 30;          // un mismo sol se puede actualizar como mucho cada 30 s
const NEW_PER_IP_DAY = 10;          // soles nuevos por red y día (contra el relleno masivo)
const CACHE_S = 60;
let memo = null;   // copia de la galaxia en la memoria del Worker (la Cache API no funciona en workers.dev)

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, PUT, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Max-Age': '86400',
};
const json = (body, status = 200, extra = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', ...CORS, ...extra } });
const fail = (status, error) => json({ error }, status);

async function sha256(text) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
}

async function readBody(req) {
  if (+(req.headers.get('Content-Length') || 0) > 64000) return null;
  try { const t = await req.text(); return t.length > 64000 ? null : JSON.parse(t); } catch { return null; }
}

function checkIds(b) {
  if (!b || typeof b.id !== 'string' || !/^[0-9a-f]{16}$/.test(b.id)) return 'id no válido';
  if (typeof b.key !== 'string' || !/^[0-9a-f]{32}$/.test(b.key)) return 'clave no válida';
  return null;
}

// cada libro: [páginas, fecha de alta en ms]. Solo números.
function cleanBooks(list, now) {
  if (!Array.isArray(list) || list.length < 1 || list.length > MAX_BOOKS) return null;
  const out = [];
  for (const b of list) {
    if (!Array.isArray(b) || b.length !== 2) return null;
    const p = Math.round(Number(b[0])), t = Math.round(Number(b[1]));
    if (!Number.isFinite(p) || p < 0 || p > MAX_PAGES) return null;
    if (!Number.isFinite(t) || t < T_MIN || t > now + 864e5) return null;
    out.push([p, t]);
  }
  return out;
}

async function getGalaxy(env) {
  const now = Date.now();
  if (!memo || now - memo.at > CACHE_S * 1000) {
    const { results } = await env.DB.prepare('SELECT id, pages, joined FROM suns ORDER BY joined').all();
    let books = 0, pages = 0;
    const suns = results.map(r => {
      const b = JSON.parse(r.pages); books += b.length; pages += b.reduce((a, x) => a + x[0], 0);
      return { id: r.id, books: b, joined: r.joined };
    });
    memo = { at: now, body: JSON.stringify({ suns, readers: suns.length, books, pages, at: now }) };
  }
  return new Response(memo.body, { headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': `public, max-age=${CACHE_S}`, ...CORS } });
}

async function putSun(env, req) {
  const b = await readBody(req);
  const bad = checkIds(b); if (bad) return fail(400, bad);
  const now = Date.now(), pages = cleanBooks(b.books, now); if (!pages) return fail(400, 'libros no válidos');
  const keyHash = await sha256(b.key);
  const row = await env.DB.prepare('SELECT key_hash, updated FROM suns WHERE id = ?').bind(b.id).first();
  if (row) {
    if (row.key_hash !== keyHash) return fail(403, 'Este sol pertenece a otro móvil');
    if (now - row.updated < UPDATE_EVERY_S * 1000) return fail(429, 'Espera unos segundos antes de volver a actualizar');
    await env.DB.prepare('UPDATE suns SET pages = ?, updated = ? WHERE id = ?').bind(JSON.stringify(pages), now, b.id).run();
    memo = null;
    return json({ ok: true, created: false });
  }
  // límite de soles nuevos por red y día (se guarda un hash de la IP, nunca la IP)
  const day = Math.floor(now / 864e5), ipHash = (await sha256((req.headers.get('CF-Connecting-IP') || '?') + ':' + day)).slice(0, 24);
  const lim = await env.DB.prepare('SELECT n FROM limits WHERE ip_day = ?').bind(ipHash).first();
  if (lim && lim.n >= NEW_PER_IP_DAY) return fail(429, 'Demasiados soles nuevos desde esta red hoy');
  await env.DB.batch([
    env.DB.prepare('INSERT INTO suns (id, key_hash, pages, joined, updated) VALUES (?, ?, ?, ?, ?)').bind(b.id, keyHash, JSON.stringify(pages), now, now),
    env.DB.prepare('INSERT INTO limits (ip_day, n, day) VALUES (?, 1, ?) ON CONFLICT(ip_day) DO UPDATE SET n = n + 1').bind(ipHash, day),
    env.DB.prepare('DELETE FROM limits WHERE day < ?').bind(day - 1),
  ]);
  memo = null;
  return json({ ok: true, created: true }, 201);
}

async function deleteSun(env, req) {
  const b = await readBody(req);
  const bad = checkIds(b); if (bad) return fail(400, bad);
  const row = await env.DB.prepare('SELECT key_hash FROM suns WHERE id = ?').bind(b.id).first();
  if (!row) return json({ ok: true, deleted: false });
  if (row.key_hash !== await sha256(b.key)) return fail(403, 'Este sol pertenece a otro móvil');
  await env.DB.prepare('DELETE FROM suns WHERE id = ?').bind(b.id).run();
  memo = null;
  return json({ ok: true, deleted: true });
}

export default {
  async fetch(req, env, ctx) {
    const { pathname } = new URL(req.url);
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
    try {
      if (pathname === '/galaxy' && req.method === 'GET') return await getGalaxy(env);
      if (pathname === '/sun' && req.method === 'PUT') return await putSun(env, req);
      if (pathname === '/sun' && req.method === 'DELETE') return await deleteSun(env, req);
      if (env.ASSETS && req.method === 'GET') return env.ASSETS.fetch(req);   // el visualizador
      return fail(404, 'No existe');
    } catch (e) {
      return fail(500, 'Error del servidor');
    }
  },
};
