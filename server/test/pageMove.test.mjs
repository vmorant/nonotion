import './setup.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

const { default: db, DEFAULT_WORKSPACE: WS } = await import('../db.js');
const { movePages, pathOf, MoveError } = await import('../pageMove.js');
const { setPageTags, tagsOf } = await import('../tags.js');

const OTHER = 'ws_otro';
db.prepare(`INSERT OR IGNORE INTO workspaces (id, name) VALUES (?, 'Otro')`).run(OTHER);

let n = 0;
function mk(title, parent = null, ws = WS) {
  const id = 'p' + crypto.randomBytes(5).toString('hex');
  db.prepare('INSERT INTO pages (id, parent_id, title, position, workspace_id, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(
    id,
    parent,
    title,
    n,
    ws,
    `2026-01-01 00:00:${String(n++ % 60).padStart(2, '0')}`
  );
  return id;
}
const parentOf = (id) => db.prepare('SELECT parent_id FROM pages WHERE id = ?').get(id).parent_id;
const kids = (parent, ws = WS) =>
  db
    .prepare('SELECT title FROM pages WHERE parent_id IS ? AND workspace_id = ? AND trashed_at IS NULL ORDER BY position, created_at')
    .all(parent, ws)
    .map((r) => r.title);
const positions = (parent) =>
  db.prepare('SELECT position FROM pages WHERE parent_id IS ? AND workspace_id = ? AND trashed_at IS NULL ORDER BY position').all(parent, WS).map((r) => r.position);
const snapshot = () => JSON.stringify(db.prepare('SELECT id, parent_id, position FROM pages ORDER BY id').all());
const rejects = (fn, re) => assert.throws(fn, (e) => e instanceof MoveError && re.test(e.message));

test('mover una hoja: cambia de padre, va al final y se renumeran origen y destino', () => {
  const inbox = mk('Inbox');
  const a = mk('A', inbox);
  const fails = mk('Fails', inbox);
  const c = mk('C', inbox);
  const onyx = mk('ONYX');
  const mvp = mk('MVP', onyx);
  mk('Otra', mvp);
  const [r] = movePages(WS, [{ page_id: fails, parent_id: mvp }]);
  assert.equal(parentOf(fails), mvp);
  assert.deepEqual(kids(mvp), ['Otra', 'Fails']);
  assert.deepEqual(kids(inbox), ['A', 'C']);
  assert.deepEqual(positions(inbox), [0, 1]);
  assert.deepEqual(positions(mvp), [0, 1]);
  assert.equal(r.from, 'Inbox / Fails');
  assert.equal(r.to, 'ONYX / MVP / Fails');
  assert.equal(r.subpages, 0);
  assert.equal(r.noop, false);
  assert.ok(a && c);
});

test('mover con subárbol: los hijos conservan estructura, ids, etiquetas y versiones', () => {
  const src = mk('Proyecto');
  const dst = mk('Archivo');
  const child = mk('Hijo', src);
  const grand = mk('Nieto', child);
  setPageTags(child, WS, ['Riesgos']);
  db.prepare(`INSERT INTO versions (page_id, title, content) VALUES (?, 'Hijo', 'v1')`).run(child);
  const [r] = movePages(WS, [{ page_id: src, parent_id: dst }]);
  assert.equal(r.subpages, 2);
  assert.equal(parentOf(src), dst);
  assert.equal(parentOf(child), src);
  assert.equal(parentOf(grand), child);
  assert.equal(pathOf(grand), 'Archivo / Proyecto / Hijo / Nieto');
  assert.deepEqual(tagsOf(child), ['riesgos']);
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM versions WHERE page_id = ?').get(child).c, 1);
});

test('mover a la raíz del espacio (new_parent_id null)', () => {
  const p = mk('Padre');
  const h = mk('Suelta', p);
  const [r] = movePages(WS, [{ page_id: h, parent_id: null }]);
  assert.equal(parentOf(h), null);
  assert.equal(r.to, 'Suelta');
  assert.equal(kids(null).at(-1), 'Suelta');
});

