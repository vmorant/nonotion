import './setup.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';

const { normalizeIdea, patchIdea, ideaText, ideaToMarkdown, ideaLinkedPageIds, parseIdea, ideaDigest, ideaTitleFrom, IdeaError } =
  await import('../idea.js');
const { extractText } = await import('../db.js');
const { parseCanvas } = await import('../canvas.js');

const sample = {
  type: 'idea',
  status: 'seed',
  summary: 'Unificar la ingesta en un solo pipeline',
  seeds: [
    { id: 's1', kind: 'text', text: 'Temas:\n- ingesta\n- costes\nver /p/PAGEaaaa1' },
    { id: 's2', kind: 'image', file_id: 'abcdefghijklmnopqrstu', name: 'captura.png', ocr: 'Texto de la pantalla' },
    { id: 's3', kind: 'page', page_id: 'PAGEbbbb2', text: 'fragmento' },
    { id: 's4', kind: 'link', url: 'https://example.com/doc' },
  ],
  steps: [{ id: 'p1', kind: 'decision', text: 'Usar Unity Catalog', by: 'claude', at: '2026-11-07 10:00:00' }],
  outcomes: [{ id: 'o1', type: 'page', page_id: 'PAGEcccc3', label: 'Documento de diseño' }],
};

test('normalizeIdea: valida tipos, ids y referencias', () => {
  const c = normalizeIdea(sample);
  assert.equal(c.type, 'idea');
  assert.equal(c.seeds.length, 4);
  assert.equal(c.steps[0].by, 'claude');
  assert.equal(c.steps[0].at, '2026-11-07 10:00:00', 'conserva la fecha dada');
  assert.ok(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(c.seeds[0].at), 'fecha generada si falta');
  assert.throws(() => normalizeIdea({ type: 'idea', seeds: [{ kind: 'raro' }] }), IdeaError);
  assert.throws(() => normalizeIdea({ type: 'idea', seeds: [{ kind: 'image' }] }), /file_id/);
  assert.throws(() => normalizeIdea({ type: 'idea', outcomes: [{ type: 'page' }] }), /page_id/);
  assert.throws(() => normalizeIdea({ type: 'idea', outcomes: [{ type: 'external' }] }), /url/);
  assert.throws(() => normalizeIdea({ type: 'doc', content: [] }), /no es una idea/);
  assert.throws(() => normalizeIdea({ nodes: [], edges: [] }), /no es una idea/);
  assert.equal(normalizeIdea(null).status, 'seed', 'vacío = idea nueva');
  const d = normalizeIdea({ type: 'idea', steps: [{ id: 'x', text: 'a' }, { id: 'x', text: 'b' }] });
  assert.notEqual(d.steps[0].id, d.steps[1].id, 'ids duplicados se desambiguan');
  assert.equal(d.steps[0].kind, 'note', 'tipo de paso por defecto');
  // una idea no es un canvas ni un documento
  assert.equal(parseCanvas(JSON.stringify(sample)), null);
  assert.equal(parseIdea('{"type":"doc","content":[]}'), null);
});

test('patchIdea: altas, bajas, ediciones y transiciones de estado', () => {
  let c = patchIdea(JSON.stringify({ type: 'idea', seeds: [{ kind: 'text', text: 'hola' }] }), {
    steps_add: [{ kind: 'question', text: '¿Para quién?' }],
  });
  assert.equal(c.status, 'developing', 'el primer paso pone la idea en desarrollo');
  assert.equal(c.steps.length, 1);
  c = patchIdea(c, { steps_update: [{ id: c.steps[0].id, text: '¿Para quién es?', kind: 'hypothesis' }] });
  assert.equal(c.steps[0].text, '¿Para quién es?');
  assert.equal(c.steps[0].kind, 'hypothesis');
  c = patchIdea(c, { outcomes_add: [{ type: 'canvas', page_id: 'PAGEdddd4', label: 'Mapa' }] });
  assert.equal(c.status, 'documented', 'un resultado la da por documentada');
  c = patchIdea(c, { remove: { outcomes: [c.outcomes[0].id] }, status: 'archived', summary: 'Aparcada' });
  assert.equal(c.outcomes.length, 0);
  assert.equal(c.status, 'archived');
  assert.equal(c.summary, 'Aparcada');
  assert.throws(() => patchIdea(c, { status: 'listo' }), /Estado "listo"/);
  assert.throws(() => patchIdea(c, { steps_update: [{ id: 'nope', text: 'x' }] }), /no existe/);
  assert.throws(() => patchIdea(c, { seeds_add: [{ kind: 'text', text: '   ' }] }), /vacío/);
});

test('texto buscable (incluido el OCR) y enlaces a páginas', () => {
  const t = ideaText(sample);
  assert.match(t, /Unificar la ingesta/);
  assert.match(t, /Texto de la pantalla/, 'el OCR de la captura entra en la búsqueda');
  assert.match(t, /Usar Unity Catalog/);
  assert.match(t, /Documento de diseño/);
  assert.equal(extractText(JSON.stringify(sample)), t, 'extractText reconoce las ideas');
  assert.deepEqual([...ideaLinkedPageIds(JSON.stringify(sample))].sort(), ['PAGEaaaa1', 'PAGEbbbb2', 'PAGEcccc3']);
});

test('resumen en Markdown para Claude y resumen corto para listados', () => {
  const md = ideaToMarkdown(sample, {
    titleOf: (id) => ({ PAGEbbbb2: 'Origen', PAGEcccc3: 'Diseño' })[id] || null,
    fileOf: (id) => (id === 'abcdefghijklmnopqrstu' ? { id, name: 'captura.png' } : null),
  });
  assert.match(md, /estado: Semilla/);
  assert.match(md, /## Resumen\n\nUnificar la ingesta/);
  assert.match(md, /captura captura\.png \(file_id: abcdefghijklmnopqrstu\) · texto reconocido \(OCR\):\n {4}Texto de la pantalla/);
  assert.match(md, /fragmento de la página «Origen» \(\/p\/PAGEbbbb2\):\n {4}fragmento/);
  assert.match(md, /Decisión \(Claude\):\n {4}Usar Unity Catalog/);
  assert.match(md, /Página «Documento de diseño»: página «Diseño» \(\/p\/PAGEcccc3\)/);
  const d = ideaDigest(sample);
  assert.equal(d.seeds, 4);
  assert.equal(d.has_image, true);
  assert.equal(d.preview, 'Unificar la ingesta en un solo pipeline');
  assert.deepEqual(d.outcomes.map((o) => o.type), ['page']);
  assert.equal(ideaTitleFrom('# Mi *idea* genial\nmás'), 'Mi idea genial');
  assert.equal(ideaTitleFrom('', 'Idea'), 'Idea');
});
