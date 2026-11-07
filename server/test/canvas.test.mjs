import './setup.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';

const { normalizeCanvas, canvasText, canvasToMarkdown, linkedPageIds, parseCanvas, CanvasError } = await import('../canvas.js');
const { extractText } = await import('../db.js');

const sample = {
  nodes: [
    { id: 'g', type: 'group', label: 'Plataforma', x: 0, y: 0, width: 800, height: 400, color: '5' },
    { id: 't', type: 'text', text: '# Idea\nver [x](/p/PAGEaaaa1)', x: 20, y: 20, width: 250.6, height: 120 },
    { id: 'f', type: 'file', file: '/p/PAGEbbbb2', x: 400, y: 20, width: 300, height: 200 },
    { id: 'a', type: 'file', file: '/files/abcdefghijklmnopqrstu/plano.png', x: 900, y: 0, width: 200, height: 200 },
    { id: 'l', type: 'link', url: 'https://example.com', x: 900, y: 300, width: 300, height: 200, color: 'morado' },
  ],
  edges: [{ id: 'e', fromNode: 't', fromSide: 'right', toNode: 'f', toSide: 'left', toEnd: 'arrow', label: 'explica', color: '1' }],
};

test('normalizeCanvas: valida, redondea y limpia valores no válidos', () => {
  const c = normalizeCanvas(sample);
  assert.equal(c.nodes.length, 5);
  assert.equal(c.nodes[1].width, 251);
  assert.equal(c.nodes[4].color, undefined, 'color no válido fuera');
  assert.equal(c.edges[0].label, 'explica');
  assert.throws(() => normalizeCanvas({ nodes: [{ id: 'x', type: 'raro', x: 0, y: 0, width: 1, height: 1 }] }), CanvasError);
  assert.throws(() => normalizeCanvas({ nodes: [], edges: [{ id: 'e', fromNode: 'a', toNode: 'b' }] }), /fromNode\/toNode/);
  assert.throws(() => normalizeCanvas({ type: 'doc', content: [] }), /no es un canvas/);
  // ids duplicados se desambiguan
  const d = normalizeCanvas({ nodes: [{ id: 'x', type: 'text', text: '', x: 0, y: 0, width: 50, height: 50 }, { id: 'x', type: 'text', text: '', x: 0, y: 0, width: 50, height: 50 }] });
  assert.notEqual(d.nodes[0].id, d.nodes[1].id);
});

test('texto buscable y enlaces a páginas', () => {
  assert.match(canvasText(sample), /Idea/);
  assert.match(canvasText(sample), /Plataforma/);
  assert.match(canvasText(sample), /explica/);
  assert.equal(extractText(JSON.stringify(sample)), canvasText(sample), 'extractText reconoce los canvas');
  assert.deepEqual([...linkedPageIds(JSON.stringify(sample))].sort(), ['PAGEaaaa1', 'PAGEbbbb2']);
  assert.deepEqual([...linkedPageIds('{"type":"doc","content":[{"type":"text","text":"a","marks":[{"type":"link","attrs":{"href":"/p/DOCcccc3"}}]}]}')], ['DOCcccc3']);
  assert.equal(parseCanvas('{"type":"doc","content":[]}'), null);
});

test('resumen en Markdown para Claude', () => {
  const md = canvasToMarkdown(sample, (id) => (id === 'PAGEbbbb2' ? 'Arquitectura' : null));
  assert.match(md, /5 tarjeta\(s\) y 1 conexión/);
  assert.match(md, /página «Arquitectura»/);
  assert.match(md, /"Idea" ---> página «Arquitectura»: explica \[rojo\]/);
  assert.match(md, /\(en grupo «Plataforma»\)/);
});
