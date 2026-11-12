-- Galaxia BiblioScan: un sol por lector (solo números) y un contador anti-relleno por red y día.
CREATE TABLE IF NOT EXISTS suns (
  id       TEXT PRIMARY KEY,   -- 16 hex, lo genera el móvil
  key_hash TEXT NOT NULL,      -- SHA-256 del secreto del móvil
  pages    TEXT NOT NULL,      -- JSON: cada libro [páginas, alta_ms], p. ej. [[312,1767225600000],[180,1767312000000]]
  joined   INTEGER NOT NULL,   -- ms desde 1970: cuándo entró en la galaxia
  updated  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS suns_joined ON suns (joined);

CREATE TABLE IF NOT EXISTS limits (
  ip_day TEXT PRIMARY KEY,     -- hash de (IP + día), nunca la IP
  n      INTEGER NOT NULL,
  day    INTEGER NOT NULL
);
