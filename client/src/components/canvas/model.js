// Lógica pura del canvas (formato JSON Canvas 1.0): geometría, colores,
// conexiones, alineado/distribución y grupos. Sin React.

export const GRID = 20;
export const SIDES = ['top', 'right', 'bottom', 'left'];
export const PRESET_COLORS = {
  1: '#ff4d5e', // rojo
  2: '#ff9b3d', // naranja
  3: '#ffc53d', // amarillo
  4: '#2ecc8f', // verde
  5: '#22c3e6', // cian
  6: '#9b6bff', // morado
};
export const COLOR_NAMES = { 1: 'Rojo', 2: 'Naranja', 3: 'Amarillo', 4: 'Verde', 5: 'Cian', 6: 'Morado' };

export const colorValue = (c) => (c ? PRESET_COLORS[c] || c : null);
export const newId = () => Math.random().toString(16).slice(2, 10) + Math.random().toString(16).slice(2, 10);
export const snap = (v, on = true) => (on ? Math.round(v / GRID) * GRID : Math.round(v));

export function normalize(raw) {
  let c = raw;
  if (typeof c === 'string') {
    try {
      c = JSON.parse(c);
    } catch {
      c = null;
    }
  }
  if (!c || typeof c !== 'object' || c.type === 'doc') c = {};
  return { nodes: Array.isArray(c.nodes) ? c.nodes : [], edges: Array.isArray(c.edges) ? c.edges : [] };
}

export const rectOf = (n) => ({ x: n.x, y: n.y, w: n.width, h: n.height });

export function bounds(nodes) {
  if (!nodes.length) return null;
  let x1 = Infinity;
  let y1 = Infinity;
  let x2 = -Infinity;
  let y2 = -Infinity;
  for (const n of nodes) {
    x1 = Math.min(x1, n.x);
    y1 = Math.min(y1, n.y);
    x2 = Math.max(x2, n.x + n.width);
    y2 = Math.max(y2, n.y + n.height);
  }
  return { x: x1, y: y1, w: x2 - x1, h: y2 - y1 };
}

export const intersects = (a, b) => a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
export const contains = (outer, inner) =>
  inner.x >= outer.x && inner.y >= outer.y && inner.x + inner.w <= outer.x + outer.w && inner.y + inner.h <= outer.y + outer.h;

// Nodos dentro de un grupo (se mueven con él)
export function nodesInGroup(nodes, group) {
  const g = rectOf(group);
  return nodes.filter((n) => n.id !== group.id && contains(g, rectOf(n)));
}

// Punto de anclaje en el centro de un lado
export function anchor(n, side) {
  switch (side) {
    case 'top':
      return { x: n.x + n.width / 2, y: n.y };
    case 'bottom':
      return { x: n.x + n.width / 2, y: n.y + n.height };
    case 'left':
      return { x: n.x, y: n.y + n.height / 2 };
    default:
      return { x: n.x + n.width, y: n.y + n.height / 2 };
  }
}

const NORMAL = { top: [0, -1], bottom: [0, 1], left: [-1, 0], right: [1, 0] };

// Lado de un nodo más cercano a un punto
export function nearestSide(n, p) {
  let best = 'right';
  let bd = Infinity;
  for (const s of SIDES) {
    const a = anchor(n, s);
    const d = (a.x - p.x) ** 2 + (a.y - p.y) ** 2;
    if (d < bd) {
      bd = d;
      best = s;
    }
  }
  return best;
}

// Si una conexión no trae lados, se eligen los que se miran
export function autoSides(a, b) {
  const ca = { x: a.x + a.width / 2, y: a.y + a.height / 2 };
  const cb = { x: b.x + b.width / 2, y: b.y + b.height / 2 };
  const dx = cb.x - ca.x;
  const dy = cb.y - ca.y;
  if (Math.abs(dx) > Math.abs(dy)) return dx > 0 ? ['right', 'left'] : ['left', 'right'];
  return dy > 0 ? ['bottom', 'top'] : ['top', 'bottom'];
}

