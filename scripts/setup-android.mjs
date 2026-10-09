#!/usr/bin/env node
// Prepara el proyecto Android a partir de este repositorio. Es idempotente: se puede repetir.
//
//   1. Instala dependencias si faltan (npm install)
//   2. Genera android/ con Capacitor si no existe (npx cap add android)
//   3. Copia el plugin y MainActivity, ajustando el `package` al appId de capacitor.config.json
//   4. Añade los permisos al AndroidManifest.xml
//   5. Sube minSdkVersion a 29 (requestCellInfoUpdate y CellInfoNr)
//   6. Sincroniza la interfaz web (npx cap sync android)
//
// Está en Node para que funcione igual en Windows, macOS y Linux.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const MIN_SDK = 29;
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const at = (...p) => join(root, ...p);
const { appId } = JSON.parse(readFileSync(at('capacitor.config.json'), 'utf8'));

if (!/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/.test(appId)) {
  fail(`appId inválido en capacitor.config.json: "${appId}" (ejemplo: com.miempresa.senal)`);
}

function fail(msg) {
  console.error(`\n✗ ${msg}`);
  process.exit(1);
}

function run(cmd, args) {
  console.log(`\n$ ${cmd} ${args.join(' ')}`);
  // En Windows npm/npx son .cmd y necesitan shell.
  const r = spawnSync(cmd, args, { cwd: root, stdio: 'inherit', shell: process.platform === 'win32' });
  if (r.status !== 0) fail(`Falló: ${cmd} ${args.join(' ')}`);
}

/* 1 y 2 ---------------------------------------------------------------- */
if (!existsSync(at('node_modules', '@capacitor', 'android'))) run('npm', ['install']);
if (!existsSync(at('android'))) run('npx', ['cap', 'add', 'android']);

/* 3. Plugin + MainActivity -------------------------------------------- */
const javaDir = at('android', 'app', 'src', 'main', 'java', ...appId.split('.'));
mkdirSync(javaDir, { recursive: true });
for (const file of ['SignalMonitorPlugin.java', 'MainActivity.java']) {
  const src = readFileSync(at('android-plugin', file), 'utf8').replace(/^package\s+[\w.]+;/m, `package ${appId};`);
  writeFileSync(join(javaDir, file), src);
  console.log(`✓ ${file} → android/app/src/main/java/${appId.split('.').join('/')}/`);
}

/* 4. Permisos ---------------------------------------------------------- */
const manifestPath = at('android', 'app', 'src', 'main', 'AndroidManifest.xml');
let manifest = readFileSync(manifestPath, 'utf8');
if (manifest.includes('android.permission.READ_PHONE_STATE')) {
  console.log('✓ AndroidManifest.xml ya tenía los permisos');
} else {
  const snippet = readFileSync(at('android-plugin', 'AndroidManifest.snippet.xml'), 'utf8')
    .replace(/<!--[\s\S]*?-->/g, '')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => `    ${l}`)
    .join('\n');
  if (!manifest.includes('</manifest>')) fail('AndroidManifest.xml no tiene </manifest>: formato inesperado.');
  manifest = manifest.replace('</manifest>', `\n${snippet}\n</manifest>`);
  writeFileSync(manifestPath, manifest);
  console.log('✓ Permisos añadidos a AndroidManifest.xml');
}

/* 5. minSdkVersion ----------------------------------------------------- */
const varsPath = at('android', 'variables.gradle');
let vars = readFileSync(varsPath, 'utf8');
const m = vars.match(/minSdkVersion\s*=\s*(\d+)/);
if (!m) fail('No se encontró minSdkVersion en android/variables.gradle: súbelo a 29 a mano.');
if (Number(m[1]) < MIN_SDK) {
  vars = vars.replace(/minSdkVersion\s*=\s*\d+/, `minSdkVersion = ${MIN_SDK}`);
  writeFileSync(varsPath, vars);
  console.log(`✓ minSdkVersion ${m[1]} → ${MIN_SDK}`);
} else {
  console.log(`✓ minSdkVersion ya es ${m[1]}`);
}

/* 6. Sincronizar ------------------------------------------------------- */
run('npx', ['cap', 'sync', 'android']);

console.log(`
Listo. Siguientes pasos:
  npx cap open android     # abre Android Studio y ejecútala en un teléfono físico con SIM
  (o) cd android && ./gradlew assembleDebug    # genera el APK en android/app/build/outputs/apk/debug/
`);
