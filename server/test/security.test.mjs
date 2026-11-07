// Regresiones de la auditoría: aislamiento entre espacios con rutas
// "disfrazadas", adjuntos que el navegador ejecutaría, URLs peligrosas,
// páginas bajo padres en la papelera y token histórico revocado.
import './setup.mjs';
import { DATA_DIR } from './setup.mjs';
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const PORT = 40000 + Math.floor(Math.random() * 20000);
const BASE = `http://127.0.0.1:${PORT}`;
let server;
let tokA;
const tokB = 'tokB_audit_xxxxxxxxxxxxxxxxxxxxxxx';

async function start() {
  const env = { ...process.env, DATA_DIR, PORT: String(PORT) };
  for (const k of ['GITHUB_CLIENT_ID', 'GITHUB_CLIENT_SECRET', 'AUTH_ALLOWED_GITHUB_USERS', 'PUBLIC_URL']) delete env[k];
  server = spawn(process.execPath, ['server/index.js'], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'ignore'] });
  let out = '';
  server.stdout.on('data', (d) => (out += d));
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch(`${BASE}/api/health`)).ok) break;
    } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  return () => out;
}
async function stop() {
  if (!server) return;
  const done = new Promise((r) => server.once('exit', r));
  server.kill();
  await done;
  server = null;
}

let logOf;
before(async () => {
  logOf = await start();
  tokA = fs.readFileSync(path.join(DATA_DIR, 'mcp_token'), 'utf8').trim();
  const db = new Database(path.join(DATA_DIR, 'nonotion.db'));
  db.prepare("INSERT INTO workspaces (id, name) VALUES ('ws_bbbbbbbbbbbb', 'B')").run();
  db.prepare("INSERT INTO api_tokens (token, workspace_id, label) VALUES (?, 'ws_bbbbbbbbbbbb', 'b')").run(tokB);
  db.close();
});
after(stop);

