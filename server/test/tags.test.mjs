import './setup.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';

const { default: db, DEFAULT_WORKSPACE: WS } = await import('../db.js');
const { normalizeTag, setPageTags, tagsOf, lowercaseTags, listTags } = await import('../tags.js');

const mk = (id) => db.prepare('INSERT INTO pages (id, title, workspace_id) VALUES (?, ?, ?)').run(id, id, WS);
const addRaw = (name, color, created) =>
  db.prepare('INSERT INTO tags (workspace_id, name, color, created_at) VALUES (?, ?, ?, ?)').run(WS, name, color, created);
const linkRaw = (page, tag) => db.prepare('INSERT INTO page_tags (page_id, workspace_id, tag) VALUES (?, ?, ?)').run(page, WS, tag);

test('normalizeTag: minúsculas, sin #, espacios colapsados (también acentos y eñes)', () => {
  assert.equal(normalizeTag('#Pegasus'), 'pegasus');
  assert.equal(normalizeTag('  Cliente   AXA '), 'cliente axa');
  assert.equal(normalizeTag('ÑANDÚ'), 'ñandú');
  assert.equal(normalizeTag('   '), null);
});

test('al guardar y al quitar no importan las mayúsculas', () => {
  mk('pg1');
  assert.deepEqual(setPageTags('pg1', WS, ['Pegasus', 'pegasus', 'PEGASUS']), ['pegasus']);
  // quitar con otra capitalización
  assert.deepEqual(setPageTags('pg1', WS, []), []);
  setPageTags('pg1', WS, ['Pegasus']);
  const rm = new Set(['Pegasus'].map(normalizeTag));
  const next = tagsOf('pg1').filter((t) => !rm.has(normalizeTag(t)));
  assert.deepEqual(setPageTags('pg1', WS, next), []);
  // añadir "pegasus" quitando "Pegasus" en la misma operación deja "pegasus"
  setPageTags('pg1', WS, ['Pegasus']);
  assert.deepEqual(setPageTags('pg1', WS, ['pegasus']), ['pegasus']);
});

test('migración: renombra a minúsculas y fusiona colisiones conservando páginas y color', () => {
  mk('m1');
  mk('m2');
  mk('m3');
  // datos como los de antes: con mayúsculas (NOCASE no pliega Ñ/ñ ni acentos)
  addRaw('Riesgos', 'red', '2026-01-01 00:00:00');
  addRaw('Ñandú', 'blue', '2026-01-01 00:00:01');
  addRaw('ñandú', 'green', '2026-01-01 00:00:02');
  addRaw('ÑANDÚ', 'pink', '2026-01-01 00:00:03');
  linkRaw('m1', 'Riesgos');
  linkRaw('m1', 'Ñandú');
  linkRaw('m1', 'ñandú'); // colisión en la misma página
  linkRaw('m2', 'ñandú');
  linkRaw('m3', 'ÑANDÚ');
  const r = lowercaseTags();
  assert.equal(r.merged, 2);
  assert.deepEqual(tagsOf('m1'), ['ñandú', 'riesgos']);
  assert.deepEqual(tagsOf('m2'), ['ñandú']);
  assert.deepEqual(tagsOf('m3'), ['ñandú']);
  const tags = Object.fromEntries(listTags(WS).map((t) => [t.name, t]));
  assert.equal(tags['ñandú'].count, 3);
  assert.equal(tags['ñandú'].color, 'blue', 'color de la más antigua');
  assert.equal(tags['riesgos'].color, 'red');
  assert.equal(db.pragma('foreign_key_check').length, 0);
  // idempotente
  assert.deepEqual(lowercaseTags(), { renamed: 0, merged: 0 });
});
