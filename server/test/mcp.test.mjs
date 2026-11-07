// Integración: arranca el servidor real y habla con /mcp/<token> como lo hace
// el conector de claude.ai (tools/list y tools/call por Streamable HTTP).
import './setup.mjs';
import { DATA_DIR } from './setup.mjs';
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const PORT = 40000 + Math.floor(Math.random() * 20000);
const BASE = `http://127.0.0.1:${PORT}`;
let server;
let token;

before(async () => {
  const env = { ...process.env, DATA_DIR, PORT: String(PORT) };
  for (const k of ['GITHUB_CLIENT_ID', 'GITHUB_CLIENT_SECRET', 'AUTH_ALLOWED_GITHUB_USERS', 'PUBLIC_URL']) delete env[k];
  server = spawn(process.execPath, ['server/index.js'], { cwd: ROOT, env, stdio: 'ignore' });
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch(`${BASE}/api/health`)).ok) break;
    } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  token = fs.readFileSync(path.join(DATA_DIR, 'mcp_token'), 'utf8').trim();
});
after(() => server?.kill());

const rpc = async (method, params, tok = token) => {
  const r = await fetch(`${BASE}/mcp/${tok}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  const line = (await r.text()).split('\n').find((l) => l.startsWith('data: '));
  return JSON.parse(line.slice(6)).result;
};
const call = async (name, args, tok) => {
  const res = await rpc('tools/call', { name, arguments: args }, tok);
  return { text: res.content[0].text, isError: !!res.isError };
};
const api = async (p, body, method = body ? 'POST' : 'GET') =>
  (
    await fetch(BASE + p, {
      method,
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    })
  ).json();

test('registra move_page y move_pages con su esquema', async () => {
  const { tools } = await rpc('tools/list', {});
  const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
  const mp = byName.move_page;
  assert.ok(mp, 'move_page registrada');
  assert.equal(
    mp.description,
    'Mueve una página (y sus subpáginas) bajo otro padre o a la raíz. Úsala para reclasificar; no cambia contenido, etiquetas ni ids.'
  );
  assert.deepEqual([...mp.inputSchema.required].sort(), ['new_parent_id', 'page_id']);
  const np = mp.inputSchema.properties.new_parent_id;
  const types = np.type ? [].concat(np.type) : (np.anyOf || []).map((x) => x.type);
  assert.ok(types.includes('string') && types.includes('null'), `new_parent_id admite null: ${JSON.stringify(np)}`);
  assert.equal(mp.inputSchema.properties.position.type, 'integer');
  assert.ok(mp.inputSchema.properties.before_id && mp.inputSchema.properties.after_id);
  const mps = byName.move_pages;
  assert.ok(mps, 'move_pages registrada');
  assert.equal(mps.inputSchema.properties.moves.type, 'array');
  assert.deepEqual([...mps.inputSchema.properties.moves.items.required].sort(), ['new_parent_id', 'page_id']);
  assert.match(byName.create_page.description, /Antes de crear, usa list_pages\/search_pages para elegir el padre temático adecuado; usa Inbox solo si no encaja en ninguna sección\./);
});

test('move_page por MCP: ruta anterior → nueva, subpáginas, raíz, no-op y errores', async () => {
  const onyx = await api('/api/pages', { title: 'ONYX' });
  const mvp = await api('/api/pages', { title: 'MVP', parent_id: onyx.id });
  const fails = await api('/api/capture', { markdown: 'x', title: 'Fails' }); // va al Inbox
  await api('/api/capture', { markdown: 'y', title: 'Detalle', parent_id: fails.id });

  let r = await call('move_page', { page_id: fails.id, new_parent_id: mvp.id });
  assert.equal(r.isError, false);
  assert.equal(r.text, '«Fails»: Inbox / Fails → ONYX / MVP / Fails (1 subpágina)');

  r = await call('move_page', { page_id: fails.id, new_parent_id: mvp.id });
  assert.match(r.text, /^Sin cambios: «Fails» ya está en ONYX \/ MVP \/ Fails/);

  r = await call('move_page', { page_id: onyx.id, new_parent_id: fails.id });
  assert.equal(r.isError, true);
  assert.match(r.text, /ciclo/);

  r = await call('move_page', { page_id: fails.id, new_parent_id: null });
  assert.equal(r.text, '«Fails»: ONYX / MVP / Fails → Fails (1 subpágina)');

  r = await call('move_page', { page_id: 'noexiste', new_parent_id: null });
  assert.equal(r.isError, true);
  assert.match(r.text, /no existe en este espacio/);
});

test('move_pages por MCP: atómico', async () => {
  const dst = await api('/api/pages', { title: 'Destino' });
  const a = await api('/api/pages', { title: 'A' });
  const b = await api('/api/pages', { title: 'B' });
  let r = await call('move_pages', {
    moves: [
      { page_id: a.id, new_parent_id: dst.id },
      { page_id: b.id, new_parent_id: b.id },
    ],
  });
  assert.equal(r.isError, true);
  assert.match(r.text, /Movimiento 2 de 2.*No se ha aplicado ninguno/);
  assert.equal((await api(`/api/pages/${a.id}`)).parent_id, null, 'A sigue en la raíz');
  r = await call('move_pages', {
    moves: [
      { page_id: a.id, new_parent_id: dst.id },
      { page_id: b.id, new_parent_id: dst.id, position: 0 },
    ],
  });
  assert.match(r.text, /^2 de 2 página\(s\) movida\(s\)/);
  const kids = (await api('/api/pages')).filter((p) => p.parent_id === dst.id).map((p) => p.title);
  assert.deepEqual(kids, ['B', 'A']);
});

test('no se puede mover a otro espacio ni ver sus páginas', async () => {
  const otro = await (
    await fetch(`${BASE}/api/workspaces`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Otro' }) })
  ).json();
  const ajena = await (
    await fetch(`${BASE}/api/pages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Workspace': otro.id },
      body: JSON.stringify({ title: 'Ajena' }),
    })
  ).json();
  const mia = await api('/api/pages', { title: 'Mía' });
  let r = await call('move_page', { page_id: mia.id, new_parent_id: ajena.id });
  assert.equal(r.isError, true);
  assert.match(r.text, /no existe en este espacio \(no se puede mover entre espacios\)/);
  r = await call('move_page', { page_id: ajena.id, new_parent_id: null });
  assert.equal(r.isError, true);
  assert.match(r.text, /no existe en este espacio/);
});

test('arrastrar en el árbol (endpoint de la interfaz) usa la misma función', async () => {
  const p = await api('/api/pages', { title: 'Padre UI' });
  const x = await api('/api/pages', { title: 'X' });
  const r = await api(`/api/pages/${x.id}/move`, { parent_id: p.id, index: 0 });
  assert.equal(r.ok, true);
  assert.equal(r.to, 'Padre UI / X');
  const bad = await fetch(`${BASE}/api/pages/${p.id}/move`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ parent_id: x.id }),
  });
  assert.equal(bad.status, 400);
  assert.match((await bad.json()).error, /ciclo/);
});

test('tag_page: quitar "Pegasus" quita "pegasus" y se guardan en minúsculas', async () => {
  const p = await api('/api/capture', { markdown: 'z', title: 'Etiquetada', tags: ['Pegasus'] });
  assert.deepEqual(p.tags, ['pegasus']);
  let r = await call('tag_page', { page_id: p.id, add: ['pegasus'] });
  assert.match(r.text, /#pegasus$/);
  r = await call('tag_page', { page_id: p.id, remove: ['Pegasus'] });
  assert.match(r.text, /\(ninguna\)$/);
});