const call = async (p, tok, opts = {}) => {
  const r = await fetch(BASE + p, { ...opts, headers: { Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json', ...(opts.headers || {}) } });
  const text = await r.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {}
  return { status: r.status, text, json, headers: r.headers };
};
const post = (p, tok, body) => call(p, tok, { method: 'POST', body: JSON.stringify(body) });

test('otro espacio no llega a los datos ni con /API ni con ids codificados', async () => {
  const page = (await post('/api/pages', tokA, { title: 'SECRETO_A' })).json;
  await call(`/api/pages/${page.id}`, tokA, { method: 'PUT', body: JSON.stringify({ content: { type: 'doc', content: [] } }) });
  const enc = '%' + page.id.charCodeAt(0).toString(16) + page.id.slice(1);
  const attempts = [
    ['GET', `/api/pages/${page.id}`],
    ['GET', `/API/pages/${page.id}`],
    ['GET', `/Api/pages/${page.id}/markdown`],
    ['GET', `/api/pages/${enc}`],
    ['GET', `/api/pages/${enc}/markdown`],
    ['PUT', `/API/pages/${page.id}`],
    ['PUT', `/api/pages/${enc}`],
    ['POST', `/api/pages/${enc}/share`],
    ['DELETE', `/api/pages/${enc}`],
    ['DELETE', `/API/pages/${page.id}`],
    ['GET', `/api/pages/${page.id};x`],
    ['GET', '/api/versions/%31'],
    ['GET', '/API/versions/1'],
  ];
  for (const [method, p] of attempts) {
    const r = await call(p, tokB, { method, body: method === 'GET' || method === 'DELETE' ? undefined : JSON.stringify({ title: 'X' }) });
    assert.ok(!r.text.includes('SECRETO_A'), `${method} ${p} filtra datos: ${r.status} ${r.text.slice(0, 80)}`);
    assert.ok(r.status === 404 || r.status === 400 || (r.status === 200 && /<!doctype html|<html/i.test(r.text)), `${method} ${p} → ${r.status}`);
  }
  const still = (await call(`/api/pages/${page.id}`, tokA)).json;
  assert.equal(still.title, 'SECRETO_A', 'la página sigue intacta');
  assert.equal(still.trashed_at, null);
  assert.equal(still.share_token, null);
  // el dueño sigue entrando con normalidad, también con un id codificado válido
  assert.equal((await call(`/api/pages/${enc}`, tokA)).json.title, 'SECRETO_A');
  // el MCP rechaza ids con secuencias raras
  const rpc = await fetch(`${BASE}/mcp/${tokB}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'read_page', arguments: { page_id: enc } } }),
  });
  assert.doesNotMatch(await rpc.text(), /SECRETO_A/);
});

test('adjuntos HTML/SVG no se ejecutan en nuestro dominio', async () => {
  const page = (await post('/api/pages', tokA, { title: 'Adjuntos' })).json;
  const up = async (name, type, body) => {
    const fd = new FormData();
    fd.append('page_id', page.id);
    fd.append('file', new Blob([body], { type }), name);
    return (await fetch(`${BASE}/api/files`, { method: 'POST', headers: { Authorization: `Bearer ${tokA}` }, body: fd })).json();
  };
  const html = await up('evil.html', 'text/html', '<script>alert(1)</script>');
  let r = await call(`/files/${html.id}/evil.html`, tokA);
  assert.match(r.headers.get('content-type'), /^text\/plain/);
  assert.match(r.headers.get('content-security-policy') || '', /sandbox/);
  const svg = await up('x.svg', 'image/svg+xml', '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
  r = await call(`/files/${svg.id}/x.svg`, tokA);
  assert.match(r.headers.get('content-security-policy') || '', /sandbox/);
  const png = await up('a.png', 'image/png', 'x');
  r = await call(`/files/${png.id}/a.png`, tokA);
  assert.equal(r.headers.get('content-type'), 'image/png');
  // otro espacio tampoco llega al archivo con /Files o id codificado
  for (const p of [`/Files/${html.id}`, `/files/%${html.id.charCodeAt(0).toString(16)}${html.id.slice(1)}`]) {
    const x = await call(p, tokB);
    assert.ok(!x.text.includes('alert(1)'), `${p} → ${x.status}`);
  }
});

test('enlaces javascript: o data: en canvas e ideas se rechazan', async () => {
  const bad = ['javascript:alert(1)', ' JAVASCRIPT:alert(1)', 'data:text/html,<script>1</script>', 'vbscript:x', '/files/abc'];
  for (const url of bad) {
    const r = await post('/api/pages', tokA, {
      kind: 'canvas',
      title: 'c',
      content: { nodes: [{ id: 'l', type: 'link', url, x: 0, y: 0, width: 100, height: 100 }] },
    });
    assert.equal(r.status, 400, `canvas con ${url}`);
    const i = await post('/api/pages', tokA, { kind: 'idea', content: { type: 'idea', seeds: [{ kind: 'link', url }] } });
    assert.equal(i.status, 400, `idea con ${url}`);
  }
  const ok = await post('/api/pages', tokA, {
    kind: 'canvas',
    title: 'c',
    content: { nodes: [{ id: 'l', type: 'link', url: 'https://example.com', x: 0, y: 0, width: 100, height: 100 }] },
  });
  assert.equal(ok.status, 200);
});

test('una página nunca se crea bajo un padre en la papelera ni bajo una idea, y vaciar la papelera no se lleva páginas vivas', async () => {
  const p = (await post('/api/pages', tokA, { title: 'Padre' })).json;
  await call(`/api/pages/${p.id}`, tokA, { method: 'DELETE' });
  assert.equal((await post('/api/pages', tokA, { title: 'Hija', parent_id: p.id })).status, 400);
  assert.equal((await post('/api/capture', tokA, { markdown: 'x', parent_id: p.id })).status, 400);
  const idea = (await post('/api/pages', tokA, { kind: 'idea', title: 'Inbox', content: { type: 'idea', seeds: [{ kind: 'text', text: 'Inbox' }] } })).json;
  assert.equal((await post('/api/pages', tokA, { title: 'Bajo idea', parent_id: idea.id })).status, 400);
  // la captura sin padre no cae dentro de una idea llamada "Inbox"
  const cap = (await post('/api/capture', tokA, { markdown: '# Captura' })).json;
  const inbox = (await call(`/api/pages/${cap.id}`, tokA)).json.parent_id;
  assert.notEqual(inbox, idea.id);
  assert.equal((await call(`/api/pages/${inbox}`, tokA)).json.kind, 'doc');

  // red de seguridad: una hija viva bajo un padre en la papelera (datos de antes del arreglo)
  const p2 = (await post('/api/pages', tokA, { title: 'Padre2' })).json;
  const child = (await post('/api/pages', tokA, { title: 'Hija viva', parent_id: p2.id })).json;
  const grand = (await post('/api/pages', tokA, { title: 'Nieta viva', parent_id: child.id })).json;
  const db = new Database(path.join(DATA_DIR, 'nonotion.db'));
  db.prepare(`UPDATE pages SET trashed_at = datetime('now') WHERE id = ?`).run(p2.id);
  db.close();
  await call(`/api/trash/${p2.id}`, tokA, { method: 'DELETE' });
  const c = (await call(`/api/pages/${child.id}`, tokA)).json;
  assert.equal(c.title, 'Hija viva', 'la hija viva sobrevive');
  assert.equal(c.parent_id, null, 'y pasa a la raíz');
  assert.equal((await call(`/api/pages/${grand.id}`, tokA)).json.parent_id, child.id, 'con su subárbol');
});

test('entradas inválidas en ideas y fechas responden con error en vez de colgarse o borrar datos', async () => {
  const idea = (await post('/api/pages', tokA, { kind: 'idea', content: { type: 'idea', seeds: [{ kind: 'text', text: 'x' }] } })).json;
  const r = await Promise.race([
    post(`/api/pages/${idea.id}/idea`, tokA, { seeds_add: 5 }),
    new Promise((res) => setTimeout(() => res({ status: 'timeout' }), 4000)),
  ]);
  assert.equal(r.status, 400);
  const page = (await post('/api/pages', tokA, { title: 'Con fecha', page_date: '2026-11-07' })).json;
  const bad = await call(`/api/pages/${page.id}`, tokA, { method: 'PUT', body: JSON.stringify({ page_date: '7/11/2026' }) });
  assert.equal(bad.status, 400);
  assert.equal((await call(`/api/pages/${page.id}`, tokA)).json.page_date, '2026-11-07', 'la fecha no se pierde');
});

test('un cuerpo grande sin autenticación no llega a procesarse en el MCP', async () => {
  const r = await fetch(`${BASE}/mcp/token-que-no-existe`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"x":"' + 'a'.repeat(2_000_000) + '"}' });
  assert.equal(r.status, 401);
});

test('el registro no muestra el token y revocarlo sobrevive al reinicio', async () => {
  assert.ok(!logOf().includes(tokA), 'el token no aparece entero en el registro');
  const db = new Database(path.join(DATA_DIR, 'nonotion.db'));
  db.prepare('DELETE FROM api_tokens WHERE token = ?').run(tokA); // revocado desde Ajustes
  db.close();
  await stop();
  logOf = await start();
  // (sin login de GitHub las rutas /api no exigen token; el MCP sí)
  const mcp = (tok) => fetch(`${BASE}/mcp/${tok}`, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) });
  assert.equal((await mcp(tokA)).status, 401, 'sigue revocado tras reiniciar');
  assert.equal((await mcp(tokB)).status, 200);
});
