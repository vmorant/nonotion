import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  StickyNote,
  FileText,
  Paperclip,
  Globe,
  BoxSelect,
  ZoomIn,
  ZoomOut,
  Maximize,
  Scan,
  Undo2,
  Redo2,
  Settings2,
  Trash2,
  AlignLeft,
  FileOutput,
  Download,
  Group,
  Tag,
  ArrowRight,
  ArrowLeftRight,
  Minus,
  Ungroup,
  Lock,
} from 'lucide-react';
import { api } from '../../api.js';
import CanvasCard, { invalidatePagePreview } from './CanvasCard.jsx';
import {
  GRID,
  SIDES,
  PRESET_COLORS,
  COLOR_NAMES,
  colorValue,
  newId,
  snap,
  normalize,
  rectOf,
  bounds,
  intersects,
  nodesInGroup,
  anchor,
  nearestSide,
  edgeGeometry,
  edgeEnds,
  align,
  arrange,
  distribute,
  fitView,
  titleFromText,
} from './model.js';

// Canvas como el de Obsidian (JSON Canvas 1.0). Mismas interacciones:
// doble clic crea una tarjeta, arrastrar desde el borde de una tarjeta la
// conecta, Espacio+arrastrar o rueda desplazan, Ctrl+rueda (o pellizcar)
// hace zoom, Shift añade a la selección, Alt+arrastrar duplica, Espacio al
// mover desactiva el ajuste a la cuadrícula.

const MIN_W = 60;
const MIN_H = 40;
const MAX_HISTORY = 100;
const settingsKey = (id) => `nn:canvas:${id}`;

function readSettings(id) {
  try {
    return { snap: true, readOnly: false, ...JSON.parse(localStorage.getItem(settingsKey(id)) || '{}') };
  } catch {
    return { snap: true, readOnly: false };
  }
}

const ICON = { size: 16, strokeWidth: 1.8 };