test('reordenar entre hermanas: index, before_id y after_id', () => {
  const p = mk('Lista');
  const [a, b, c, d] = ['a', 'b', 'c', 'd'].map((t) => mk(t, p));
  movePages(WS, [{ page_id: d, parent_id: p, index: 0 }]);
  assert.deepEqual(kids(p), ['d', 'a', 'b', 'c']);
  movePages(WS, [{ page_id: a, parent_id: p, before_id: d }]);
  assert.deepEqual(kids(p), ['a', 'd', 'b', 'c']);
  movePages(WS, [{ page_id: a, parent_id: p, after_id: c }]);
  assert.deepEqual(kids(p), ['d', 'b', 'c', 'a']);
  assert.deepEqual(positions(p), [0, 1, 2, 3]);
  rejects(() => movePages(WS, [{ page_id: a, parent_id: p, before_id: 'noexiste' }]), /no es una página hermana/);
  rejects(() => movePages(WS, [{ page_id: a, parent_id: p, index: 0, after_id: b }]), /solo una posición/);
});

test('sin cambios: mismo padre y sin posición es no-op', () => {
  const p = mk('Quieta');
  const h = mk('Hija', p);
  const before = snapshot();
  const [r] = movePages(WS, [{ page_id: h, parent_id: p }]);
  assert.equal(r.noop, true);
  assert.equal(snapshot(), before);
});

test('rechaza ciclos: dentro de sí misma o de una descendiente', () => {
  const p = mk('Raíz ciclo');
  const h = mk('Hija ciclo', p);
  const n2 = mk('Nieta ciclo', h);
  const before = snapshot();
  rejects(() => movePages(WS, [{ page_id: p, parent_id: p }]), /dentro de sí misma/);
  rejects(() => movePages(WS, [{ page_id: p, parent_id: n2 }]), /ciclo/);
  assert.equal(snapshot(), before);
});

test('rechaza destino u origen en la papelera, inexistentes o de otro espacio', () => {
  const p = mk('Viva');
  const papelera = mk('En papelera');
  db.prepare(`UPDATE pages SET trashed_at = datetime('now') WHERE id = ?`).run(papelera);
  const ajena = mk('Ajena', null, OTHER);
  const before = snapshot();
  rejects(() => movePages(WS, [{ page_id: p, parent_id: papelera }]), /destino «En papelera» está en la papelera/);
  rejects(() => movePages(WS, [{ page_id: papelera, parent_id: null }]), /está en la papelera/);
  rejects(() => movePages(WS, [{ page_id: 'noexiste', parent_id: null }]), /no existe en este espacio/);
  rejects(() => movePages(WS, [{ page_id: p, parent_id: 'noexiste' }]), /destino .* no existe en este espacio/);
  rejects(() => movePages(WS, [{ page_id: p, parent_id: ajena }]), /no se puede mover entre espacios/);
  rejects(() => movePages(WS, [{ page_id: ajena, parent_id: null }]), /no existe en este espacio/);
  rejects(() => movePages(WS, [{ page_id: p }]), /Falta el padre destino/);
  assert.equal(snapshot(), before);
});

test('move_pages en lote: atómico, uno inválido deshace todos', () => {
  const dst = mk('Destino lote');
  const x = mk('X');
  const y = mk('Y');
  const papelera = mk('Papelera lote');
  db.prepare(`UPDATE pages SET trashed_at = datetime('now') WHERE id = ?`).run(papelera);
  const before = snapshot();
  assert.throws(
    () =>
      movePages(WS, [
        { page_id: x, parent_id: dst },
        { page_id: y, parent_id: dst },
        { page_id: y, parent_id: papelera },
      ]),
    (e) => e instanceof MoveError && /Movimiento 3 de 3/.test(e.message) && /No se ha aplicado ninguno/.test(e.message)
  );
  assert.equal(snapshot(), before, 'rollback: nada cambió');
  const res = movePages(WS, [
    { page_id: x, parent_id: dst },
    { page_id: y, parent_id: dst, before_id: x },
  ]);
  assert.equal(res.length, 2);
  assert.deepEqual(kids(dst), ['Y', 'X']);
});

test('en lote, cada movimiento ve el resultado del anterior (detecta ciclos creados en el lote)', () => {
  const a = mk('LA');
  const b = mk('LB');
  const before = snapshot();
  assert.throws(() => movePages(WS, [{ page_id: b, parent_id: a }, { page_id: a, parent_id: b }]), /ciclo/);
  assert.equal(snapshot(), before);
});
