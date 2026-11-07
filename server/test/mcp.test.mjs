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

test('canvas por MCP: crear, leer, actualizar y protecciones', async () => {
  const nota = await api('/api/pages', { title: 'Nota del canvas' });
  let r = await call('create_canvas', {
    title: 'Mapa',
    nodes: [
      { id: 't1', type: 'text', text: '# Plan', x: 0, y: 0, width: 260, height: 120 },
      { id: 'f1', type: 'file', file: `/p/${nota.id}`, x: 320, y: 0, width: 300, height: 200 },
    ],
    edges: [{ id: 'e1', fromNode: 't1', toNode: 'f1', label: 'detalla' }],
  });
  assert.equal(r.isError, false, r.text);
  const id = r.text.match(/id: ([A-Za-z0-9_-]+)/)[1];
  assert.equal((await api(`/api/pages/${id}`)).kind, 'canvas');

  r = await call('read_page', { page_id: id });
  assert.match(r.text, /CANVAS/);
  assert.match(r.text, /"Plan" ---> página «Nota del canvas»: detalla/);
  assert.match(r.text, /JSON Canvas:\n```json\n\{"nodes"/);

  // el grafo y los backlinks ven el enlace del canvas a la página
  const g = await api('/api/graph');
  assert.ok(g.links.some((l) => l.source === id && l.target === nota.id));
  assert.ok((await api(`/api/pages/${nota.id}/backlinks`)).some((b) => b.id === id));

  r = await call('update_canvas', { page_id: id, nodes: [{ id: 'solo', type: 'text', text: 'nuevo', x: 0, y: 0, width: 200, height: 100 }] });
  assert.equal(r.isError, false, r.text);
  assert.equal(JSON.parse((await api(`/api/pages/${id}`)).content).nodes[0].id, 'solo');
  assert.ok((await api(`/api/pages/${id}/versions`)).length >= 1, 'la versión anterior queda en el historial');

  // no se puede estropear un canvas con Markdown, ni usar update_canvas en un documento
  assert.match((await call('append_to_page', { page_id: id, markdown: 'x' })).text, /es un canvas/);
  assert.match((await call('update_page', { page_id: id, markdown: 'x' })).text, /canvas/);
  assert.match((await call('update_canvas', { page_id: nota.id, nodes: [] })).text, /no es un canvas/);
  r = await call('create_canvas', { title: 'Malo', nodes: [{ id: 'x', type: 'nada', x: 0, y: 0, width: 1, height: 1 }] });
  assert.equal(r.isError, true);
  assert.match(r.text, /tipo "nada" no válido/);
});

test('papelera de archivos: lista los adjuntos borrados del espacio', async () => {
  const p = await api('/api/pages', { title: 'Con adjunto' });
  const fd = new FormData();
  fd.append('page_id', p.id);
  fd.append('file', new Blob(['hola'], { type: 'text/plain' }), 'borrame.txt');
  const up = await (await fetch(`${BASE}/api/files`, { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: fd })).json();
  await api(`/api/files/${up.id}`, null, 'DELETE');
  const r = await fetch(`${BASE}/api/trash/files`, { headers: { Authorization: `Bearer ${token}` } });
  assert.equal(r.status, 200, 'antes fallaba con 500 (faltaba el espacio en la consulta)');
  const list = await r.json();
  assert.ok(list.some((f) => f.id === up.id && f.page_title === 'Con adjunto'));
});

test('ideas por MCP: crear, desarrollar, materializar, leer y protecciones', async () => {
  const { tools } = await rpc('tools/list', {});
  const names = tools.map((t) => t.name);
  for (const n of ['list_ideas', 'create_idea', 'develop_idea', 'materialize_idea']) assert.ok(names.includes(n), `${n} registrada`);

  const origen = await api('/api/capture', { title: 'Nota origen', markdown: 'Texto de la nota' });
  let r = await call('create_idea', { seed_text: 'Temas:\n- ingesta única\n- costes', seed_url: 'https://example.com/ref', tags: ['Ingesta'] });
  assert.equal(r.isError, false, r.text);
  const id = r.text.match(/id: ([A-Za-z0-9_-]+)/)[1];
  const page = await api(`/api/pages/${id}`);
  assert.equal(page.kind, 'idea');
  assert.equal(page.parent_id, null, 'fuera del árbol');
  assert.equal(page.title, 'Temas:', 'título derivado de la semilla');
  assert.deepEqual(page.tags, ['ingesta']);
  const idea0 = JSON.parse(page.content);
  assert.equal(idea0.seeds.length, 2);
  assert.equal(idea0.status, 'seed');

  // las ideas no salen en el árbol de list_pages, sí en list_ideas
  r = await call('list_pages', {});
  assert.doesNotMatch(r.text, /Temas:/);
  assert.match(r.text, /Ideas en desarrollo \(fuera del árbol\): 1/);
  r = await call('list_ideas', {});
  assert.match(r.text, new RegExp(`Temas: \\(id: ${id}, semilla, 2 semilla\\(s\\), 0 paso\\(s\\), 0 resultado\\(s\\)\\)`));

  // la búsqueda encuentra la idea por el texto de su semilla
  const found = await api('/api/search?q=ingesta');
  assert.ok(found.some((p) => p.id === id), 'la idea es buscable');

  r = await call('develop_idea', {
    page_id: id,
    steps: [
      { kind: 'question', text: '¿Qué fuentes entran?' },
      { kind: 'decision', text: `Partimos de [Nota origen](/p/${origen.id})` },
    ],
    summary: 'Un único pipeline de ingesta',
  });
  assert.equal(r.isError, false, r.text);
  assert.match(r.text, /2 paso\(s\) en total, estado developing/);

  r = await call('read_page', { page_id: id });
  assert.match(r.text, /es una IDEA/);
  assert.match(r.text, /## Resumen\n\nUn único pipeline de ingesta/);
  assert.match(r.text, /Pregunta \(Claude\):\n {4}¿Qué fuentes entran\?/);
  assert.match(r.text, /enlace https:\/\/example\.com\/ref/);

  // materializar: documento + diagrama + planning
  const doc = await api('/api/capture', { title: 'Diseño de ingesta', markdown: `De la idea [💡](/p/${id})` });
  const mapa = await call('create_canvas', { title: 'Mapa ingesta', nodes: [{ id: 'a', type: 'file', file: `/p/${id}`, x: 0, y: 0, width: 300, height: 200 }] });
  const mapaId = mapa.text.match(/id: ([A-Za-z0-9_-]+)/)[1];
  const plan = await api('/api/capture', { title: 'Plan ingesta', markdown: '- [ ] fase 1', page_date: '2026-12-01' });
  r = await call('materialize_idea', {
    page_id: id,
    outcomes: [
      { type: 'page', page_id: doc.id, label: 'Documento de diseño' },
      { type: 'page', page_id: mapaId, label: 'Diagrama' },
      { type: 'plan', page_id: plan.id, label: 'Planning' },
      { type: 'external', url: 'https://docs.google.com/document/d/xyz', label: 'Doc compartido' },
    ],
  });
  assert.equal(r.isError, false, r.text);
  assert.match(r.text, /materializada \(documented\): 4 resultado/);
  const idea1 = JSON.parse((await api(`/api/pages/${id}`)).content);
  assert.equal(idea1.status, 'documented');
  assert.equal(idea1.outcomes[1].type, 'canvas', 'un resultado que apunta a un canvas se marca como canvas');

  // grafo y backlinks en ambos sentidos
  const g = await api('/api/graph');
  assert.ok(g.pages.some((p) => p.id === id && p.kind === 'idea'));
  for (const target of [origen.id, doc.id, mapaId, plan.id]) {
    assert.ok(g.links.some((l) => l.source === id && l.target === target), `enlace idea → ${target}`);
  }
  assert.ok(g.links.some((l) => l.source === doc.id && l.target === id), 'el documento enlaza a la idea');
  assert.ok((await api(`/api/pages/${plan.id}/backlinks`)).some((b) => b.id === id), 'el plan ve la idea en sus backlinks');
  assert.ok((await api(`/api/pages/${id}/backlinks`)).some((b) => b.id === doc.id), 'la idea ve al documento');
  assert.ok((await api(`/api/pages/${id}/versions`)).length >= 2, 'cada parche deja versión');

  // la vista Ideas y list_ideas con filtro
  const list = await api('/api/ideas');
  assert.equal(list.length, 1);
  assert.equal(list[0].status, 'documented');
  assert.equal(list[0].outcomes.length, 4);
  assert.match((await call('list_ideas', { status: 'seed' })).text, /No hay ideas en estado "seed"/);

  // protecciones: nada de Markdown sobre una idea, ni mover al árbol, ni herramientas de idea sobre documentos
  assert.match((await call('append_to_page', { page_id: id, markdown: 'x' })).text, /es una idea/);
  assert.match((await call('edit_page', { page_id: id, find_text: 'a', replace_text: 'b' })).text, /es una idea/);
  assert.match((await call('update_page', { page_id: id, markdown: 'x' })).text, /idea/);
  assert.match((await call('move_page', { page_id: id, new_parent_id: origen.id })).text, /es una idea/);
  assert.match((await call('move_page', { page_id: origen.id, new_parent_id: id })).text, /no puede contener/);
  assert.match((await call('develop_idea', { page_id: origen.id, steps: [{ kind: 'note', text: 'x' }] })).text, /no es una idea/);
  assert.match((await call('materialize_idea', { page_id: id, outcomes: [{ type: 'page' }] })).text, /falta page_id/);
  const bad = await fetch(`${BASE}/api/pages/${id}/idea`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ outcomes_add: [{ type: 'page', page_id: 'noexiste1234' }] }),
  });
  assert.equal(bad.status, 400);
  assert.match((await bad.json()).error, /no existe/);
  // la idea no puede ser su propio resultado ni colgar de un padre
  assert.equal((await fetch(`${BASE}/api/pages`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ kind: 'idea', parent_id: origen.id }) })).status, 400);

  // una captura como semilla: OCR si hay tesseract; siempre visible para Claude como adjunto
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
    'base64'
  );
  const fd = new FormData();
  fd.append('page_id', id);
  fd.append('file', new Blob([png], { type: 'image/png' }), 'captura.png');
  const up = await (await fetch(`${BASE}/api/files`, { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: fd })).json();
  const withSeed = await api(`/api/pages/${id}/idea`, { seeds_add: [{ kind: 'file', file_id: up.id }] });
  const seed = withSeed.idea.seeds.at(-1);
  assert.equal(seed.kind, 'image', 'un archivo de imagen pasa a ser captura');
  assert.equal(typeof seed.ocr, 'string');
  r = await call('read_page', { page_id: id });
  assert.match(r.text, new RegExp(`captura captura\\.png \\(file_id: ${up.id}\\)`));
  assert.match(r.text, new RegExp(`captura\\.png \\(file_id: ${up.id}, image/png`), 'y aparece como adjunto para read_attachment');
});

test('seguimiento por MCP: listas con campos propios, tickets, filtros, bloqueos y cronología', async () => {
  const { tools } = await rpc('tools/list', {});
  const names = tools.map((t) => t.name);
  for (const n of ['list_trackers', 'create_tracker', 'update_tracker', 'list_issues', 'create_issue', 'update_issue', 'link_issue']) {
    assert.ok(names.includes(n), `${n} registrada`);
  }
  assert.match((await call('list_trackers', {})).text, /No hay listas todavía. Plantillas para create_tracker: blockers/);

  const proyecto = await api('/api/pages', { title: 'Proyecto AXA' });
  const acta = await api('/api/capture', { title: 'Acta comité AXA', markdown: 'Se acuerda revisar permisos' });
  const doc = await api('/api/capture', { title: 'Arquitectura AXA', markdown: 'Diseño de la plataforma' });

  // dos listas distintas, con sus propios campos y prefijos
  let r = await call('create_tracker', { title: 'Bloqueantes AXA', template: 'blockers', parent_id: proyecto.id });
  assert.equal(r.isError, false, r.text);
  assert.match(r.text, /prefijo BLQ/);
  const blqId = r.text.match(/id: ([A-Za-z0-9_-]+)/)[1];
  r = await call('create_tracker', { title: 'To-do', template: 'todo' });
  assert.match(r.text, /prefijo TODO/);
  r = await call('create_tracker', { title: 'Otros bloqueos', template: 'blockers' });
  assert.match(r.text, /prefijo BLQ2/, 'prefijo único por espacio');
  r = await call('list_trackers', {});
  assert.match(r.text, /Bloqueantes AXA — prefijo BLQ/);
  assert.match(r.text, /Impacto \[select: Alto, Medio, Bajo\]/);
  assert.match(r.text, /Prioridad \[select: Alta, Media, Baja\]/);

  // la lista está en el árbol, bajo su padre
  const tree = await call('list_pages', {});
  assert.match(tree.text, /Bloqueantes AXA \(id: [^,]+, lista de seguimiento\)/);

  // ticket con campos por nombre y opción
  r = await call('create_issue', {
    tracker: 'BLQ',
    title: 'Falta acceso a Unity Catalog',
    fields: { Impacto: 'alto', Responsable: 'Equipo AXA', 'Fecha límite': '2026-11-20', Área: 'Datos' },
    description: 'Sin permisos **no** se puede seguir',
    links: [
      { type: 'origin', target: acta.id },
      { type: 'documents', target: doc.id },
    ],
  });
  assert.equal(r.isError, false, r.text);
  assert.match(r.text, /Ticket creado: BLQ-1 .* en «Bloqueantes AXA» .*Abierto/);
  const id1 = r.text.match(/\(id: ([A-Za-z0-9_-]+)/)[1];
  assert.equal((await api(`/api/pages/${id1}`)).parent_id, blqId, 'el ticket cuelga de su lista');
  r = await call('create_issue', { tracker: 'To-do', title: 'Revisar contrato', fields: { Prioridad: 'Alta' } });
  assert.match(r.text, /TODO-1/);
  r = await call('create_issue', { tracker: 'BLQ', title: 'Migrar tablas', fields: { Impacto: 'Medio' } });
  assert.match(r.text, /BLQ-2/);

  // errores claros: campo u opción inexistentes, lista inexistente
  assert.match((await call('create_issue', { tracker: 'BLQ', title: 'x', fields: { Cliente: 'AXA' } })).text, /no tiene ningún campo «Cliente»/);
  assert.match((await call('create_issue', { tracker: 'BLQ', title: 'x', fields: { Impacto: 'Enorme' } })).text, /"Enorme" no es una opción de «Impacto» \(Alto, Medio, Bajo\)/);
  assert.match((await call('create_issue', { tracker: 'NOPE', title: 'x' })).text, /No hay ninguna lista "NOPE"/);

  // update_tracker: campo nuevo y opciones
  r = await call('update_tracker', { tracker: 'BLQ', add_fields: [{ name: 'Cliente', type: 'select', options: ['AXA', 'Interno'] }], add_options: [{ field: 'Área', options: ['Legal'] }] });
  assert.equal(r.isError, false, r.text);
  assert.match(r.text, /Cliente/);
  assert.equal((await call('update_issue', { issue: 'BLQ-1', fields: { Cliente: 'AXA', Área: 'Legal' } })).isError, false);

  // bloqueos entre tickets (también de otra lista), ciclos rechazados
  assert.equal((await call('link_issue', { issue: 'BLQ-1', type: 'blocks', target: 'BLQ-2' })).isError, false);
  assert.equal((await call('link_issue', { issue: 'BLQ-1', type: 'blocks', target: 'TODO-1' })).isError, false);
  assert.match((await call('link_issue', { issue: 'BLQ-2', type: 'blocks', target: 'BLQ-1' })).text, /ciclo/);
  assert.match((await call('link_issue', { issue: 'BLQ-1', type: 'blocks', target: doc.id })).text, /solo se usa entre tickets/);

  // listados y filtros
  r = await call('list_issues', { blocked_only: true });
  assert.match(r.text, /## Bloqueantes AXA\n- BLQ-2 Migrar tablas · Abierto · Impacto: Medio · ⛔ bloqueado por 1/);
  assert.match(r.text, /## To-do\n- TODO-1 Revisar contrato · Pendiente · Prioridad: Alta · ⛔ bloqueado por 1/);
  r = await call('list_issues', { tracker: 'BLQ', fields: { Impacto: 'Alto' } });
  assert.match(r.text, /BLQ-1 Falta acceso/);
  assert.doesNotMatch(r.text, /BLQ-2/);
  r = await call('list_issues', { fields: { Responsable: 'equipo axa' } });
  assert.match(r.text, /BLQ-1/);

  // read_page de un ticket y de una lista
  r = await call('read_page', { page_id: id1 });
  assert.match(r.text, /TICKET DE SEGUIMIENTO/);
  assert.match(r.text, /\*\*BLQ-1\*\* · lista «Bloqueantes AXA» · estado: \*\*Abierto\*\* \(Pendiente\) · Impacto: Alto · Área: Legal · Responsable: Equipo AXA · Fecha límite: 2026-11-20 · Cliente: AXA/);
  assert.match(r.text, /Viene de: «Acta comité AXA»/);
  assert.match(r.text, /Bloquea a: BLQ-2 «Migrar tablas» \[Abierto\]/);
  assert.match(r.text, /Área: Datos → Legal/);
  r = await call('read_page', { page_id: blqId });
  assert.match(r.text, /LISTA DE SEGUIMIENTO/);
  assert.match(r.text, /\| Clave \| Título \| Estado \| Impacto \| Área \| Responsable \| Fecha límite \| Cliente \|/);
  assert.match(r.text, /\| BLQ-1 \| Falta acceso a Unity Catalog \| Abierto \| Alto \| Legal \| Equipo AXA \| 2026-11-20 \| AXA \|/);
  assert.match((await call('append_to_page', { page_id: blqId, markdown: 'x' })).text, /lista de seguimiento/);

  // estados por nombre y cronología
  r = await call('update_issue', { issue: 'BLQ-1', status: 'en curso', comment: 'IT confirma que lo tramita' });
  assert.equal(r.isError, false, r.text);
  assert.match((await call('update_issue', { issue: 'BLQ-1', status: 'hecho' })).text, /"hecho" no es un estado de la lista \(Abierto, En curso, Bloqueado, Resuelto\)/);
  r = await call('read_page', { page_id: id1 });
  assert.match(r.text, /Estado: Abierto → En curso/);
  assert.match(r.text, /comentó:\n {4}IT confirma que lo tramita/);
  await call('update_issue', { issue: 'BLQ-1', status: 'Resuelto' });
  assert.doesNotMatch((await call('list_issues', { blocked_only: true })).text, /BLQ-2/, 'resolver el bloqueante desbloquea');

  // menciones, búsqueda, grafo y árbol
  const nota = await api('/api/capture', { title: 'Nota', markdown: 'Pendiente de BLQ-2 y TODO-1 y BLQ-20' });
  assert.deepEqual((await api(`/api/pages/${nota.id}/issues`)).mentioned.map((x) => x.key).sort(), ['BLQ-2', 'TODO-1']);
  assert.ok((await api('/api/search?q=BLQ-2')).some((p) => p.title === 'Migrar tablas'));
  const g = await api('/api/graph');
  assert.ok(g.links.some((l) => l.source === id1 && l.rel === 'blocks'));
  assert.ok(g.pages.some((p) => p.id === id1 && p.key === 'BLQ-1' && p.status === 'done'));
  assert.match((await call('move_page', { page_id: id1, new_parent_id: null })).text, /ticket/);
  assert.match((await call('move_page', { page_id: nota.id, new_parent_id: blqId })).text, /no puede contener/);
  assert.equal((await call('move_page', { page_id: blqId, new_parent_id: null })).isError, false, 'la lista se mueve como cualquier página');

  // idea → ticket
  const idea = (await call('create_idea', { seed_text: 'Automatizar altas de usuarios' })).text.match(/id: ([A-Za-z0-9_-]+)/)[1];
  r = await call('create_issue', { tracker: 'TODO', title: 'Automatizar altas', from_idea_id: idea });
  assert.match(r.text, /TODO-2/);
  const ideaDoc = JSON.parse((await api(`/api/pages/${idea}`)).content);
  assert.equal(ideaDoc.outcomes.at(-1).type, 'issue');
  assert.equal(ideaDoc.outcomes.at(-1).label, 'TODO-2');
});

test('listas independientes, plantilla Issues, relaciones de lista y agenda por tipo de fecha', async () => {
  const proyecto = await api('/api/pages', { title: 'Proyecto Beta' });
  const canvas = await api('/api/pages', { kind: 'canvas', title: 'Mapa Beta' });
  const reunion = await api('/api/pages', { title: 'Comité Beta', page_date: '2030-03-10' });

  // Issues como plantilla; una lista sin página no está en el árbol
  let r = await call('create_tracker', { title: 'Issues Beta', template: 'issues' });
  assert.match(r.text, /prefijo ISS/);
  assert.match(r.text, /Campos: Tipo, Prioridad, Responsable, Componente, Fecha límite/);
  const issId = r.text.match(/id: ([A-Za-z0-9_-]+)/)[1];
  r = await call('create_tracker', { title: 'Tareas Beta', template: 'todo', parent_id: proyecto.id });
  const todoId = r.text.match(/id: ([A-Za-z0-9_-]+)/)[1];
  const tree = await call('list_pages', {});
  assert.doesNotMatch(tree.text, /Issues Beta/, 'la lista independiente no está en el árbol');
  assert.match(tree.text, /Tareas Beta \(id: [^,]+, lista de seguimiento\)/, 'la lista con página sí');
  assert.match((await call('list_trackers', {})).text, /Issues Beta — prefijo ISS/, 'pero ambas en list_trackers');

  // tipos de fecha: plantilla (límite) y campo nuevo de inicio
  r = await call('update_tracker', { tracker: 'ISS', add_fields: [{ name: 'Inicio', type: 'date', date_role: 'start' }, { name: 'Demo', type: 'date', date_role: 'event' }] });
  assert.equal(r.isError, false, r.text);
  const cfg = (await api(`/api/pages/${issId}/tracker`)).config;
  assert.deepEqual(cfg.fields.filter((f) => f.type === 'date').map((f) => [f.name, f.date_role]), [['Fecha límite', 'deadline'], ['Inicio', 'start'], ['Demo', 'event']]);

  await call('create_issue', { tracker: 'ISS', title: 'Login roto', fields: { Tipo: 'Bug', Prioridad: 'Crítica', 'Fecha límite': '2030-03-12', Inicio: '2030-03-09' } });
  await call('create_issue', { tracker: 'ISS', title: 'Demo cliente', fields: { Demo: '2030-03-11' } });
  await call('create_issue', { tracker: 'ISS', title: 'Bug viejo', fields: { 'Fecha límite': '2020-01-01' } });
  await call('create_issue', { tracker: 'ISS', title: 'Cerrado', status: 'Cerrado', fields: { 'Fecha límite': '2030-03-12' } });

  // calendario: fechas de tickets por tipo, vencidos y eventos
  const cal = await api('/api/calendar?from=2030-03-01&to=2030-03-31&overdue=2030-03-01');
  assert.ok(cal.dated.some((p) => p.id === reunion.id), 'evento (página con fecha)');
  const roles = cal.issues.filter((i) => i.tracker_id === issId).map((i) => `${i.key}:${i.role}:${i.day}${i.overdue ? ':vencido' : ''}`).sort();
  assert.deepEqual(roles, ['ISS-1:deadline:2030-03-12', 'ISS-1:start:2030-03-09', 'ISS-2:event:2030-03-11', 'ISS-3:deadline:2020-01-01:vencido', 'ISS-4:deadline:2030-03-12'].sort());
  assert.ok(cal.trackers.some((t) => t.id === issId && t.has_dates));

  // agenda (MCP): por tipo y lista, sin hechos, con vencidos
  r = await call('agenda', { from: '2030-03-01', to: '2030-03-31', tracker: 'ISS' });
  assert.match(r.text, /## ⚠ Vencido\n- 2020-01-01 · ISS-3 Bug viejo/);
  assert.match(r.text, /## 2030-03-09\n- ▶ Empieza: ISS-1 Login roto — Inicio/);
  assert.match(r.text, /## 2030-03-11\n- 📌 Evento: ISS-2 Demo cliente — Demo/);
  assert.match(r.text, /⏰ Vence: ISS-1 Login roto — Fecha límite/);
  assert.doesNotMatch(r.text, /ISS-4 Cerrado/, 'sin tickets hechos por defecto');
  r = await call('agenda', { from: '2030-03-01', to: '2030-03-31', kinds: ['events'] });
  assert.match(r.text, /📅 Evento: Comité Beta/);
  assert.doesNotMatch(r.text, /ISS-/);

  // relaciones de la lista entera con canvas, página, otra lista e idea
  const idea = (await call('create_idea', { seed_text: 'Mejorar onboarding' })).text.match(/id: ([A-Za-z0-9_-]+)/)[1];
  for (const [type, target] of [['documents', canvas.id], ['relates', todoId], ['origin', idea], ['relates', reunion.id]]) {
    r = await call('link_issue', { tracker: 'ISS', type, target });
    assert.equal(r.isError, false, r.text);
  }
  assert.match((await call('link_issue', { tracker: 'ISS', type: 'blocks', target: todoId })).text, /lista entera/);
  const det = await api(`/api/pages/${issId}/tracker`);
  assert.deepEqual(det.links.map((l) => `${l.type}:${l.target.kind}`).sort(), ['documents:canvas', 'origin:idea', 'relates:doc', 'relates:tracker'].sort());
  const otra = await api(`/api/pages/${todoId}/tracker`);
  assert.ok(otra.incoming.some((l) => l.source.id === issId), 'la otra lista ve la relación');
  assert.ok((await api(`/api/pages/${canvas.id}/issues`)).linked.some((l) => l.issue.id === issId), 'el canvas ve la lista relacionada');
  assert.ok((await api('/api/graph')).links.some((l) => l.source === issId && l.target === canvas.id), 'y el grafo');
  r = await call('link_issue', { tracker: 'ISS', type: 'documents', target: canvas.id, remove: true });
  assert.equal(r.isError, false, r.text);

  // vincular y desvincular de una página (mover)
  assert.equal((await call('move_page', { page_id: issId, new_parent_id: proyecto.id })).isError, false);
  assert.match((await call('list_pages', {})).text, /Issues Beta/);
  assert.equal((await call('move_page', { page_id: issId, new_parent_id: null })).isError, false);
  assert.doesNotMatch((await call('list_pages', {})).text, /Issues Beta/);
});

test('actas: crear, detectar propuestas, proponer con Claude, aprobar (crea y enlaza) y calendario', async () => {
  const proyecto = await api('/api/pages', { title: 'Proyecto Gamma' });
  await call('create_tracker', { title: 'To-do Gamma', template: 'todo', parent_id: proyecto.id });
  await call('create_tracker', { title: 'Bloqueos Gamma', template: 'blockers' });
  const md = [
    '## 👥 Asistentes', '- Ana, Luis', '',
    '## ✅ Acciones',
    '- [ ] Pedir acceso a Unity Catalog @luis 2030-05-20',
    '- [ ] Revisar contrato (Ana)',
    '- [x] Ya hecho',
    '', '## ⚖️ Decisiones', '- Usamos Databricks', '- Fase 1 en junio',
    '', '## 💡 Ideas', '- Automatizar las altas',
    '', '## Riesgos', '- Falta presupuesto de licencias',
    '', 'Próxima reunión: 15/05/2030',
  ].join('\n');
  let r = await call('create_minutes', { title: 'Comité Gamma', date: '2030-05-08', project_id: proyecto.id, attendees: ['Ana', 'Luis'], markdown: md });
  assert.equal(r.isError, false, r.text);
  const id = r.text.match(/id: ([A-Za-z0-9_-]+)/)[1];
  const page = await api(`/api/pages/${id}`);
  assert.equal(page.kind, 'minutes');
  assert.equal(page.page_date, '2030-05-08');
  assert.equal(page.parent_id, null, 'fuera del árbol');
  assert.doesNotMatch((await call('list_pages', {})).text, /Comité Gamma/);
  assert.match((await call('list_minutes', {})).text, /2030-05-08 · Comité Gamma .*proyecto «Proyecto Gamma» · Ana, Luis/);

  // detección local (sin IA)
  const det = await api(`/api/pages/${id}/minutes/detect`, {});
  const items = det.items.map((i) => `${i.type}:${i.title}:${i.payload.assignee || ''}:${i.payload.date || ''}:${i.payload.tracker_hint || ''}`);
  assert.ok(items.includes('task:Pedir acceso a Unity Catalog:luis:2030-05-20:todo'), items.join(' | '));
  assert.ok(items.includes('task:Revisar contrato:Ana::todo'), items.join(' | '));
  assert.ok(!items.some((x) => x.includes('Ya hecho')), 'las tareas hechas no se proponen');
  assert.ok(items.includes('idea:Automatizar las altas:::'));
  assert.ok(items.includes('task:Falta presupuesto de licencias:::blockers'));
  assert.ok(items.some((x) => x.startsWith('event:Próxima reunión') && x.includes('2030-05-15')));
  const decisions = det.items.find((i) => i.type === 'doc');
  assert.match(decisions.title, /Decisiones · Comité Gamma/);
  assert.match(decisions.details, /- Usamos Databricks\n- Fase 1 en junio/);
  const again = await api(`/api/pages/${id}/minutes/detect`, {});
  assert.equal(again.added, 0, 'detectar dos veces no duplica');

  // Claude propone una lista nueva; no se crea nada todavía
  r = await call('propose_from_minutes', { minutes_id: id, proposals: [{ type: 'list', title: 'Riesgos Gamma', payload: { template: 'blockers' } }] });
  assert.match(r.text, /1 propuesta/);
  r = await call('read_page', { page_id: id });
  assert.match(r.text, /ACTA DE REUNIÓN/);
  assert.match(r.text, /Lista: Riesgos Gamma — ⏳ pendiente de aprobar/);
  const before = (await api('/api/trackers')).trackers.length;

  // aprobar: crea y enlaza con el acta
  const det2 = await api(`/api/pages/${id}/minutes`);
  const byTitle = (t) => det2.items.find((i) => i.title.startsWith(t));
  const ok1 = await api(`/api/pages/${id}/minutes/items/${byTitle('Pedir acceso').id}/approve`, {});
  assert.equal(ok1.status, 'created');
  const ticket = await api(`/api/pages/${ok1.result_id}/issue`);
  assert.match(ticket.key, /^TODO-\d+$/, 'la tarea va a la lista To-do adecuada');
  const fResp = ticket.tracker.config.fields.find((f) => f.name === 'Responsable');
  const fFecha = ticket.tracker.config.fields.find((f) => f.name === 'Fecha');
  assert.equal(ticket.values[fResp.id], 'luis');
  assert.equal(ticket.values[fFecha.id], '2030-05-20');
  assert.ok(ticket.links.some((l) => l.type === 'origin' && l.target_id === id), 'el ticket "viene de" el acta');
  const riesgo = await api(`/api/pages/${id}/minutes/items/${byTitle('Falta presupuesto').id}/approve`, {});
  assert.match((await api(`/api/pages/${riesgo.result_id}/issue`)).key, /^BLQ/, 'el riesgo va a la lista de bloqueos');
  const idea = await api(`/api/pages/${id}/minutes/items/${byTitle('Automatizar').id}/approve`, {});
  const ideaPage = await api(`/api/pages/${idea.result_id}`);
  assert.equal(ideaPage.kind, 'idea');
  assert.equal(JSON.parse(ideaPage.content).seeds[0].page_id, id);
  const doc = await api(`/api/pages/${id}/minutes/items/${byTitle('Decisiones').id}/approve`, { title: 'Decisiones del comité Gamma' });
  const docPage = await api(`/api/pages/${doc.result_id}`);
  assert.equal(docPage.title, 'Decisiones del comité Gamma', 'se puede ajustar al aprobar');
  assert.equal(docPage.parent_id, proyecto.id, 'la documentación va al proyecto del acta');
  const ev = await api(`/api/pages/${id}/minutes/items/${byTitle('Próxima reunión').id}/approve`, {});
  assert.equal((await api(`/api/pages/${ev.result_id}`)).page_date, '2030-05-15');
  const lst = await api(`/api/pages/${id}/minutes/items/${byTitle('Riesgos Gamma').id}/approve`, {});
  assert.equal((await api('/api/trackers')).trackers.length, before + 1);
  assert.ok((await api(`/api/pages/${lst.result_id}/tracker`)).links.some((l) => l.type === 'origin' && l.target_id === id));
  // descartar y recuperar
  const contrato = byTitle('Revisar contrato');
  await api(`/api/pages/${id}/minutes/items/${contrato.id}/reject`, {});
  assert.equal((await api(`/api/pages/${id}/minutes`)).items.find((i) => i.id === contrato.id).status, 'rejected');
  await api(`/api/pages/${id}/minutes/items/${contrato.id}/reopen`, {});
  // no se aprueba dos veces
  const twice = await fetch(`${BASE}/api/pages/${id}/minutes/items/${byTitle('Pedir acceso').id}/approve`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(twice.status, 400);

  // el acta ve lo creado; calendario con su tipo
  assert.ok((await api(`/api/pages/${id}/issues`)).linked.length >= 2, 'tickets y lista que vienen del acta');
  const cal = await api('/api/calendar?from=2030-05-01&to=2030-05-31');
  assert.ok(cal.dated.some((p) => p.id === id && p.kind === 'minutes'), 'el acta sale en el calendario como acta');
  assert.ok(cal.dated.some((p) => p.id === ev.result_id && p.kind === 'doc'), 'y el evento creado');
  assert.match((await call('read_page', { page_id: id })).text, /Tarea: Pedir acceso a Unity Catalog \(responsable luis, fecha 2030-05-20\) — ✅ creada → «Pedir acceso a Unity Catalog»/);
  assert.match((await call('move_page', { page_id: id, new_parent_id: proyecto.id })).text, /es un acta/);
});