export default function CanvasView({
  pageId,
  parentId,
  initialContent,
  pages = [],
  readOnly: forcedReadOnly = false,
  onChange,
  onFocusChange,
}) {
  const navigate = useNavigate();
  const [doc, setDoc] = useState(() => normalize(initialContent));
  const [view, setView] = useState(null); // { x, y, k }; null hasta medir el contenedor
  const [sel, setSel] = useState({ nodes: new Set(), edges: new Set() });
  const [editing, setEditing] = useState(null); // id de tarjeta de texto en edición
  const [labelEdit, setLabelEdit] = useState(null); // { kind: 'edge'|'group', id, value }
  const [temp, setTemp] = useState(null); // línea de conexión en curso
  const [marquee, setMarquee] = useState(null);
  const [settings, setSettings] = useState(() => readSettings(pageId));
  const [panel, setPanel] = useState(null); // 'settings' | 'align' | 'groups' | 'page' | null
  const [pickQ, setPickQ] = useState('');
  const [spacePan, setSpacePan] = useState(false);
  const wrapRef = useRef(null);
  const fileRef = useRef(null);
  const docRef = useRef(doc);
  docRef.current = doc;
  const viewRef = useRef(view);
  viewRef.current = view;
  const selRef = useRef(sel);
  selRef.current = sel;
  const op = useRef(null);
  const typing = useRef(false); // una sola entrada de deshacer por sesión de edición de texto
  const undoStack = useRef([]);
  const redoStack = useRef([]);
  const spaceDown = useRef(false);
  const readOnly = forcedReadOnly || settings.readOnly;

  const byId = useMemo(() => new Map(doc.nodes.map((n) => [n.id, n])), [doc]);

  useEffect(() => {
    try {
      localStorage.setItem(settingsKey(pageId), JSON.stringify(settings));
    } catch {}
  }, [pageId, settings]);

  // Vista inicial: la guardada en este navegador o encuadrar todo
  useLayoutEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    let v = null;
    try {
      v = JSON.parse(localStorage.getItem(`nn:canvas-view:${pageId}`) || 'null');
    } catch {}
    setView(v && Number.isFinite(v.k) ? v : fitView(bounds(doc.nodes), r.width, r.height));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pageId]);

  useEffect(() => {
    if (!view) return undefined;
    const t = setTimeout(() => {
      try {
        localStorage.setItem(`nn:canvas-view:${pageId}`, JSON.stringify(view));
      } catch {}
    }, 400);
    return () => clearTimeout(t);
  }, [view, pageId]);

  // ---------- Cambios con deshacer ----------

  const commit = useCallback(
    (next, { history = true, before = docRef.current } = {}) => {
      if (history) {
        undoStack.current.push(JSON.stringify(before));
        if (undoStack.current.length > MAX_HISTORY) undoStack.current.shift();
        redoStack.current = [];
      }
      docRef.current = next;
      setDoc(next);
      onChange?.(next);
    },
    [onChange]
  );

  const undo = useCallback(() => {
    const prev = undoStack.current.pop();
    if (!prev) return;
    redoStack.current.push(JSON.stringify(docRef.current));
    const d = JSON.parse(prev);
    docRef.current = d;
    setDoc(d);
    onChange?.(d);
  }, [onChange]);

  const redo = useCallback(() => {
    const next = redoStack.current.pop();
    if (!next) return;
    undoStack.current.push(JSON.stringify(docRef.current));
    const d = JSON.parse(next);
    docRef.current = d;
    setDoc(d);
    onChange?.(d);
  }, [onChange]);

  const updateNodes = (fn, opts) => {
    const d = docRef.current;
    commit({ ...d, nodes: d.nodes.map((n) => fn(n) || n) }, opts);
  };

  // ---------- Coordenadas ----------

  const toWorld = (clientX, clientY) => {
    const r = wrapRef.current.getBoundingClientRect();
    const v = viewRef.current;
    return { x: (clientX - r.left - v.x) / v.k, y: (clientY - r.top - v.y) / v.k };
  };

  const viewportCenter = () => {
    const r = wrapRef.current.getBoundingClientRect();
    return toWorld(r.left + r.width / 2, r.top + r.height / 2);
  };

  const zoomAt = (factor, clientX, clientY) => {
    const r = wrapRef.current.getBoundingClientRect();
    const v = viewRef.current;
    const k = Math.min(3, Math.max(0.1, v.k * factor));
    const px = (clientX ?? r.left + r.width / 2) - r.left;
    const py = (clientY ?? r.top + r.height / 2) - r.top;
    setView({ k, x: px - ((px - v.x) / v.k) * k, y: py - ((py - v.y) / v.k) * k });
  };

  const fitTo = (rect) => {
    const r = wrapRef.current.getBoundingClientRect();
    setView(fitView(rect, r.width, r.height, 60, 1.5));
  };

  // Rueda: desplazar; Ctrl/⌘ o pellizco: zoom
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return undefined;
    const onWheel = (e) => {
      if (e.target.closest?.('.canvas-card.is-selected .canvas-scroll, textarea')) return;
      e.preventDefault();
      if (e.ctrlKey || e.metaKey) zoomAt(Math.exp(-e.deltaY * 0.01), e.clientX, e.clientY);
      else {
        const dx = e.shiftKey ? e.deltaY : e.deltaX;
        const dy = e.shiftKey ? 0 : e.deltaY;
        setView((v) => ({ ...v, x: v.x - dx, y: v.y - dy }));
      }
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  });

  // ---------- Crear ----------

  const addNode = (node, { edit = false } = {}) => {
    const d = docRef.current;
    // los grupos van debajo de todo
    const nodes = node.type === 'group' ? [node, ...d.nodes] : [...d.nodes, node];
    commit({ ...d, nodes });
    setSel({ nodes: new Set([node.id]), edges: new Set() });
    if (edit) setEditing(node.id);
    return node;
  };

  const placeAt = (p, w, h) => ({ x: snap(p.x - w / 2, settings.snap), y: snap(p.y - h / 2, settings.snap) });

  const addText = (p = viewportCenter(), opts = { edit: true }) =>
    addNode({ id: newId(), type: 'text', text: '', ...placeAt(p, 260, 140), width: 260, height: 140 }, opts);

  const addPage = (pid, p = viewportCenter()) =>
    addNode({ id: newId(), type: 'file', file: `/p/${pid}`, ...placeAt(p, 400, 400), width: 400, height: 400 });

  const addLink = (url, p = viewportCenter()) =>
    addNode({ id: newId(), type: 'link', url, ...placeAt(p, 420, 320), width: 420, height: 320 });

  const addFileNode = (meta, p = viewportCenter()) => {
    const isImg = (meta.mime || '').startsWith('image/');
    const [w, h] = isImg ? [360, 260] : [300, 120];
    return addNode({ id: newId(), type: 'file', file: meta.url, ...placeAt(p, w, h), width: w, height: h });
  };

  const uploadFiles = async (files, p) => {
    let at = p || viewportCenter();
    for (const f of files) {
      try {
        const meta = await api.uploadFile(f, pageId);
        addFileNode(meta, at);
        at = { x: at.x + 40, y: at.y + 40 };
      } catch (e) {
        alert(`No se pudo subir ${f.name}: ${e.message}`);
      }
    }
  };

  const groupSelection = () => {
    const d = docRef.current;
    const chosen = d.nodes.filter((n) => selRef.current.nodes.has(n.id));
    const b = bounds(chosen) || { ...viewportCenter(), w: 400, h: 300 };
    const pad = 40;
    addNode({
      id: newId(),
      type: 'group',
      label: 'Grupo',
      x: snap(b.x - pad, settings.snap),
      y: snap(b.y - pad, settings.snap),
      width: snap(b.w + pad * 2, settings.snap),
      height: snap(b.h + pad * 2, settings.snap),
    });
  };

  // ---------- Selección ----------

  const selectedNodes = () => docRef.current.nodes.filter((n) => selRef.current.nodes.has(n.id));

  const deleteSelection = () => {
    const s = selRef.current;
    if (!s.nodes.size && !s.edges.size) return;
    const d = docRef.current;
    commit({
      nodes: d.nodes.filter((n) => !s.nodes.has(n.id)),
      edges: d.edges.filter((e) => !s.edges.has(e.id) && !s.nodes.has(e.fromNode) && !s.nodes.has(e.toNode)),
    });
    setSel({ nodes: new Set(), edges: new Set() });
  };

  const colorSelection = (color) => {
    const s = selRef.current;
    const d = docRef.current;
    const set = (x) => {
      const out = { ...x };
      if (color) out.color = color;
      else delete out.color;
      return out;
    };
    commit({
      nodes: d.nodes.map((n) => (s.nodes.has(n.id) ? set(n) : n)),
      edges: d.edges.map((e) => (s.edges.has(e.id) ? set(e) : e)),
    });
  };

  const layoutSelection = (fn) => {
    setPanel(null); // el menú se cierra al aplicar
    const chosen = selectedNodes();
    if (chosen.length < 2) return;
    const moved = new Map(fn(chosen).map((n) => [n.id, n]));
    updateNodes((n) => moved.get(n.id));
  };

  // Convertir una tarjeta de texto en página (como "Convert to file…")
  const convertToPage = async (node) => {
    const markdown = node.text?.trim() ? node.text : ' ';
    try {
      const p = await api.capture({ markdown, title: titleFromText(node.text), parent_id: parentId || undefined, icon: '📄' });
      invalidatePagePreview(p.id);
      updateNodes((n) => (n.id === node.id ? { id: n.id, type: 'file', file: `/p/${p.id}`, x: n.x, y: n.y, width: n.width, height: n.height, ...(n.color ? { color: n.color } : {}) } : null));
    } catch (e) {
      alert(`No se pudo crear la página: ${e.message}`);
    }
  };

  const setEdgeDirection = (mode) => {
    const s = selRef.current;
    const d = docRef.current;
    commit({
      ...d,
      edges: d.edges.map((e) =>
        s.edges.has(e.id)
          ? { ...e, fromEnd: mode === 'both' ? 'arrow' : 'none', toEnd: mode === 'none' ? 'none' : 'arrow' }
          : e
      ),
    });
  };

  const exportCanvas = () => {
    const blob = new Blob([JSON.stringify(docRef.current, null, '\t')], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${(document.querySelector('.page-title')?.value || 'canvas').replace(/[\\/:*?"<>|]/g, '_')}.canvas`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  };

  // ---------- Puntero ----------

  const onPointerDown = (e) => {
    const t = e.target;
    if (t.closest('textarea, input, .canvas-ui, .canvas-panel')) return;
    if (editing) setEditing(null);
    if (labelEdit) finishLabel();
    setPanel(null);
    wrapRef.current.focus({ preventScroll: true });
    const p = toWorld(e.clientX, e.clientY);
    const start = { cx: e.clientX, cy: e.clientY, world: p, before: docRef.current, moved: false };

    if (e.button === 1 || (e.button === 0 && spaceDown.current)) {
      op.current = { type: 'pan', ...start, view: viewRef.current };
    } else if (e.button !== 0) {
      return;
    } else if (!readOnly && t.closest('[data-resize]')) {
      const el = t.closest('[data-resize]');
      const n = byId.get(el.dataset.node);
      op.current = { type: 'resize', ...start, id: n.id, dir: el.dataset.resize, rect: rectOf(n) };
    } else if (!readOnly && t.closest('[data-handle]')) {
      const el = t.closest('[data-handle]');
      op.current = { type: 'connect', ...start, from: el.dataset.node, side: el.dataset.handle };
    } else if (!readOnly && t.closest('[data-edge-end]')) {
      const el = t.closest('[data-edge-end]');
      op.current = { type: 'reconnect', ...start, edge: el.dataset.edge, end: el.dataset.edgeEnd };
    } else if (t.closest('[data-edge]')) {
      const id = t.closest('[data-edge]').dataset.edge;
      setSel((s) => {
        const edges = new Set(e.shiftKey ? s.edges : []);
        if (e.shiftKey && edges.has(id)) edges.delete(id);
        else edges.add(id);
        return { nodes: e.shiftKey ? s.nodes : new Set(), edges };
      });
      return;
    } else if (t.closest('[data-node]')) {
      const id = t.closest('[data-node]').dataset.node;
      let nodes = new Set(selRef.current.nodes);
      if (e.shiftKey) {
        if (nodes.has(id)) nodes.delete(id);
        else nodes.add(id);
      } else if (!nodes.has(id)) nodes = new Set([id]);
      setSel({ nodes, edges: new Set() });
      if (readOnly || !nodes.has(id)) return;
      let d = docRef.current;
      let ids = [...nodes];
      // Alt: duplicar la selección y mover las copias
      if (e.altKey) {
        const map = new Map();
        const copies = d.nodes.filter((n) => nodes.has(n.id)).map((n) => {
          const c = { ...n, id: newId() };
          map.set(n.id, c.id);
          return c;
        });
        const edgeCopies = d.edges
          .filter((x) => map.has(x.fromNode) && map.has(x.toNode))
          .map((x) => ({ ...x, id: newId(), fromNode: map.get(x.fromNode), toNode: map.get(x.toNode) }));
        d = { nodes: [...d.nodes, ...copies], edges: [...d.edges, ...edgeCopies] };
        docRef.current = d;
        setDoc(d);
        ids = copies.map((c) => c.id);
        setSel({ nodes: new Set(ids), edges: new Set() });
      } else {
        // seleccionar lleva la tarjeta al frente (los grupos se quedan detrás)
        const front = d.nodes.filter((n) => nodes.has(n.id) && n.type !== 'group');
        if (front.length && d.nodes.slice(-front.length).some((n) => !nodes.has(n.id))) {
          d = { ...d, nodes: [...d.nodes.filter((n) => !front.includes(n)), ...front] };
          docRef.current = d;
          setDoc(d);
        }
      }
      // los grupos arrastran lo que contienen
      const moving = new Set(ids);
      for (const g of d.nodes.filter((n) => moving.has(n.id) && n.type === 'group')) {
        for (const inner of nodesInGroup(d.nodes, g)) moving.add(inner.id);
      }
      const origin = new Map(d.nodes.filter((n) => moving.has(n.id)).map((n) => [n.id, { x: n.x, y: n.y }]));
      op.current = { type: 'move', ...start, origin, primary: id, dup: e.altKey };
    } else {
      if (!e.shiftKey) setSel({ nodes: new Set(), edges: new Set() });
      op.current = { type: 'marquee', ...start, base: e.shiftKey ? new Set(selRef.current.nodes) : new Set() };
    }
    wrapRef.current.setPointerCapture?.(e.pointerId);
  };

  const onPointerMove = (e) => {
    const o = op.current;
    if (!o) return;
    const dxs = e.clientX - o.cx;
    const dys = e.clientY - o.cy;
    if (!o.moved && Math.hypot(dxs, dys) < 3) return;
    o.moved = true;
    const p = toWorld(e.clientX, e.clientY);
    const snapOn = settings.snap && !spaceDown.current;

    if (o.type === 'pan') {
      setView({ ...o.view, x: o.view.x + dxs, y: o.view.y + dys });
    } else if (o.type === 'move') {
      let dx = p.x - o.world.x;
      let dy = p.y - o.world.y;
      if (e.shiftKey) {
        if (Math.abs(dx) > Math.abs(dy)) dy = 0;
        else dx = 0;
      }
      const prim = o.origin.get(o.primary);
      if (prim && snapOn) {
        dx = snap(prim.x + dx) - prim.x;
        dy = snap(prim.y + dy) - prim.y;
      }
      const d = docRef.current;
      const next = {
        ...d,
        nodes: d.nodes.map((n) => {
          const s = o.origin.get(n.id);
          return s ? { ...n, x: Math.round(s.x + dx), y: Math.round(s.y + dy) } : n;
        }),
      };
      docRef.current = next;
      setDoc(next);
    } else if (o.type === 'resize') {
      const r = { ...o.rect };
      const dx = p.x - o.world.x;
      const dy = p.y - o.world.y;
      let { x, y, w, h } = r;
      if (o.dir.includes('e')) w = r.w + dx;
      if (o.dir.includes('s')) h = r.h + dy;
      if (o.dir.includes('w')) {
        x = r.x + dx;
        w = r.w - dx;
      }
      if (o.dir.includes('n')) {
        y = r.y + dy;
        h = r.h - dy;
      }
      if (e.shiftKey && o.dir.length === 2) {
        const ratio = r.w / r.h;
        if (w / h > ratio) w = h * ratio;
        else h = w / ratio;
        if (o.dir.includes('w')) x = r.x + r.w - w;
        if (o.dir.includes('n')) y = r.y + r.h - h;
      }
      if (snapOn) {
        const x2 = snap(x + w);
        const y2 = snap(y + h);
        if (o.dir.includes('w')) x = snap(x);
        if (o.dir.includes('n')) y = snap(y);
        if (o.dir.includes('e') || o.dir.includes('w')) w = x2 - x;
        if (o.dir.includes('s') || o.dir.includes('n')) h = y2 - y;
      }
      w = Math.max(MIN_W, Math.round(w));
      h = Math.max(MIN_H, Math.round(h));
      const d = docRef.current;
      const next = { ...d, nodes: d.nodes.map((n) => (n.id === o.id ? { ...n, x: Math.round(x), y: Math.round(y), width: w, height: h } : n)) };
      docRef.current = next;
      setDoc(next);
    } else if (o.type === 'connect' || o.type === 'reconnect') {
      const hover = document.elementFromPoint(e.clientX, e.clientY)?.closest?.('[data-node]')?.dataset.node || null;
      setTemp({ ...o, to: p, hover });
    } else if (o.type === 'marquee') {
      const r = { x: Math.min(o.world.x, p.x), y: Math.min(o.world.y, p.y), w: Math.abs(p.x - o.world.x), h: Math.abs(p.y - o.world.y) };
      setMarquee(r);
      const nodes = new Set(o.base);
      for (const n of docRef.current.nodes) if (intersects(r, rectOf(n))) nodes.add(n.id);
      setSel({ nodes, edges: new Set() });
    }
  };

  const onPointerUp = (e) => {
    const o = op.current;
    op.current = null;
    setMarquee(null);
    setTemp(null);
    if (!o) return;
    const p = toWorld(e.clientX, e.clientY);
    if ((o.type === 'move' && (o.moved || o.dup)) || (o.type === 'resize' && o.moved)) {
      commit(docRef.current, { before: o.before });
    } else if (o.type === 'connect' && o.moved) {
      const d = docRef.current;
      const targetId = document.elementFromPoint(e.clientX, e.clientY)?.closest?.('[data-node]')?.dataset.node;
      if (targetId && targetId !== o.from) {
        const target = d.nodes.find((n) => n.id === targetId);
        const edge = { id: newId(), fromNode: o.from, fromSide: o.side, toNode: targetId, toSide: nearestSide(target, p) };
        commit({ ...d, edges: [...d.edges, edge] });
        setSel({ nodes: new Set(), edges: new Set([edge.id]) });
      } else if (!targetId) {
        // soltar en vacío crea una tarjeta conectada (como en Obsidian)
        const side = { right: 'left', left: 'right', top: 'bottom', bottom: 'top' }[o.side];
        const w = 260;
        const h = 140;
        const pos = {
          x: snap(side === 'right' ? p.x - w : side === 'left' ? p.x : p.x - w / 2, settings.snap),
          y: snap(side === 'bottom' ? p.y - h : side === 'top' ? p.y : p.y - h / 2, settings.snap),
        };
        const node = { id: newId(), type: 'text', text: '', ...pos, width: w, height: h };
        const edge = { id: newId(), fromNode: o.from, fromSide: o.side, toNode: node.id, toSide: side };
        commit({ nodes: [...d.nodes, node], edges: [...d.edges, edge] });
        setSel({ nodes: new Set([node.id]), edges: new Set() });
        setEditing(node.id);
      }
    } else if (o.type === 'reconnect' && o.moved) {
      const d = docRef.current;
      const targetId = document.elementFromPoint(e.clientX, e.clientY)?.closest?.('[data-node]')?.dataset.node;
      const edge = d.edges.find((x) => x.id === o.edge);
      if (!edge) return;
      if (!targetId) {
        // soltar fuera desconecta
        commit({ ...d, edges: d.edges.filter((x) => x.id !== o.edge) });
        setSel({ nodes: new Set(), edges: new Set() });
      } else {
        const target = d.nodes.find((n) => n.id === targetId);
        const patch = o.end === 'from' ? { fromNode: targetId, fromSide: nearestSide(target, p) } : { toNode: targetId, toSide: nearestSide(target, p) };
        if ((o.end === 'from' ? edge.toNode : edge.fromNode) !== targetId) {
          commit({ ...d, edges: d.edges.map((x) => (x.id === o.edge ? { ...x, ...patch } : x)) });
        }
      }
    } else if (o.type === 'move' && !o.moved && o.before !== docRef.current) {
      // solo se trajo al frente: se guarda sin entrada en el historial
      commit(docRef.current, { history: false });
    }
  };

  const onDoubleClick = (e) => {
    if (readOnly) return;
    const t = e.target;
    if (t.closest('textarea, input, .canvas-ui, .canvas-panel')) return;
    const edgeEl = t.closest('[data-edge]');
    if (edgeEl) {
      const edge = docRef.current.edges.find((x) => x.id === edgeEl.dataset.edge);
      if (edge) setLabelEdit({ kind: 'edge', id: edge.id, value: edge.label || '' });
      return;
    }
    const label = t.closest('[data-group-label]');
    if (label) {
      const g = byId.get(label.dataset.groupLabel);
      setLabelEdit({ kind: 'group', id: g.id, value: g.label || '' });
      return;
    }
    const nodeEl = t.closest('[data-node]');
    if (nodeEl) {
      const n = byId.get(nodeEl.dataset.node);
      if (n?.type === 'text') setEditing(n.id);
      else if (n?.type === 'group') setLabelEdit({ kind: 'group', id: n.id, value: n.label || '' });
      return;
    }
    addText(toWorld(e.clientX, e.clientY));
  };

  const finishLabel = () => {
    const l = labelEdit;
    setLabelEdit(null);
    if (!l) return;
    const d = docRef.current;
    if (l.kind === 'edge') {
      commit({ ...d, edges: d.edges.map((x) => (x.id === l.id ? (l.value.trim() ? { ...x, label: l.value } : (({ label, ...rest }) => rest)(x)) : x)) });
    } else {
      updateNodes((n) => (n.id === l.id ? { ...n, label: l.value } : null));
    }
  };

  // ---------- Teclado ----------

  const onKeyDown = (e) => {
    if (e.target.closest?.('textarea, input')) return;
    const mod = e.ctrlKey || e.metaKey;
    if (e.key === ' ') {
      spaceDown.current = true;
      setSpacePan(true);
      e.preventDefault();
      return;
    }
    if (mod && e.key.toLowerCase() === 'z') {
      e.preventDefault();
      if (e.shiftKey) redo();
      else undo();
    } else if (mod && e.key.toLowerCase() === 'y') {
      e.preventDefault();
      redo();
    } else if (mod && e.key.toLowerCase() === 'a') {
      e.preventDefault();
      setSel({ nodes: new Set(docRef.current.nodes.map((n) => n.id)), edges: new Set() });
    } else if ((e.key === 'Delete' || e.key === 'Backspace') && !readOnly) {
      e.preventDefault();
      deleteSelection();
    } else if (e.key === 'Escape') {
      setSel({ nodes: new Set(), edges: new Set() });
    } else if (e.shiftKey && e.code === 'Digit1') {
      fitTo(bounds(docRef.current.nodes));
    } else if (e.shiftKey && e.code === 'Digit2') {
      fitTo(bounds(selectedNodes()));
    } else if (e.key === '+' || e.key === '=') {
      zoomAt(1.2);
    } else if (e.key === '-') {
      zoomAt(1 / 1.2);
    } else if (e.key === 'Enter' && sel.nodes.size === 1 && !readOnly) {
      const n = byId.get([...sel.nodes][0]);
      if (n?.type === 'text') {
        e.preventDefault();
        setEditing(n.id);
      }
    }
  };

  const onKeyUp = (e) => {
    if (e.key === ' ') {
      spaceDown.current = false;
      setSpacePan(false);
    }
  };

  // ---------- Soltar páginas, archivos y enlaces ----------

  const onDrop = (e) => {
    if (readOnly) return;
    e.preventDefault();
    const p = toWorld(e.clientX, e.clientY);
    const pid = e.dataTransfer.getData('text/nonotion-page');
    if (pid) return addPage(pid, p);
    const files = Array.from(e.dataTransfer.files || []);
    if (files.length) return uploadFiles(files, p);
    const url = e.dataTransfer.getData('text/uri-list') || e.dataTransfer.getData('text/plain');
    if (/^https?:\/\//.test(url?.trim() || '')) {
      const m = url.trim().match(/\/p\/([A-Za-z0-9_-]+)/);
      if (m && url.includes(location.host)) return addPage(m[1], p);
      return addLink(url.trim(), p);
    }
  };

  // ---------- Pintado ----------

  if (!view) return <div className="canvas-wrap" ref={wrapRef} />;

  const selNodes = doc.nodes.filter((n) => sel.nodes.has(n.id));
  const selBox = bounds(selNodes);
  const oneText = selNodes.length === 1 && selNodes[0].type === 'text' ? selNodes[0] : null;
  const groups = doc.nodes.filter((n) => n.type === 'group');
  const usedColors = new Set([...doc.edges.map((x) => x.color || ''), '']);
  const pagePick = pickQ.trim()
    ? pages.filter((p) => (p.title || '').toLowerCase().includes(pickQ.trim().toLowerCase()))
    : pages;

  const edgeColor = (x, selected) => (selected ? 'var(--accent)' : colorValue(x.color) || 'var(--text-faint)');

  return (
    <div
      ref={wrapRef}
      className={'canvas-wrap' + (spacePan ? ' is-panning' : '') + (readOnly ? ' is-readonly' : '')}
      tabIndex={0}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onDoubleClick={onDoubleClick}
      onKeyDown={onKeyDown}
      onKeyUp={onKeyUp}
      onFocus={() => onFocusChange?.(true)}
      onBlur={(e) => !e.currentTarget.contains(e.relatedTarget) && onFocusChange?.(false)}
      onDragOver={(e) => !readOnly && e.preventDefault()}
      onDrop={onDrop}
      style={{
        backgroundSize: `${GRID * view.k}px ${GRID * view.k}px`,
        backgroundPosition: `${view.x}px ${view.y}px`,
      }}
    >
      <div className="canvas-layer" style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.k})` }}>
        {/* Grupos y tarjetas, en el orden del archivo (z-index) */}
        {doc.nodes.map((n) => {
          const selected = sel.nodes.has(n.id);
          const color = colorValue(n.color);
          return (
            <div
              key={n.id}
              data-node={n.id}
              className={`canvas-card type-${n.type}${selected ? ' is-selected' : ''}${temp?.hover === n.id ? ' is-target' : ''}`}
              style={{ left: n.x, top: n.y, width: n.width, height: n.height, '--card-color': color || undefined }}
            >
              {n.type === 'group' ? (
                <div className="canvas-group-label" data-group-label={n.id}>
                  {labelEdit?.kind === 'group' && labelEdit.id === n.id ? (
                    <input
                      autoFocus
                      value={labelEdit.value}
                      onChange={(e) => setLabelEdit({ ...labelEdit, value: e.target.value })}
                      onKeyDown={(e) => {
                        e.stopPropagation();
                        if (e.key === 'Enter' || e.key === 'Escape') finishLabel();
                      }}
                      onBlur={finishLabel}
                    />
                  ) : (
                    n.label || 'Grupo'
                  )}
                </div>
              ) : (
                <div className="canvas-scroll">
                  <CanvasCard
                    node={n}
                    selected={selected}
                    editing={editing === n.id}
                    onTextChange={(text) => {
                      const d = docRef.current;
                      const before = d;
                      const next = { ...d, nodes: d.nodes.map((x) => (x.id === n.id ? { ...x, text } : x)) };
                      // un único paso de deshacer por sesión de edición
                      commit(next, { history: !typing.current, before });
                      typing.current = true;
                    }}
                    onStopEdit={() => {
                      setEditing(null);
                      typing.current = false;
                    }}
                    onOpenPage={(pid) => navigate(`/p/${pid}`)}
                  />
                </div>
              )}
              {!readOnly && selected && selNodes.length === 1 &&
                ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw'].map((d) => (
                  <span key={d} className={`canvas-resize r-${d}`} data-resize={d} data-node={n.id} />
                ))}
              {!readOnly && n.type !== 'group' &&
                SIDES.map((s) => <span key={s} className={`canvas-handle h-${s}`} data-handle={s} data-node={n.id} />)}
            </div>
          );
        })}

        {/* Conexiones (por encima de los grupos, debajo de nada más importante) */}
        <svg className="canvas-edges" width="1" height="1">
          <defs>
            {[...usedColors, 'sel'].map((c) => (
              <marker key={c || 'none'} id={`arrow-${pageId}-${c || 'none'}`} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
                <path d="M0,0 L10,5 L0,10 z" style={{ fill: c === 'sel' ? 'var(--accent)' : colorValue(c) || 'var(--text-faint)' }} />
              </marker>
            ))}
          </defs>
          {doc.edges.map((x) => {
            const ends = edgeEnds(x, byId);
            if (!ends) return null;
            const g = edgeGeometry(ends.from, ends.fromSide, ends.to, ends.toSide);
            const selected = sel.edges.has(x.id);
            const marker = `url(#arrow-${pageId}-${selected ? 'sel' : x.color || 'none'})`;
            return (
              <g key={x.id}>
                <path d={g.d} className="canvas-edge-hit" data-edge={x.id} />
                <path
                  d={g.d}
                  className={'canvas-edge' + (selected ? ' is-selected' : '')}
                  style={{ stroke: edgeColor(x, selected) }}
                  markerEnd={(x.toEnd || 'arrow') === 'arrow' ? marker : undefined}
                  markerStart={x.fromEnd === 'arrow' ? marker : undefined}
                />
                {selected && !readOnly && (
                  <>
                    <circle cx={ends.from.x} cy={ends.from.y} r={6 / view.k} className="canvas-edge-end" data-edge={x.id} data-edge-end="from" />
                    <circle cx={ends.to.x} cy={ends.to.y} r={6 / view.k} className="canvas-edge-end" data-edge={x.id} data-edge-end="to" />
                  </>
                )}
              </g>
            );
          })}
          {temp && (() => {
            const src = temp.type === 'connect' ? byId.get(temp.from) : null;
            if (temp.type === 'connect' && src) {
              const a = anchor(src, temp.side);
              const g = edgeGeometry(a, temp.side, temp.to, null);
              return <path d={g.d} className="canvas-edge is-temp" style={{ stroke: 'var(--accent)' }} markerEnd={`url(#arrow-${pageId}-sel)`} />;
            }
            const edge = doc.edges.find((x) => x.id === temp.edge);
            const ends = edge && edgeEnds(edge, byId);
            if (!ends) return null;
            const fixed = temp.end === 'from' ? ends.to : ends.from;
            const fixedSide = temp.end === 'from' ? ends.toSide : ends.fromSide;
            return <path d={edgeGeometry(fixed, fixedSide, temp.to, null).d} className="canvas-edge is-temp" style={{ stroke: 'var(--accent)' }} />;
          })()}
        </svg>

        {/* Etiquetas de las conexiones */}
        {doc.edges.map((x) => {
          const ends = edgeEnds(x, byId);
          if (!ends) return null;
          const editingThis = labelEdit?.kind === 'edge' && labelEdit.id === x.id;
          if (!x.label && !editingThis) return null;
          const { mid } = edgeGeometry(ends.from, ends.fromSide, ends.to, ends.toSide);
          return (
            <div key={x.id} className="canvas-edge-label" data-edge={x.id} style={{ left: mid.x, top: mid.y, '--card-color': colorValue(x.color) || undefined }}>
              {editingThis ? (
                <input
                  autoFocus
                  value={labelEdit.value}
                  placeholder="Etiqueta"
                  onChange={(e) => setLabelEdit({ ...labelEdit, value: e.target.value })}
                  onKeyDown={(e) => {
                    e.stopPropagation();
                    if (e.key === 'Enter' || e.key === 'Escape') finishLabel();
                  }}
                  onBlur={finishLabel}
                />
              ) : (
                x.label
              )}
            </div>
          );
        })}

        {marquee && <div className="canvas-marquee" style={{ left: marquee.x, top: marquee.y, width: marquee.w, height: marquee.h }} />}
      </div>

      {/* Barra de la selección (encima de lo seleccionado) */}
      {!readOnly && (selBox || sel.edges.size > 0) && !op.current?.type && (
        <div
          className="canvas-ui canvas-selbar"
          style={
            selBox
              ? { left: Math.max(8, selBox.x * view.k + view.x + (selBox.w * view.k) / 2), top: Math.max(8, selBox.y * view.k + view.y - 52) }
              : { left: '50%', top: 12 }
          }
        >
          {[1, 2, 3, 4, 5, 6].map((c) => (
            <button key={c} className="canvas-swatch" style={{ background: PRESET_COLORS[c] }} title={COLOR_NAMES[c]} onClick={() => colorSelection(String(c))} />
          ))}
          <button className="canvas-swatch is-none" title="Sin color" onClick={() => colorSelection(null)} />
          <span className="canvas-sep" />
          {sel.edges.size > 0 && (
            <>
              <button title="Sin dirección" onClick={() => setEdgeDirection('none')}>
                <Minus {...ICON} />
              </button>
              <button title="Una dirección" onClick={() => setEdgeDirection('one')}>
                <ArrowRight {...ICON} />
              </button>
              <button title="Dos direcciones" onClick={() => setEdgeDirection('both')}>
                <ArrowLeftRight {...ICON} />
              </button>
              {sel.edges.size === 1 && (
                <button
                  title="Editar etiqueta (o doble clic en la conexión)"
                  onClick={() => {
                    const x = doc.edges.find((y) => sel.edges.has(y.id));
                    setLabelEdit({ kind: 'edge', id: x.id, value: x.label || '' });
                  }}
                >
                  <Tag {...ICON} />
                </button>
              )}
            </>
          )}
          {oneText && (
            <button title="Convertir en página de NoNotion" onClick={() => convertToPage(oneText)}>
              <FileOutput {...ICON} />
            </button>
          )}
          {selNodes.length >= 2 && (
            <button title="Alinear y organizar" onClick={() => setPanel(panel === 'align' ? null : 'align')}>
              <AlignLeft {...ICON} />
            </button>
          )}
          {selNodes.length >= 1 && (
            <button title="Crear grupo con la selección" onClick={groupSelection}>
              <Group {...ICON} />
            </button>
          )}
          {selBox && (
            <button title="Zoom a la selección (Mayús+2)" onClick={() => fitTo(selBox)}>
              <Scan {...ICON} />
            </button>
          )}
          <button title="Eliminar (Supr)" className="danger" onClick={deleteSelection}>
            <Trash2 {...ICON} />
          </button>
          {panel === 'align' && (
            <div className="canvas-panel canvas-align">
              {[
                ['left', 'Alinear a la izquierda'],
                ['center', 'Centrar en horizontal'],
                ['right', 'Alinear a la derecha'],
                ['top', 'Alinear arriba'],
                ['middle', 'Centrar en vertical'],
                ['bottom', 'Alinear abajo'],
              ].map(([m, label]) => (
                <button key={m} onClick={() => layoutSelection((ns) => align(ns, m))}>
                  {label}
                </button>
              ))}
              <span className="canvas-panel-sep" />
              <button onClick={() => layoutSelection((ns) => arrange(ns, 'row'))}>Organizar en fila</button>
              <button onClick={() => layoutSelection((ns) => arrange(ns, 'column'))}>Organizar en columna</button>
              <button onClick={() => layoutSelection((ns) => arrange(ns, 'grid'))}>Organizar en cuadrícula</button>
              <span className="canvas-panel-sep" />
              <button onClick={() => layoutSelection((ns) => distribute(ns, 'h'))}>Repartir en horizontal</button>
              <button onClick={() => layoutSelection((ns) => distribute(ns, 'v'))}>Repartir en vertical</button>
            </div>
          )}
        </div>
      )}

      {/* Controles de vista (arriba a la derecha, como en Obsidian) */}
      <div className="canvas-ui canvas-controls">
        <button title="Acercar (+)" onClick={() => zoomAt(1.2)}>
          <ZoomIn {...ICON} />
        </button>
        <button title="Alejar (-)" onClick={() => zoomAt(1 / 1.2)}>
          <ZoomOut {...ICON} />
        </button>
        <button title="Encajar todo (Mayús+1)" onClick={() => fitTo(bounds(doc.nodes))}>
          <Maximize {...ICON} />
        </button>
        <button title={`Restablecer zoom (${Math.round(view.k * 100)} %)`} onClick={() => setView((v) => ({ ...v, k: 1 }))}>
          <span className="canvas-zoom-pct">{Math.round(view.k * 100)}%</span>
        </button>
        <span className="canvas-sep-h" />
        {!readOnly && (
          <>
            <button title="Deshacer (Ctrl+Z)" onClick={undo} disabled={!undoStack.current.length}>
              <Undo2 {...ICON} />
            </button>
            <button title="Rehacer (Ctrl+Y)" onClick={redo} disabled={!redoStack.current.length}>
              <Redo2 {...ICON} />
            </button>
          </>
        )}
        {groups.length > 0 && (
          <button title="Ir a un grupo" onClick={() => setPanel(panel === 'groups' ? null : 'groups')}>
            <BoxSelect {...ICON} />
          </button>
        )}
        <button title="Exportar como .canvas (JSON Canvas, abre en Obsidian)" onClick={exportCanvas}>
          <Download {...ICON} />
        </button>
        {!forcedReadOnly && (
          <button title="Ajustes del canvas" onClick={() => setPanel(panel === 'settings' ? null : 'settings')}>
            <Settings2 {...ICON} />
          </button>
        )}
        {panel === 'settings' && (
          <div className="canvas-panel canvas-settings">
            <label>
              <input type="checkbox" checked={settings.snap} onChange={(e) => setSettings({ ...settings, snap: e.target.checked })} />
              Ajustar a la cuadrícula
            </label>
            <label>
              <input type="checkbox" checked={settings.readOnly} onChange={(e) => setSettings({ ...settings, readOnly: e.target.checked })} />
              Solo lectura
            </label>
            <p className="canvas-help">
              Doble clic: tarjeta nueva · Arrastra desde el borde de una tarjeta para conectar · Espacio+arrastrar o rueda: desplazar ·
              Ctrl+rueda: zoom · Mayús: añadir a la selección · Alt+arrastrar: duplicar · Espacio al mover: sin ajuste
            </p>
          </div>
        )}
        {panel === 'groups' && (
          <div className="canvas-panel canvas-groups">
            {groups.map((g) => (
              <button
                key={g.id}
                onClick={() => {
                  fitTo(rectOf(g));
                  setPanel(null);
                }}
              >
                {g.label || 'Grupo'}
              </button>
            ))}
          </div>
        )}
      </div>

      {readOnly && !forcedReadOnly && (
        <div className="canvas-ui canvas-ro">
          <Lock size={13} /> Solo lectura
        </div>
      )}

      {/* Añadir tarjetas (abajo, como en Obsidian) */}
      {!readOnly && (
        <div className="canvas-ui canvas-addbar">
          <button title="Tarjeta de texto (o doble clic en el canvas)" onClick={() => addText()}>
            <StickyNote {...ICON} />
          </button>
          <button title="Página de NoNotion" onClick={() => setPanel(panel === 'page' ? null : 'page')}>
            <FileText {...ICON} />
          </button>
          <button title="Imagen o archivo" onClick={() => fileRef.current?.click()}>
            <Paperclip {...ICON} />
          </button>
          <button
            title="Página web"
            onClick={() => {
              const url = window.prompt('Dirección de la página web:', 'https://');
              if (url && /^https?:\/\/\S+$/.test(url.trim())) addLink(url.trim());
            }}
          >
            <Globe {...ICON} />
          </button>
          <button title="Grupo (con la selección, si hay)" onClick={groupSelection}>
            <Ungroup {...ICON} />
          </button>
          {panel === 'page' && (
            <div className="canvas-panel canvas-pick">
              <input autoFocus placeholder="Buscar página…" value={pickQ} onChange={(e) => setPickQ(e.target.value)} onKeyDown={(e) => e.stopPropagation()} />
              <div className="canvas-pick-list">
                {pagePick
                  .filter((p) => p.id !== pageId)
                  .slice(0, 50)
                  .map((p) => (
                    <button
                      key={p.id}
                      onClick={() => {
                        addPage(p.id);
                        setPanel(null);
                        setPickQ('');
                      }}
                    >
                      {p.icon || (p.kind === 'canvas' ? '🧩' : '📄')} {p.title || 'Sin título'}
                    </button>
                  ))}
              </div>
            </div>
          )}
          <input
            ref={fileRef}
            type="file"
            multiple
            hidden
            onChange={(e) => {
              const files = Array.from(e.target.files || []);
              e.target.value = '';
              if (files.length) uploadFiles(files);
            }}
          />
        </div>
      )}

      {!doc.nodes.length && (
        <div className="canvas-empty">
          {readOnly ? 'Canvas vacío' : 'Doble clic para crear una tarjeta, o arrastra páginas del árbol, archivos o enlaces aquí'}
        </div>
      )}
    </div>
  );
}
