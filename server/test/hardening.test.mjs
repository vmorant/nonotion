// Regresiones de la segunda auditoría de seguridad: servidor en modo GitHub
// (sesiones simuladas en la base de datos), cuerpos sin autenticar, arranque
// sin configuración, identidad por id de GitHub, rol de solo lectura, tokens
// guardados como hash, actas con líneas patológicas y exportación ZIP.
import './setup.mjs';
import { DATA_DIR } from './setup.mjs';
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const PORT = 40000 + Math.floor(Math.random() * 20000);
const BASE = `http://127.0.0.1:${PORT}`;
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
let server;

function spawnServer(extraEnv, port = PORT, dataDir = DATA_DIR) {
  const env = { ...process.env, DATA_DIR: dataDir, PORT: String(port), GITHUB_LOOKUP: 'off', ...extraEnv };
  for (const [k, v] of Object.entries(extraEnv)) if (v === undefined) delete env[k];
  return spawn(process.execPath, ['server/index.js'], { cwd: ROOT, env, stdio: 'ignore' });
}
async function waitUp(base) {
  for (let i = 0; i < 100; i++) {
    try {
      await fetch(`${base}/api/health`);
      return;
    } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('el servidor no arrancó');
}
async function stopProc(p) {
  if (!p || p.exitCode !== null) return;
  const done = new Promise((r) => p.once('exit', r));
  p.kill();
  await done;
}

const GITHUB_ENV = {
  GITHUB_CLIENT_ID: 'x',
  GITHUB_CLIENT_SECRET: 'y',
  AUTH_ALLOWED_GITHUB_USERS: 'owner1',
  PUBLIC_URL: `http://127.0.0.1:${PORT}`,
};

// Sesión simulada: lo mismo que deja el callback de GitHub
function session(login, githubId) {
  const sid = crypto.randomBytes(16).toString('hex');
  const db = new Database(path.join(DATA_DIR, 'nonotion.db'));
  db.prepare(
    `INSERT INTO sessions (id, github_login, github_id, expires_at) VALUES (?, ?, ?, datetime('now', '+1 day'))`
  ).run(sha(sid), login, githubId);
  db.close();
  return `nn_session=${sid}`;
}

const req = async (p, { cookie, method = 'GET', body, headers = {} } = {}) => {
  const r = await fetch(BASE + p, {
    method,
    headers: {
      ...(cookie ? { Cookie: cookie } : {}),
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...(method !== 'GET' ? { Origin: BASE } : {}),
      ...headers,
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {}
  return { status: r.status, json, text };
};

let owner;
let ws;
before(async () => {
  server = spawnServer(GITHUB_ENV);
  await waitUp(BASE);
  owner = session('owner1', 111);
  ws = (await req('/api/workspaces', { cookie: owner })).json.workspaces[0].id;
});
after(() => stopProc(server));

test('sin sesión, el cuerpo de una petición a una ruta pública ni se lee (bombas gzip)', async () => {
  // Un JSON roto daría 400 si se procesara; comprimido, 100 KB serían ~100 MB en memoria
  const bomb = zlib.gzipSync(Buffer.from('{"a":"' + 'A'.repeat(5_000_000)));
  for (const p of ['/api/share/xxxx', '/share/xxxx', '/auth/logout', '/login']) {
    const r = await fetch(BASE + p, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Encoding': 'gzip' },
      body: bomb,
    });
    assert.notEqual(r.status, 400, `${p}: el cuerpo no debe procesarse`);
    assert.notEqual(r.status, 413, `${p}: el cuerpo no debe procesarse`);
  }
});

test('con sesión, las escrituras exigen venir de nuestro dominio (también sin cabecera Origin)', async () => {
  const noOrigin = await fetch(`${BASE}/api/pages`, {
    method: 'POST',
    headers: { Cookie: owner, 'Content-Type': 'application/json' },
    body: '{"title":"x"}',
  });
  assert.equal(noOrigin.status, 403);
  const evil = await req('/api/pages', { cookie: owner, method: 'POST', body: { title: 'x' }, headers: { Origin: 'https://evil.example' } });
  assert.equal(evil.status, 403);
  const ok = await req('/api/pages', { cookie: owner, method: 'POST', body: { title: 'Desde la app' } });
  assert.equal(ok.status, 200);
});

test('una cuenta de GitHub distinta que hereda el nombre de otra no entra', async () => {
  const real = session('owner1', 111);
  assert.equal((await req('/api/pages', { cookie: real })).status, 200);
  const impostor = session('owner1', 999); // mismo nombre, otra cuenta
  assert.equal((await req('/api/pages', { cookie: impostor })).status, 401);
});

test('rol de solo lectura: ve pero no cambia nada, ni puede crear conectores', async () => {
  const bad = await req(`/api/workspaces/${ws}/members/lector`, { cookie: owner, method: 'PUT', body: { role: 'superadmin' } });
  assert.equal(bad.status, 400, 'un rol desconocido ya no se convierte en editor');
  assert.equal((await req(`/api/workspaces/${ws}/members/lector`, { cookie: owner, method: 'PUT', body: { role: 'viewer' } })).status, 200);
  const page = (await req('/api/pages', { cookie: owner, method: 'POST', body: { title: 'Solo para leer' } })).json;
  const lector = session('lector', 222);
  const h = { 'X-Workspace': ws };
  assert.equal((await req(`/api/pages/${page.id}`, { cookie: lector, headers: h })).status, 200);
  assert.equal((await req(`/api/pages/${page.id}`, { cookie: lector, method: 'PUT', body: { title: 'cambiado' }, headers: h })).status, 403);
  assert.equal((await req('/api/pages', { cookie: lector, method: 'POST', body: { title: 'nueva' }, headers: h })).status, 403);
  assert.equal((await req(`/api/pages/${page.id}`, { cookie: lector, method: 'DELETE', headers: h })).status, 403);
  assert.equal((await req(`/api/workspaces/${ws}/tokens`, { cookie: lector, method: 'POST', body: {} })).status, 403);
  // marcar favorita sí: es personal
  assert.equal((await req(`/api/pages/${page.id}`, { cookie: lector, method: 'PUT', body: { favorite: true }, headers: h })).status, 200);
  assert.equal((await req(`/api/pages/${page.id}`, { cookie: owner })).json.title, 'Solo para leer');
});

test('solo los propietarios dan acceso a cuentas nuevas; un editor no comparte ni vacía la papelera', async () => {
  await req(`/api/workspaces/${ws}/members/jefa`, { cookie: owner, method: 'PUT', body: { role: 'admin' } });
  await req(`/api/workspaces/${ws}/members/editor1`, { cookie: owner, method: 'PUT', body: { role: 'editor' } });
  const jefa = session('jefa', 333);
  const editor = session('editor1', 444);
  const h = { 'X-Workspace': ws };
  assert.equal((await req(`/api/workspaces/${ws}/members/desconocido`, { cookie: jefa, method: 'PUT', body: { role: 'editor' } })).status, 403);
  assert.equal((await req(`/api/workspaces/${ws}/members/editor1`, { cookie: jefa, method: 'PUT', body: { role: 'viewer' } })).status, 200, 'cambiar el rol de un miembro sí');
  await req(`/api/workspaces/${ws}/members/editor1`, { cookie: owner, method: 'PUT', body: { role: 'editor' } });
  const page = (await req('/api/pages', { cookie: editor, method: 'POST', body: { title: 'Borrador' }, headers: h })).json;
  assert.equal((await req(`/api/pages/${page.id}/share`, { cookie: editor, method: 'POST', headers: h })).status, 403);
  await req(`/api/pages/${page.id}`, { cookie: editor, method: 'DELETE', headers: h });
  assert.equal((await req('/api/trash', { cookie: editor, method: 'DELETE', headers: h })).status, 403);
  assert.equal((await req(`/api/trash/${page.id}`, { cookie: editor, method: 'DELETE', headers: h })).status, 403);
  const other = (await req('/api/pages', { cookie: editor, method: 'POST', body: { title: 'Pública' }, headers: h })).json;
  assert.equal((await req(`/api/pages/${other.id}/share`, { cookie: jefa, method: 'POST', headers: h })).status, 200, 'una admin sí comparte');
  assert.equal((await req(`/api/trash/${page.id}`, { cookie: jefa, method: 'DELETE', headers: h })).status, 200);
});

test('los tokens solo se guardan como hash y se ven enteros una única vez', async () => {
  const { token } = (await req(`/api/workspaces/${ws}/tokens`, { cookie: owner, method: 'POST', body: { label: 't' } })).json;
  assert.ok(token && token.length >= 24);
  const db = new Database(path.join(DATA_DIR, 'nonotion.db'));
  const rows = db.prepare('SELECT token, prefix FROM api_tokens').all();
  db.close();
  assert.ok(rows.every((r) => r.token.startsWith('sha256:')), 'ningún token en claro');
  assert.ok(!rows.some((r) => r.token.includes(token)));
  const list = (await req(`/api/workspaces/${ws}/tokens`, { cookie: owner })).json;
  assert.ok(list.every((t) => t.token === null), 'el listado no devuelve el token');
  assert.ok(list.some((t) => t.id === token.slice(0, 6)));
  // y sigue funcionando
  assert.equal((await fetch(`${BASE}/api/pages`, { headers: { Authorization: `Bearer ${token}` } })).status, 200);
  // con un token, crear otro responde (antes se quedaba colgada la petición)
  const r = await fetch(`${BASE}/api/workspaces/${ws}/tokens`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: '{}',
    signal: AbortSignal.timeout(3000),
  });
  assert.equal(r.status, 404);
  // revocar por su prefijo
  const del = await req(`/api/workspaces/${ws}/tokens/${token.slice(0, 6)}`, { cookie: owner, method: 'DELETE' });
  assert.equal(del.json.deleted, 1);
  assert.equal((await fetch(`${BASE}/api/pages`, { headers: { Authorization: `Bearer ${token}` } })).status, 401);
});

test('la app lleva CSP y la vista de un HTML adjunto no permite formularios ni descargas', async () => {
  const r = await fetch(`${BASE}/login`);
  assert.equal(r.status, 200);
  const page = (await req('/api/pages', { cookie: owner, method: 'POST', body: { title: 'Adjuntos' } })).json;
  const form = new FormData();
  form.append('file', new Blob(['<form action="https://evil.example"><input name=p></form>'], { type: 'text/html' }), 'login.html');
  form.append('page_id', page.id);
  const up = await fetch(`${BASE}/api/files`, { method: 'POST', headers: { Cookie: owner, Origin: BASE }, body: form });
  const f = await up.json();
  const view = await fetch(`${BASE}/files/${f.id}/view`, { headers: { Cookie: owner } });
  const csp = view.headers.get('content-security-policy');
  assert.match(csp, /^sandbox allow-scripts allow-popups allow-modals;/);
  assert.doesNotMatch(csp, /allow-forms|allow-downloads|escape-sandbox|allow-same-origin/);
  assert.match(csp, /form-action 'none'/);
});

test('un tipo MIME raro declarado por el cliente no se guarda tal cual', async () => {
  const r = await req('/api/uploads', { cookie: owner, method: 'POST', body: { name: 'a.png', size: 1, mime: 'image/png, text/html' } });
  assert.equal(r.status, 200);
  const db = new Database(path.join(DATA_DIR, 'nonotion.db'));
  const mime = db.prepare('SELECT mime FROM uploads WHERE id = ?').get(r.json.id).mime;
  db.close();
  assert.equal(mime, 'image/png'); // deducido de la extensión
  const huge = await req('/api/uploads', { cookie: owner, method: 'POST', body: { name: 'b.bin', size: 2 ** 52, mime: 'application/octet-stream' } });
  assert.equal(huge.status, 507, 'no se acepta una subida mayor que el disco libre');
});

test('una línea de acta llena de comas no bloquea el servidor', async () => {
  const { detectProposals } = await import('../minutes.js');
  const t = Date.now();
  const r = detectProposals('- [ ] a' + ','.repeat(200_000) + 'x\n- [ ] Revisar contrato, @ana 2026-11-20.');
  assert.ok(Date.now() - t < 1000, `tardó ${Date.now() - t} ms`);
  assert.equal(r.at(-1).title, 'Revisar contrato');
});

test('la exportación ZIP no contiene rutas con ..', async () => {
  const a = (await req('/api/pages', { cookie: owner, method: 'POST', body: { title: 'Normal' } })).json;
  const b = (await req('/api/pages', { cookie: owner, method: 'POST', body: { title: '..', parent_id: a.id } })).json;
  await req('/api/pages', { cookie: owner, method: 'POST', body: { title: '..', parent_id: b.id } });
  const zip = Buffer.from(await (await fetch(`${BASE}/api/export`, { headers: { Cookie: owner } })).arrayBuffer());
  // nombres de las entradas del ZIP (cabeceras locales PK\x03\x04)
  const names = [];
  for (let i = zip.indexOf('PK\x03\x04'); i >= 0; i = zip.indexOf('PK\x03\x04', i + 4)) {
    const len = zip.readUInt16LE(i + 26);
    names.push(zip.subarray(i + 30, i + 30 + len).toString());
  }
  assert.ok(names.length > 0);
  assert.ok(!names.some((n) => n.split('/').some((seg) => seg === '..' || seg === '.')), names.join(' | '));
});

test('sin configuración de login, en producción no deja entrar a nadie (salvo AUTH_MODE=off explícito)', async () => {
  const port = PORT + 1;
  const dir = fs.mkdtempSync(path.join(path.dirname(DATA_DIR), 'nonotion-test-prod-'));
  const blank = { GITHUB_CLIENT_ID: undefined, GITHUB_CLIENT_SECRET: undefined, AUTH_ALLOWED_GITHUB_USERS: undefined, PUBLIC_URL: undefined, AUTH_MODE: undefined };
  let p = spawnServer({ ...blank, NODE_ENV: 'production' }, port, dir);
  await waitUp(`http://127.0.0.1:${port}`);
  assert.equal((await fetch(`http://127.0.0.1:${port}/api/pages`)).status, 503);
  assert.equal((await fetch(`http://127.0.0.1:${port}/api/workspaces`, { method: 'POST', body: '{"name":"x"}', headers: { 'Content-Type': 'application/json' } })).status, 503);
  await stopProc(p);
  // solo la lista de propietarios, sin el resto: también cerrado (aunque no sea producción)
  p = spawnServer({ ...blank, AUTH_ALLOWED_GITHUB_USERS: 'owner1' }, port, dir);
  await waitUp(`http://127.0.0.1:${port}`);
  assert.equal((await fetch(`http://127.0.0.1:${port}/api/pages`)).status, 503);
  await stopProc(p);
  p = spawnServer({ ...blank, NODE_ENV: 'production', AUTH_MODE: 'off' }, port, dir);
  await waitUp(`http://127.0.0.1:${port}`);
  assert.equal((await fetch(`http://127.0.0.1:${port}/api/pages`)).status, 200);
  await stopProc(p);
  fs.rmSync(dir, { recursive: true, force: true });
});
