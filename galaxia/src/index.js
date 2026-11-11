// Galaxia BiblioScan: guarda el «sol» de cada lector (solo números) y devuelve la galaxia entera.
//
//   GET    /galaxy  → { suns: [{ id, pages, joined, updated }], readers, books, pages }
//   PUT    /sun     { id, key, pages: [312, 180, …] }   crea o actualiza tu sol
//   DELETE /sun     { id, key }                          quita tu sol
//
// id: 16 caracteres hex que genera el móvil. key: secreto de 32 hex que solo conoce ese móvil
// (aquí se guarda su SHA-256), así nadie más puede cambiar ni borrar tu sol. Sin cuentas ni datos personales.

const MAX_BOOKS = 5000, MAX_PAGES = 20000;
const UPDATE_EVERY_S = 30;          // un mismo sol se puede actualizar como mucho cada 30 s
const NEW_PER_IP_DAY = 10;          // soles nuevos por red y día (contra el relleno masivo)
const CACHE_S = 60;

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

function cleanPages(p) {
  if (!Array.isArray(p) || p.length < 1 || p.length > MAX_BOOKS) return null;
  const out = [];
  for (const v of p) {
    const n = Math.round(Number(v));
    if (!Number.isFinite(n) || n < 0 || n > MAX_PAGES) return null;
    out.push(n);
  }
  return out;
}

async function getGalaxy(env, ctx, req) {
  const cache = caches.default, cacheKey = new Request(new URL('/galaxy', req.url).toString());
  const hit = await cache.match(cacheKey);
  if (hit) return hit;
  const { results } = await env.DB.prepare('SELECT id, pages, joined, updated FROM suns ORDER BY joined').all();
  let books = 0, pages = 0;
  const suns = results.map(r => {
    const p = JSON.parse(r.pages); books += p.length; pages += p.reduce((a, b) => a + b, 0);
    return { id: r.id, pages: p, joined: r.joined, updated: r.updated };
  });
  const res = json({ suns, readers: suns.length, books, pages }, 200, { 'Cache-Control': `public, max-age=${CACHE_S}` });
  ctx.waitUntil(cache.put(cacheKey, res.clone()));
  return res;
}

async function putSun(env, req) {
  const b = await readBody(req);
  const bad = checkIds(b); if (bad) return fail(400, bad);
  const pages = cleanPages(b.pages); if (!pages) return fail(400, 'páginas no válidas');
  const now = Date.now(), keyHash = await sha256(b.key);
  const row = await env.DB.prepare('SELECT key_hash, updated FROM suns WHERE id = ?').bind(b.id).first();
  if (row) {
    if (row.key_hash !== keyHash) return fail(403, 'Este sol pertenece a otro móvil');
    if (now - row.updated < UPDATE_EVERY_S * 1000) return fail(429, 'Espera unos segundos antes de volver a actualizar');
    await env.DB.prepare('UPDATE suns SET pages = ?, updated = ? WHERE id = ?').bind(JSON.stringify(pages), now, b.id).run();
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
  return json({ ok: true, created: true }, 201);
}

async function deleteSun(env, req) {
  const b = await readBody(req);
  const bad = checkIds(b); if (bad) return fail(400, bad);
  const row = await env.DB.prepare('SELECT key_hash FROM suns WHERE id = ?').bind(b.id).first();
  if (!row) return json({ ok: true, deleted: false });
  if (row.key_hash !== await sha256(b.key)) return fail(403, 'Este sol pertenece a otro móvil');
  await env.DB.prepare('DELETE FROM suns WHERE id = ?').bind(b.id).run();
  return json({ ok: true, deleted: true });
}

export default {
  async fetch(req, env, ctx) {
    const { pathname } = new URL(req.url);
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
    try {
      if (pathname === '/galaxy' && req.method === 'GET') return await getGalaxy(env, ctx, req);
      if (pathname === '/sun' && req.method === 'PUT') return await putSun(env, req);
      if (pathname === '/sun' && req.method === 'DELETE') return await deleteSun(env, req);
      if (pathname === '/') return json({ name: 'Galaxia BiblioScan', endpoints: ['GET /galaxy', 'PUT /sun', 'DELETE /sun'] });
      return fail(404, 'No existe');
    } catch (e) {
      return fail(500, 'Error del servidor');
    }
  },
};
