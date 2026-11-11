// Prepara www/ para Capacitor: copia el index.html de la raíz (la misma app del PC) y le añade la capa móvil.
//   node build-www.mjs
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const WWW = join(HERE, 'www');
const nm = p => join(HERE, 'node_modules', p);

rmSync(WWW, { recursive: true, force: true });
mkdirSync(join(WWW, 'vendor'), { recursive: true });

let html = readFileSync(join(HERE, '..', 'index.html'), 'utf8');
const inject = (marker, extra, before = false) => {
  if (!html.includes(marker)) throw new Error(`No encuentro "${marker}" en index.html`);
  html = html.replace(marker, before ? extra + marker : marker + extra);
};
html = html.replace(/<meta name="viewport"[^>]*>/, '<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">');
// la capa móvil va antes que cualquier otro script: tiene que interceptar fetch('/api/...') desde el principio
const VERSION = JSON.parse(readFileSync(join(HERE, 'package.json'), 'utf8')).version;   // lo usa el aviso de nueva versión
inject('<meta charset="utf-8">', `\n<script>window.BIBLIO_VERSION = '${VERSION}';</script>` + '\n<script src="capacitor.js"></script>\n<script src="vendor/sql-wasm.js"></script>\n<script src="vendor/qrcode.js"></script>\n<script src="native.js"></script>');
inject('</head>', '<link rel="stylesheet" href="mobile.css">\n', true);
writeFileSync(join(WWW, 'index.html'), html);

cpSync(join(HERE, 'src', 'native.js'), join(WWW, 'native.js'));
cpSync(join(HERE, 'src', 'mobile.css'), join(WWW, 'mobile.css'));
cpSync(nm('@capacitor/core/dist/capacitor.js'), join(WWW, 'capacitor.js'));
cpSync(nm('sql.js/dist/sql-wasm.js'), join(WWW, 'vendor', 'sql-wasm.js'));
cpSync(nm('sql.js/dist/sql-wasm.wasm'), join(WWW, 'vendor', 'sql-wasm.wasm'));
cpSync(nm('qrcode-generator/qrcode.js'), join(WWW, 'vendor', 'qrcode.js'));   // QR para compartir la app (pestaña Info)
console.log('www/ listo');
