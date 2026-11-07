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
