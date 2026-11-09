// Publica una versión nueva de BiblioScan para Android en GitHub Releases.
//
//   npm run release                    → sube el último número (1.0.0 → 1.0.1)
//   npm run release -- minor           → 1.0.1 → 1.1.0     (o "major", o una versión exacta: 1.2.0)
//   npm run release -- minor --notes "Nuevo catálogo y baldas"
//
// Qué hace: sube la versión (package.json + versionCode/versionName de Android), compila la APK firmada,
// la copia a ../BiblioScan.apk, hace commit + etiqueta vX.Y.Z, los sube y crea la Release con la APK
// (y BiblioScan.exe si está en la carpeta). Las apps instaladas verán el aviso de nueva versión al abrirse.
import { execSync } from 'node:child_process';
import { copyFileSync, existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url)), ROOT = join(HERE, '..');
const run = (cmd, opts = {}) => execSync(cmd, { stdio: 'inherit', cwd: HERE, ...opts });
const out = cmd => execSync(cmd, { cwd: HERE, encoding: 'utf8' }).trim();
const fail = msg => { console.error('\n✗ ' + msg); process.exit(1); };

// --- argumentos ---
const args = process.argv.slice(2);
const ni = args.indexOf('--notes');
const notes = ni >= 0 ? args.splice(ni, 2)[1] : '';
const kind = args[0] || 'patch';

// --- comprobaciones ---
if (out('git status --porcelain')) fail('Hay cambios sin guardar en git. Haz commit de ellos primero (o descártalos).');
if (!existsSync(join(HERE, 'keystore.properties'))) fail('Falta mobile/keystore.properties: sin la clave de firma la APK no se podría instalar encima de la anterior.');
const GH = ['gh', 'C:\\Program Files\\GitHub CLI\\gh.exe'].find(g => { try { execSync(`"${g}" --version`, { stdio: 'ignore' }); return true; } catch { return false; } });
if (!GH) fail('No encuentro la CLI de GitHub (gh). Instálala con: winget install GitHub.cli');
const env = { ...process.env };
if (!env.JAVA_HOME || !existsSync(env.JAVA_HOME)) {
  const base = 'C:\\Program Files\\Microsoft', jdk = existsSync(base) && readdirSync(base).filter(d => /^jdk-21/.test(d)).sort().pop();
  if (!jdk) fail('No encuentro Java 21 (JAVA_HOME). Instálalo con: winget install Microsoft.OpenJDK.21');
  env.JAVA_HOME = join(base, jdk);
}

// --- nueva versión ---
const pkgPath = join(HERE, 'package.json'), pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
const [ma, mi, pa] = pkg.version.split('.').map(Number);
const version = /^\d+\.\d+\.\d+$/.test(kind) ? kind
  : kind === 'major' ? `${ma + 1}.0.0` : kind === 'minor' ? `${ma}.${mi + 1}.0` : kind === 'patch' ? `${ma}.${mi}.${pa + 1}` : fail(`Versión no válida: ${kind}`);
const tag = 'v' + version;
if (out(`git tag -l ${tag}`)) fail(`La etiqueta ${tag} ya existe.`);

const gradlePath = join(HERE, 'android', 'app', 'build.gradle');
let gradle = readFileSync(gradlePath, 'utf8');
const code = Number((gradle.match(/versionCode (\d+)/) || [])[1] || 0) + 1;
gradle = gradle.replace(/versionCode \d+/, `versionCode ${code}`).replace(/versionName "[^"]*"/, `versionName "${version}"`);
console.log(`\n→ BiblioScan ${pkg.version} → ${version}  (versionCode ${code})\n`);
pkg.version = version;
writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n');
writeFileSync(gradlePath, gradle);

// --- compilar ---
run('node build-www.mjs');
run('npx cap sync android');
// ruta explícita: en algunas consolas de Windows cmd no busca ejecutables en la carpeta actual
run(process.platform === 'win32' ? `"${join(HERE, 'android', 'gradlew.bat')}" assembleRelease` : './gradlew assembleRelease', { cwd: join(HERE, 'android'), env });
const apk = join(HERE, 'android', 'app', 'build', 'outputs', 'apk', 'release', 'app-release.apk');
if (!existsSync(apk)) fail('No se ha generado la APK.');
copyFileSync(apk, join(ROOT, 'BiblioScan.apk'));

// --- git + GitHub ---
run('git add package.json android/app/build.gradle');
run(`git commit -m "BiblioScan ${version}"`);
run(`git tag ${tag}`);
run('git push');
run(`git push origin ${tag}`);
const assets = [join(ROOT, 'BiblioScan.apk'), join(ROOT, 'BiblioScan.exe')].filter(existsSync).map(f => `"${f}"`).join(' ');
const body = (notes ? notes + '\n\n' : '') + 'Si ya tienes BiblioScan en el móvil, la app te avisará al abrirla: toca descargar e instala encima (tu biblioteca se conserva).';
const notesFile = join(tmpdir(), `biblioscan-${tag}-notes.md`);
writeFileSync(notesFile, body);
run(`"${GH}" release create ${tag} ${assets} --title "BiblioScan ${version}" --notes-file "${notesFile}"`);
console.log(`\n✓ Publicada ${tag}`);
