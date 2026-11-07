// Canvas (como el de Obsidian) en formato abierto JSON Canvas 1.0:
// { nodes: [...], edges: [...] }. Un canvas es una página con kind = 'canvas'
// y este JSON como contenido.
//
// Nodos: text (markdown), file (una página de NoNotion "/p/<id>" o un adjunto
// "/files/<id>/<nombre>"), link (url) y group (label). Aristas entre lados de
// nodos (top/right/bottom/left), con extremos none/arrow, color y etiqueta.
// Colores: "1".."6" (rojo, naranja, amarillo, verde, cian, morado) o "#rrggbb".

export const EMPTY_CANVAS = { nodes: [], edges: [] };
const NODE_TYPES = new Set(['text', 'file', 'link', 'group']);
const SIDES = new Set(['top', 'right', 'bottom', 'left']);
const ENDS = new Set(['none', 'arrow']);
const BG_STYLES = new Set(['cover', 'ratio', 'repeat']);
const MAX_NODES = 5000;
const MAX_TEXT = 100000;

export class CanvasError extends Error {}

const isColor = (c) => typeof c === 'string' && (/^[1-6]$/.test(c) || /^#[0-9a-fA-F]{6}$/.test(c));
const num = (v, def = 0) => (Number.isFinite(Number(v)) ? Math.round(Number(v)) : def);
const str = (v, max = 2000) => (typeof v === 'string' ? v.slice(0, max) : undefined);

// ¿Es un canvas este contenido (objeto o JSON)?
export function parseCanvas(content) {
  let c = content;
  if (typeof c === 'string') {
    if (!c.trim().startsWith('{')) return null;
    try {
      c = JSON.parse(c);
    } catch {
      return null;
    }
  }
  if (!c || typeof c !== 'object' || c.type === 'doc') return null;
  if (!Array.isArray(c.nodes) && !Array.isArray(c.edges)) return null;
  return c;
}

// Valida y limpia un canvas: tipos, números, ids únicos y aristas que apunten
// a nodos existentes. Conserva campos desconocidos de los nodos (extensiones).
export function normalizeCanvas(input) {
  const c = parseCanvas(input);
  if (!c) throw new CanvasError('El contenido no es un canvas válido (se espera JSON Canvas: { nodes, edges })');
  const rawNodes = Array.isArray(c.nodes) ? c.nodes : [];
  if (rawNodes.length > MAX_NODES) throw new CanvasError(`Demasiados nodos (máx. ${MAX_NODES})`);
  const ids = new Set();
  const nodes = [];
  rawNodes.forEach((n, i) => {
    if (!n || typeof n !== 'object') throw new CanvasError(`Nodo ${i + 1}: no es un objeto`);
    if (!NODE_TYPES.has(n.type)) throw new CanvasError(`Nodo ${i + 1}: tipo "${n.type}" no válido (text, file, link o group)`);
    let id = str(n.id, 64) || `n${i}-${Math.random().toString(36).slice(2, 8)}`;
    while (ids.has(id)) id = `${id}-${Math.random().toString(36).slice(2, 5)}`;
    ids.add(id);
    const out = {
      ...n,
      id,
      type: n.type,
      x: num(n.x),
      y: num(n.y),
      width: Math.max(20, num(n.width, 260)),
      height: Math.max(20, num(n.height, 140)),
    };
    if (n.color !== undefined && !isColor(n.color)) delete out.color;
    if (n.type === 'text') out.text = str(n.text, MAX_TEXT) ?? '';
    if (n.type === 'file') {
      out.file = str(n.file, 1000);
      if (!out.file) throw new CanvasError(`Nodo ${i + 1}: falta "file"`);
      if (n.subpath !== undefined) out.subpath = str(n.subpath, 300);
    }
    if (n.type === 'link') {
      out.url = str(n.url, 2000);
      if (!out.url) throw new CanvasError(`Nodo ${i + 1}: falta "url"`);
    }
    if (n.type === 'group') {
      if (n.label !== undefined) out.label = str(n.label, 300);
      if (n.background !== undefined) out.background = str(n.background, 1000);
      if (n.backgroundStyle !== undefined && !BG_STYLES.has(n.backgroundStyle)) delete out.backgroundStyle;
    }
    nodes.push(out);
  });
  const edges = [];
  const edgeIds = new Set();
  (Array.isArray(c.edges) ? c.edges : []).forEach((e, i) => {
    if (!e || typeof e !== 'object') return;
    if (!ids.has(e.fromNode) || !ids.has(e.toNode)) {
      throw new CanvasError(`Conexión ${i + 1}: fromNode/toNode deben ser ids de nodos del canvas`);
    }
    let id = str(e.id, 64) || `e${i}-${Math.random().toString(36).slice(2, 8)}`;
    while (edgeIds.has(id)) id = `${id}-${Math.random().toString(36).slice(2, 5)}`;
    edgeIds.add(id);
    const out = { ...e, id, fromNode: e.fromNode, toNode: e.toNode };
    for (const k of ['fromSide', 'toSide']) if (e[k] !== undefined && !SIDES.has(e[k])) delete out[k];
    for (const k of ['fromEnd', 'toEnd']) if (e[k] !== undefined && !ENDS.has(e[k])) delete out[k];
    if (e.color !== undefined && !isColor(e.color)) delete out.color;
    if (e.label !== undefined) out.label = str(e.label, 500);
    edges.push(out);
  });
  return { nodes, edges };
}

// Texto buscable: tarjetas de texto, etiquetas de grupos y de conexiones, urls
export function canvasText(content) {
  const c = parseCanvas(content);
  if (!c) return '';
  const parts = [];
  for (const n of c.nodes || []) {
    if (n.type === 'text' && n.text) parts.push(n.text);
    if (n.type === 'group' && n.label) parts.push(n.label);
    if (n.type === 'link' && n.url) parts.push(n.url);
  }
  for (const e of c.edges || []) if (e.label) parts.push(e.label);
  return parts.join('\n');
}

export const pageIdOfFile = (file) => (typeof file === 'string' ? file.match(/^\/p\/([A-Za-z0-9_-]+)/)?.[1] || null : null);
export const fileIdOfFile = (file) =>
  typeof file === 'string' ? file.match(/^\/files\/([A-Za-z0-9_-]{21})(?:\/|$)/)?.[1] || null : null;

const PRESET = { 1: 'rojo', 2: 'naranja', 3: 'amarillo', 4: 'verde', 5: 'cian', 6: 'morado' };

// Resumen en Markdown para Claude (read_page) y como texto legible
export function canvasToMarkdown(content, titleOf = () => null) {
  const c = parseCanvas(content) || EMPTY_CANVAS;
  const nodes = c.nodes || [];
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const name = (n) => {
    if (!n) return '?';
    if (n.type === 'text') return `"${(n.text || '').split('\n')[0].replace(/^#+\s*/, '').slice(0, 60) || 'tarjeta'}"`;
    if (n.type === 'file') {
      const pid = pageIdOfFile(n.file);
      if (pid) return `página «${titleOf(pid) || pid}»`;
      return `archivo ${decodeURIComponent((n.file || '').split('/').pop() || '')}`;
    }
    if (n.type === 'link') return `web ${n.url}`;
    return `grupo «${n.label || 'sin nombre'}»`;
  };
  const color = (x) => (x.color ? ` [${PRESET[x.color] || x.color}]` : '');
  const groups = nodes.filter((n) => n.type === 'group');
  const inGroup = (n) =>
    groups.find((g) => g !== n && n.x >= g.x && n.y >= g.y && n.x + n.width <= g.x + g.width && n.y + n.height <= g.y + g.height);
  const lines = [`Canvas con ${nodes.length} tarjeta(s) y ${(c.edges || []).length} conexión(es).`, ''];
  if (nodes.length) lines.push('## Tarjetas', '');
  for (const n of nodes) {
    const g = n.type !== 'group' && inGroup(n);
    const where = g ? ` (en ${name(g)})` : '';
    const head = `- [${n.id}] ${n.type}${color(n)} @ ${n.x},${n.y} ${n.width}×${n.height}${where}`;
    if (n.type === 'text') {
      lines.push(head + ':');
      lines.push(...(n.text || '').split('\n').map((l) => '    ' + l));
    } else lines.push(`${head}: ${name(n)}${n.type === 'file' && pageIdOfFile(n.file) ? ` (${n.file})` : ''}`);
  }
  if ((c.edges || []).length) {
    lines.push('', '## Conexiones', '');
    for (const e of c.edges) {
      const arrow = (e.fromEnd === 'arrow' ? '<' : '-') + '--' + ((e.toEnd || 'arrow') === 'arrow' ? '>' : '-');
      lines.push(`- ${name(byId.get(e.fromNode))} ${arrow} ${name(byId.get(e.toNode))}${e.label ? `: ${e.label}` : ''}${color(e)}`);
    }
  }
  return lines.join('\n');
}

// Ids de páginas enlazadas desde un contenido (documento, markdown o canvas):
// enlaces internos /p/<id>. Para el grafo y los backlinks.
export function linkedPageIds(content) {
  const out = new Set();
  if (!content) return out;
  const scan = (s) => {
    for (const m of String(s).matchAll(/\/p\/([A-Za-z0-9_-]{6,})/g)) out.add(m[1]);
  };
  const canvas = parseCanvas(content);
  if (canvas) {
    for (const n of canvas.nodes || []) {
      if (n.type === 'file') {
        const pid = pageIdOfFile(n.file);
        if (pid) out.add(pid);
      }
      if (n.type === 'text') scan(n.text || '');
    }
    return out;
  }
  // documento Tiptap (JSON) o markdown crudo: basta con buscar las rutas internas
  scan(typeof content === 'string' ? content : JSON.stringify(content));
  return out;
}
