// Construcción del grafo (como el Graph view de Obsidian) a partir de
// /api/graph: páginas, enlaces internos, etiquetas, adjuntos y jerarquía,
// con los mismos filtros, grupos y grafo local.

export const DEFAULTS = {
  // Filtros
  search: '',
  showTags: false,
  showAttachments: false,
  showOrphans: true,
  showHierarchy: true, // extra de NoNotion: enlaces padre → hija del árbol
  // Grupos: [{ query, color }]
  groups: [],
  // Visualización
  arrows: false,
  textFade: 0.6, // zoom a partir del que se ven los títulos
  nodeSize: 1,
  linkThickness: 1,
  // Fuerzas
  centerForce: 0.08,
  repelForce: 220,
  linkForce: 0.6,
  linkDistance: 70,
  // Grafo local
  depth: 1,
  incoming: true,
  outgoing: true,
  neighborLinks: true,
};

export const GROUP_COLORS = ['#2e6bff', '#2ecc8f', '#ff9b3d', '#ec4899', '#9b6bff', '#22c3e6', '#ffc53d', '#ff4d5e'];

const fold = (s) => (s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

// Consulta de búsqueda/grupo: texto del título, "tag:#x" o "#x" para etiquetas
export function matches(node, query) {
  const q = query.trim();
  if (!q) return true;
  return q
    .split(/\s+/)
    .every((term) => {
      const t = term.replace(/^tag:/i, '');
      if (t.startsWith('#')) {
        const tag = fold(t.slice(1));
        if (node.kind === 'tag') return fold(node.label).includes(tag);
        return (node.tags || []).some((x) => fold(x).includes(tag));
      }
      if (/^path:/i.test(term)) return fold(node.path || '').includes(fold(term.slice(5)));
      return fold(node.label).includes(fold(term)) || fold(node.path || '').includes(fold(term));
    });
}

export function buildGraph(data, settings, { focusId = null } = {}) {
  if (!data) return { nodes: [], links: [] };
  const s = { ...DEFAULTS, ...settings };
  const pageById = new Map(data.pages.map((p) => [p.id, p]));
  const pathOf = (p) => {
    const parts = [];
    for (let cur = p, i = 0; cur && i < 30; cur = cur.parent_id ? pageById.get(cur.parent_id) : null, i++) parts.unshift(cur.title || 'Sin título');
    return parts.join(' / ');
  };

  let nodes = data.pages.map((p) => ({
    id: p.id,
    kind: p.kind === 'canvas' ? 'canvas' : 'page',
    label: p.title || 'Sin título',
    icon: p.icon,
    tags: p.tags || [],
    created: p.created_at,
    path: pathOf(p),
  }));
  let links = data.links.map((l) => ({ source: l.source, target: l.target, type: 'link' }));
  if (s.showHierarchy) {
    for (const p of data.pages) {
      if (p.parent_id && pageById.has(p.parent_id)) links.push({ source: p.parent_id, target: p.id, type: 'tree' });
    }
  }
  if (s.showTags) {
    const tags = new Map();
    for (const p of data.pages) {
      for (const t of p.tags || []) {
        if (!tags.has(t)) tags.set(t, { id: `tag:${t}`, kind: 'tag', label: `#${t}`, tags: [t], created: p.created_at });
        links.push({ source: p.id, target: `tag:${t}`, type: 'tag' });
      }
    }
    nodes = nodes.concat([...tags.values()]);
  }
  if (s.showAttachments) {
    for (const f of data.files) {
      if (!pageById.has(f.page_id)) continue;
      nodes.push({ id: `file:${f.id}`, kind: 'file', label: f.name, file: f, tags: [], created: f.created_at });
      links.push({ source: f.page_id, target: `file:${f.id}`, type: 'file' });
    }
  }

  // Búsqueda: solo lo que coincide (y la página de foco del grafo local)
  if (s.search.trim()) {
    const keep = new Set(nodes.filter((n) => n.id === focusId || matches(n, s.search)).map((n) => n.id));
    nodes = nodes.filter((n) => keep.has(n.id));
    links = links.filter((l) => keep.has(l.source) && keep.has(l.target));
  }

  // Sin duplicados (dos enlaces iguales cuentan como uno)
  const seen = new Set();
  links = links.filter((l) => {
    const k = `${l.source}>${l.target}>${l.type}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });

  // Grafo local: vecinos hasta la profundidad elegida
  if (focusId) {
    const depthOf = new Map([[focusId, 0]]);
    let frontier = [focusId];
    for (let d = 1; d <= s.depth && frontier.length; d++) {
      const next = [];
      for (const id of frontier) {
        for (const l of links) {
          const directed = l.type === 'link';
          let other = null;
          if (l.source === id && (!directed || s.outgoing)) other = l.target;
          else if (l.target === id && (!directed || s.incoming)) other = l.source;
          if (other && !depthOf.has(other)) {
            depthOf.set(other, d);
            next.push(other);
          }
        }
      }
      frontier = next;
    }
    nodes = nodes.filter((n) => depthOf.has(n.id));
    links = links.filter((l) => {
      if (!depthOf.has(l.source) || !depthOf.has(l.target)) return false;
      if (s.neighborLinks) return true;
      // sin "enlaces entre vecinos": solo los que bajan un nivel
      return Math.abs(depthOf.get(l.source) - depthOf.get(l.target)) === 1;
    });
    for (const n of nodes) n.depth = depthOf.get(n.id);
  }

  const degree = new Map();
  for (const l of links) {
    degree.set(l.source, (degree.get(l.source) || 0) + 1);
    degree.set(l.target, (degree.get(l.target) || 0) + 1);
  }
  if (!s.showOrphans) nodes = nodes.filter((n) => n.id === focusId || degree.get(n.id));

  // Grupos de color: el primero que coincide manda
  for (const n of nodes) {
    n.degree = degree.get(n.id) || 0;
    // cuantas más páginas la enlazan, más grande (como en Obsidian)
    n.r = (n.kind === 'tag' || n.kind === 'file' ? 3.2 : 4.2) * s.nodeSize * (1 + Math.sqrt(n.degree) * 0.45);
    const g = s.groups.find((gr) => gr.query.trim() && matches(n, gr.query));
    n.color = g ? g.color : null;
  }
  return { nodes, links };
}