// Curva de Bézier entre dos anclajes (como en Obsidian)
export function edgeGeometry(from, fromSide, to, toSide) {
  const dist = Math.hypot(to.x - from.x, to.y - from.y);
  const off = Math.max(40, Math.min(220, dist * 0.45));
  const [fx, fy] = NORMAL[fromSide] || [1, 0];
  const [tx, ty] = toSide ? NORMAL[toSide] : [0, 0];
  const c1 = { x: from.x + fx * off, y: from.y + fy * off };
  const c2 = toSide ? { x: to.x + tx * off, y: to.y + ty * off } : { x: to.x, y: to.y };
  const d = `M ${from.x} ${from.y} C ${c1.x} ${c1.y}, ${c2.x} ${c2.y}, ${to.x} ${to.y}`;
  // punto medio (t = 0.5) para la etiqueta
  const mid = {
    x: 0.125 * from.x + 0.375 * c1.x + 0.375 * c2.x + 0.125 * to.x,
    y: 0.125 * from.y + 0.375 * c1.y + 0.375 * c2.y + 0.125 * to.y,
  };
  return { d, mid, c1, c2 };
}

export function edgeEnds(edge, byId) {
  const a = byId.get(edge.fromNode);
  const b = byId.get(edge.toNode);
  if (!a || !b) return null;
  const [sa, sb] = autoSides(a, b);
  const fromSide = edge.fromSide || sa;
  const toSide = edge.toSide || sb;
  return { from: anchor(a, fromSide), fromSide, to: anchor(b, toSide), toSide };
}

// ---------- Alinear, organizar, distribuir (como Obsidian) ----------

export function align(nodes, mode) {
  const b = bounds(nodes);
  if (!b) return nodes;
  return nodes.map((n) => {
    switch (mode) {
      case 'left':
        return { ...n, x: b.x };
      case 'center':
        return { ...n, x: Math.round(b.x + b.w / 2 - n.width / 2) };
      case 'right':
        return { ...n, x: b.x + b.w - n.width };
      case 'top':
        return { ...n, y: b.y };
      case 'middle':
        return { ...n, y: Math.round(b.y + b.h / 2 - n.height / 2) };
      case 'bottom':
        return { ...n, y: b.y + b.h - n.height };
      default:
        return n;
    }
  });
}

export function arrange(nodes, mode, gap = 40) {
  const b = bounds(nodes);
  if (!b) return nodes;
  if (mode === 'row') {
    let x = b.x;
    return [...nodes].sort((p, q) => p.x - q.x).map((n) => {
      const out = { ...n, x, y: b.y };
      x += n.width + gap;
      return out;
    });
  }
  if (mode === 'column') {
    let y = b.y;
    return [...nodes].sort((p, q) => p.y - q.y).map((n) => {
      const out = { ...n, x: b.x, y };
      y += n.height + gap;
      return out;
    });
  }
  // cuadrícula: tantas columnas como la raíz del número de tarjetas
  const cols = Math.ceil(Math.sqrt(nodes.length));
  const cw = Math.max(...nodes.map((n) => n.width));
  const ch = Math.max(...nodes.map((n) => n.height));
  return [...nodes]
    .sort((p, q) => p.y - q.y || p.x - q.x)
    .map((n, i) => ({ ...n, x: b.x + (i % cols) * (cw + gap), y: b.y + Math.floor(i / cols) * (ch + gap) }));
}

export function distribute(nodes, axis) {
  if (nodes.length < 3) return nodes;
  const key = axis === 'h' ? 'x' : 'y';
  const size = axis === 'h' ? 'width' : 'height';
  const sorted = [...nodes].sort((a, b) => a[key] - b[key]);
  const first = sorted[0];
  const last = sorted[sorted.length - 1];
  const total = sorted.reduce((s, n) => s + n[size], 0);
  const space = (last[key] + last[size] - first[key] - total) / (sorted.length - 1);
  let pos = first[key];
  return sorted.map((n) => {
    const out = { ...n, [key]: Math.round(pos) };
    pos += n[size] + space;
    return out;
  });
}

// Encaja el rectángulo r en una vista de w×h px
export function fitView(r, w, h, pad = 60, maxK = 1) {
  if (!r) return { x: w / 2, y: h / 2, k: 1 };
  const k = Math.max(0.1, Math.min(maxK, (w - pad * 2) / Math.max(r.w, 1), (h - pad * 2) / Math.max(r.h, 1)));
  return { k, x: w / 2 - (r.x + r.w / 2) * k, y: h / 2 - (r.y + r.h / 2) * k };
}

// Texto de los nodos para un título al convertir una tarjeta en página
export function titleFromText(text) {
  const line = (text || '').split('\n').find((l) => l.trim()) || 'Tarjeta';
  return line.replace(/^#+\s*/, '').replace(/[*_`>]/g, '').trim().slice(0, 80) || 'Tarjeta';
}
