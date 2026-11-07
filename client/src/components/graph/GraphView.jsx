import { useEffect, useMemo, useRef, useState } from 'react';
import { forceSimulation, forceLink, forceManyBody, forceX, forceY, forceCollide } from 'd3-force';
import { Settings2, X, RotateCcw, Play, Plus, Trash2, ChevronDown, ChevronRight } from 'lucide-react';
import { buildGraph, DEFAULTS, GROUP_COLORS } from './model.js';

// Graph view como el de Obsidian: círculos = páginas, líneas = enlaces. Pasar
// el ratón resalta las conexiones; clic abre; arrastrar mueve nodos o el
// lienzo; rueda o +/- hacen zoom; flechas desplazan (con Mayús, más rápido).

function cssVar(name, fallback) {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v || fallback;
}

function Section({ title, children, defaultOpen = true }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="graph-section">
      <button className="graph-section-title" onClick={() => setOpen(!open)}>
        {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />} {title}
      </button>
      {open && <div className="graph-section-body">{children}</div>}
    </div>
  );
}

function Toggle({ label, value, onChange }) {
  return (
    <label className="graph-toggle">
      <span>{label}</span>
      <input type="checkbox" checked={value} onChange={(e) => onChange(e.target.checked)} />
    </label>
  );
}

function Slider({ label, value, min, max, step, onChange }) {
  return (
    <label className="graph-slider">
      <span>{label}</span>
      <input type="range" min={min} max={max} step={step} value={value} onChange={(e) => onChange(Number(e.target.value))} />
    </label>
  );
}

export function GraphSettings({ settings, onChange, local, onAnimate, onClose }) {
  const set = (k) => (v) => onChange({ ...settings, [k]: v });
  return (
    <div className="graph-settings" onPointerDown={(e) => e.stopPropagation()}>
      <div className="graph-settings-head">
        <span>Ajustes del grafo</span>
        <button className="icon-btn" title="Restaurar valores por defecto" onClick={() => onChange({ ...DEFAULTS, groups: [] })}>
          <RotateCcw size={14} />
        </button>
        <button className="icon-btn" title="Cerrar" onClick={onClose}>
          <X size={14} />
        </button>
      </div>
      <Section title="Filtros">
        {local && (
          <>
            <Slider label={`Profundidad: ${settings.depth}`} value={settings.depth} min={1} max={5} step={1} onChange={set('depth')} />
            <Toggle label="Enlaces entrantes" value={settings.incoming} onChange={set('incoming')} />
            <Toggle label="Enlaces salientes" value={settings.outgoing} onChange={set('outgoing')} />
            <Toggle label="Enlaces entre vecinas" value={settings.neighborLinks} onChange={set('neighborLinks')} />
          </>
        )}
        <input
          className="graph-search"
          placeholder="Buscar… (texto, #etiqueta)"
          value={settings.search}
          onChange={(e) => set('search')(e.target.value)}
          onKeyDown={(e) => e.stopPropagation()}
        />
        <Toggle label="Etiquetas" value={settings.showTags} onChange={set('showTags')} />
        <Toggle label="Adjuntos" value={settings.showAttachments} onChange={set('showAttachments')} />
        <Toggle label="Huérfanas (sin enlaces)" value={settings.showOrphans} onChange={set('showOrphans')} />
        <Toggle label="Jerarquía (página → subpáginas)" value={settings.showHierarchy} onChange={set('showHierarchy')} />
        <Toggle label="Ideas (rombos)" value={settings.showIdeas} onChange={set('showIdeas')} />
      </Section>
      <Section title="Grupos" defaultOpen={settings.groups.length > 0}>
        {settings.groups.map((g, i) => (
          <div key={i} className="graph-group">
            <input
              type="color"
              value={g.color}
              onChange={(e) => onChange({ ...settings, groups: settings.groups.map((x, j) => (j === i ? { ...x, color: e.target.value } : x)) })}
            />
            <input
              placeholder="texto o #etiqueta"
              value={g.query}
              onChange={(e) => onChange({ ...settings, groups: settings.groups.map((x, j) => (j === i ? { ...x, query: e.target.value } : x)) })}
              onKeyDown={(e) => e.stopPropagation()}
            />
            <button className="icon-btn" title="Quitar grupo" onClick={() => onChange({ ...settings, groups: settings.groups.filter((_, j) => j !== i) })}>
              <Trash2 size={13} />
            </button>
          </div>
        ))}
        <button
          className="btn graph-new-group"
          onClick={() => onChange({ ...settings, groups: [...settings.groups, { query: '', color: GROUP_COLORS[settings.groups.length % GROUP_COLORS.length] }] })}
        >
          <Plus size={14} /> Nuevo grupo
        </button>
      </Section>
      <Section title="Visualización">
        <Toggle label="Flechas" value={settings.arrows} onChange={set('arrows')} />
        <Slider label="Umbral de texto" value={settings.textFade} min={0.1} max={2.5} step={0.05} onChange={set('textFade')} />
        <Slider label="Tamaño de nodo" value={settings.nodeSize} min={0.4} max={3} step={0.1} onChange={set('nodeSize')} />
        <Slider label="Grosor de enlace" value={settings.linkThickness} min={0.2} max={4} step={0.1} onChange={set('linkThickness')} />
        <button className="btn graph-animate" onClick={onAnimate}>
          <Play size={14} /> Animar (orden de creación)
        </button>
      </Section>
      <Section title="Fuerzas" defaultOpen={false}>
        <Slider label="Fuerza de centro" value={settings.centerForce} min={0} max={0.5} step={0.01} onChange={set('centerForce')} />
        <Slider label="Repulsión" value={settings.repelForce} min={10} max={800} step={10} onChange={set('repelForce')} />
        <Slider label="Fuerza de enlace" value={settings.linkForce} min={0} max={1} step={0.05} onChange={set('linkForce')} />
        <Slider label="Distancia de enlace" value={settings.linkDistance} min={20} max={300} step={5} onChange={set('linkDistance')} />
      </Section>
    </div>
  );
}

export default function GraphView({ data, settings, onSettings, focusId = null, onOpen, compact = false }) {
  const wrapRef = useRef(null);
  const canvasRef = useRef(null);
  const sim = useRef(null);
  const positions = useRef(new Map()); // posiciones entre reconstrucciones
  const view = useRef({ x: 0, y: 0, k: 1 });
  const hover = useRef(null);
  const drag = useRef(null);
  const reveal = useRef(null); // animación: cuántos nodos se ven
  const [showSettings, setShowSettings] = useState(false);
  const [menu, setMenu] = useState(null); // menú contextual { x, y, node }
  const graph = useMemo(() => buildGraph(data, settings, { focusId }), [data, settings, focusId]);
  const graphRef = useRef(graph);
  graphRef.current = graph;
  const settingsRef = useRef(settings);
  settingsRef.current = settings;
  const frame = useRef(0);
  const touched = useRef(false); // si el usuario ya movió la vista, no se reencuadra

  // Encuadra todos los nodos en la vista
  const fitAll = () => {
    const { nodes } = graphRef.current;
    const canvas = canvasRef.current;
    if (!nodes.length || !canvas) return;
    const dpr = window.devicePixelRatio || 1;
    const w = canvas.width / dpr;
    const h = canvas.height / dpr;
    let x1 = Infinity;
    let y1 = Infinity;
    let x2 = -Infinity;
    let y2 = -Infinity;
    for (const n of nodes) {
      x1 = Math.min(x1, n.x - n.r);
      y1 = Math.min(y1, n.y - n.r);
      x2 = Math.max(x2, n.x + n.r);
      y2 = Math.max(y2, n.y + n.r);
    }
    const pad = compact ? 30 : 80;
    const k = Math.max(0.15, Math.min(2.5, (w - pad * 2) / Math.max(x2 - x1, 1), (h - pad * 2) / Math.max(y2 - y1, 1)));
    view.current = { k, x: -((x1 + x2) / 2) * k, y: -((y1 + y2) / 2) * k };
    draw();
  };

  const draw = () => {
    cancelAnimationFrame(frame.current);
    frame.current = requestAnimationFrame(paint);
  };

  function paint() {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    const dpr = window.devicePixelRatio || 1;
    const w = canvas.width / dpr;
    const h = canvas.height / dpr;
    const v = view.current;
    const s = settingsRef.current;
    const { nodes, links } = graphRef.current;
    const colors = {
      node: cssVar('--text-dim', '#8c94a5'),
      text: cssVar('--text', '#e8ebf1'),
      line: cssVar('--border-strong', '#2f3542'),
      accent: cssVar('--accent', '#2e6bff'),
      bg: cssVar('--bg', '#0e0f12'),
      tag: '#2ecc8f',
      file: cssVar('--text-faint', '#5c6373'),
      idea: cssVar('--idea', '#ffc53d'),
      canvas: '#9b6bff',
    };
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    ctx.translate(v.x + w / 2, v.y + h / 2);
    ctx.scale(v.k, v.k);

    const hov = hover.current;
    const neighbors = new Set();
    if (hov) {
      neighbors.add(hov.id);
      for (const l of links) {
        if (l.source.id === hov.id) neighbors.add(l.target.id);
        if (l.target.id === hov.id) neighbors.add(l.source.id);
      }
    }
    const visible = (n) => reveal.current == null || n._order < reveal.current;

    // Enlaces
    for (const l of links) {
      if (!visible(l.source) || !visible(l.target)) continue;
      const lit = hov && (l.source.id === hov.id || l.target.id === hov.id);
      ctx.globalAlpha = hov && !lit ? 0.12 : l.type === 'tree' ? 0.45 : 0.75;
      ctx.strokeStyle = lit ? colors.accent : colors.line;
      ctx.lineWidth = (lit ? 1.6 : 1) * s.linkThickness / Math.sqrt(v.k);
      ctx.setLineDash(l.type === 'tree' ? [3 / v.k, 3 / v.k] : []);
      ctx.beginPath();
      ctx.moveTo(l.source.x, l.source.y);
      ctx.lineTo(l.target.x, l.target.y);
      ctx.stroke();
      if (s.arrows && l.type === 'link') {
        const ang = Math.atan2(l.target.y - l.source.y, l.target.x - l.source.x);
        const tx = l.target.x - Math.cos(ang) * (l.target.r + 1.5);
        const ty = l.target.y - Math.sin(ang) * (l.target.r + 1.5);
        const sz = 5 * s.linkThickness;
        ctx.setLineDash([]);
        ctx.fillStyle = ctx.strokeStyle;
        ctx.beginPath();
        ctx.moveTo(tx, ty);
        ctx.lineTo(tx - Math.cos(ang - 0.45) * sz, ty - Math.sin(ang - 0.45) * sz);
        ctx.lineTo(tx - Math.cos(ang + 0.45) * sz, ty - Math.sin(ang + 0.45) * sz);
        ctx.closePath();
        ctx.fill();
      }
    }
    ctx.setLineDash([]);

    // Nodos
    for (const n of nodes) {
      if (!visible(n)) continue;
      const lit = !hov || neighbors.has(n.id);
      ctx.globalAlpha = lit ? 1 : 0.18;
      const base =
        n.color ||
        (n.kind === 'tag' ? colors.tag : n.kind === 'file' ? colors.file : n.kind === 'canvas' ? colors.canvas : n.kind === 'idea' ? colors.idea : colors.node);
      ctx.fillStyle = n.id === focusId || (hov && n.id === hov.id) ? colors.accent : base;
      ctx.beginPath();
      if (n.kind === 'file') ctx.rect(n.x - n.r, n.y - n.r, n.r * 2, n.r * 2);
      else if (n.kind === 'idea') {
        // rombo: una idea es distinta de una página
        const r = n.r * 1.25;
        ctx.moveTo(n.x, n.y - r);
        ctx.lineTo(n.x + r, n.y);
        ctx.lineTo(n.x, n.y + r);
        ctx.lineTo(n.x - r, n.y);
        ctx.closePath();
      } else ctx.arc(n.x, n.y, n.r, 0, Math.PI * 2);
      ctx.fill();
      if (n.id === focusId) {
        ctx.strokeStyle = colors.accent;
        ctx.lineWidth = 2 / v.k;
        ctx.beginPath();
        ctx.arc(n.x, n.y, n.r + 3 / v.k, 0, Math.PI * 2);
        ctx.stroke();
      }
    }

    // Títulos: aparecen al acercarse (umbral de texto) y siempre para lo resaltado
    const fade = Math.max(0, Math.min(1, (v.k - s.textFade) / 0.35));
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    ctx.font = `500 ${12 / Math.max(v.k, 0.6)}px Inter Variable, Inter, system-ui, sans-serif`;
    for (const n of nodes) {
      if (!visible(n)) continue;
      const strong = (hov && neighbors.has(n.id)) || n.id === focusId;
      const a = strong ? 1 : hov ? fade * 0.15 : fade;
      if (a <= 0.02) continue;
      ctx.globalAlpha = a;
      ctx.fillStyle = colors.text;
      const label = n.label.length > 40 ? n.label.slice(0, 38) + '…' : n.label;
      ctx.fillText(label, n.x, n.y + n.r + 4 / v.k);
    }
    ctx.globalAlpha = 1;
  }

  // Tamaño del lienzo
  useEffect(() => {
    const wrap = wrapRef.current;
    const canvas = canvasRef.current;
    if (!wrap || !canvas) return undefined;
    const resize = () => {
      const r = wrap.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      canvas.width = Math.max(1, r.width * dpr);
      canvas.height = Math.max(1, r.height * dpr);
      canvas.style.width = `${r.width}px`;
      canvas.style.height = `${r.height}px`;
      draw();
    };
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(wrap);
    // el tema cambia los colores
    const mo = new MutationObserver(draw);
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    return () => {
      ro.disconnect();
      mo.disconnect();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Simulación de fuerzas
  useEffect(() => {
    const { nodes, links } = graph;
    const order = [...nodes].sort((a, b) => (a.created || '').localeCompare(b.created || ''));
    order.forEach((n, i) => (n._order = i));
    for (const n of nodes) {
      const p = positions.current.get(n.id);
      if (p) {
        n.x = p.x;
        n.y = p.y;
      }
    }
    const s = settings;
    sim.current?.stop();
    const simulation = forceSimulation(nodes)
      .force('link', forceLink(links).id((d) => d.id).distance(s.linkDistance).strength(s.linkForce))
      .force('charge', forceManyBody().strength(-s.repelForce).distanceMax(900))
      .force('x', forceX(0).strength(s.centerForce))
      .force('y', forceY(0).strength(s.centerForce))
      .force('collide', forceCollide((d) => d.r + 3))
      .alpha(positions.current.size ? 0.5 : 1)
      .on('tick', () => {
        for (const n of nodes) positions.current.set(n.id, { x: n.x, y: n.y });
        // mientras se asienta, encuadrado automático (hasta que el usuario mueva la vista)
        if (!touched.current && simulation.alpha() > 0.05) fitAll();
        else draw();
      });
    sim.current = simulation;
    draw();
    return () => simulation.stop();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [graph]);

  // ---------- Interacción ----------

  const toWorld = (clientX, clientY) => {
    const r = canvasRef.current.getBoundingClientRect();
    const v = view.current;
    return { x: (clientX - r.left - r.width / 2 - v.x) / v.k, y: (clientY - r.top - r.height / 2 - v.y) / v.k };
  };

  const nodeAt = (clientX, clientY) => {
    const p = toWorld(clientX, clientY);
    const { nodes } = graphRef.current;
    for (let i = nodes.length - 1; i >= 0; i--) {
      const n = nodes[i];
      const hit = n.r + 4 / view.current.k;
      if ((n.x - p.x) ** 2 + (n.y - p.y) ** 2 <= hit * hit) return n;
    }
    return null;
  };

  const zoomBy = (factor, clientX, clientY) => {
    const r = canvasRef.current.getBoundingClientRect();
    const v = view.current;
    const k = Math.min(6, Math.max(0.08, v.k * factor));
    const px = (clientX ?? r.left + r.width / 2) - r.left - r.width / 2;
    const py = (clientY ?? r.top + r.height / 2) - r.top - r.height / 2;
    view.current = { k, x: px - ((px - v.x) / v.k) * k, y: py - ((py - v.y) / v.k) * k };
    touched.current = true;
    draw();
  };

  useEffect(() => {
    const el = canvasRef.current;
    const onWheel = (e) => {
      e.preventDefault();
      zoomBy(Math.exp(-e.deltaY * 0.0015), e.clientX, e.clientY);
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const onPointerDown = (e) => {
    if (e.button !== 0) return;
    setMenu(null);
    canvasRef.current.focus({ preventScroll: true });
    const n = nodeAt(e.clientX, e.clientY);
    drag.current = { node: n, cx: e.clientX, cy: e.clientY, view: view.current, moved: false };
    if (n) {
      n.fx = n.x;
      n.fy = n.y;
      sim.current?.alphaTarget(0.25).restart();
    }
    canvasRef.current.setPointerCapture(e.pointerId);
  };

  const onPointerMove = (e) => {
    const d = drag.current;
    if (d) {
      if (Math.hypot(e.clientX - d.cx, e.clientY - d.cy) > 3) d.moved = true;
      if (d.node) {
        const p = toWorld(e.clientX, e.clientY);
        d.node.fx = p.x;
        d.node.fy = p.y;
      } else {
        view.current = { ...d.view, x: d.view.x + e.clientX - d.cx, y: d.view.y + e.clientY - d.cy };
        touched.current = true;
        draw();
      }
      return;
    }
    const n = nodeAt(e.clientX, e.clientY);
    if (n !== hover.current) {
      hover.current = n;
      canvasRef.current.style.cursor = n ? 'pointer' : 'grab';
      draw();
    }
  };

  const onPointerUp = (e) => {
    const d = drag.current;
    drag.current = null;
    if (!d) return;
    if (d.node) {
      d.node.fx = null;
      d.node.fy = null;
      sim.current?.alphaTarget(0);
      if (!d.moved) openNode(d.node, e.ctrlKey || e.metaKey);
    }
  };

  const openNode = (n, newTab) => {
    if (n.kind === 'tag') {
      onSettings({ ...settings, search: n.label });
      return;
    }
    const id = n.kind === 'file' ? n.file.page_id : n.id;
    onOpen?.(id, newTab);
  };

  const onKeyDown = (e) => {
    if (e.target.closest?.('input')) return;
    const step = e.shiftKey ? 120 : 40;
    const v = view.current;
    const moves = { ArrowLeft: [step, 0], ArrowRight: [-step, 0], ArrowUp: [0, step], ArrowDown: [0, -step] };
    if (moves[e.key]) {
      e.preventDefault();
      view.current = { ...v, x: v.x + moves[e.key][0], y: v.y + moves[e.key][1] };
      touched.current = true;
      draw();
    } else if (e.key === '+' || e.key === '=') zoomBy(e.shiftKey ? 1.5 : 1.2);
    else if (e.key === '-') zoomBy(e.shiftKey ? 1 / 1.5 : 1 / 1.2);
  };

  // Animación: los nodos aparecen en el orden en que se crearon
  const animate = () => {
    const total = graph.nodes.length;
    reveal.current = 0;
    const started = performance.now();
    const step = () => {
      const t = (performance.now() - started) / 4000;
      reveal.current = Math.min(total, Math.ceil(t * total));
      draw();
      if (reveal.current < total) requestAnimationFrame(step);
      else reveal.current = null;
    };
    requestAnimationFrame(step);
  };

  return (
    <div className={'graph-wrap' + (compact ? ' is-compact' : '')} ref={wrapRef}>
      <canvas
        ref={canvasRef}
        className="graph-canvas"
        tabIndex={0}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerLeave={() => {
          if (!drag.current && hover.current) {
            hover.current = null;
            draw();
          }
        }}
        onKeyDown={onKeyDown}
        onContextMenu={(e) => {
          const n = nodeAt(e.clientX, e.clientY);
          if (!n || n.kind === 'tag') return;
          e.preventDefault();
          const r = wrapRef.current.getBoundingClientRect();
          setMenu({ x: e.clientX - r.left, y: e.clientY - r.top, node: n });
        }}
      />
      <div className="graph-info">
        {graph.nodes.length} nodos · {graph.links.length} enlaces
      </div>
      <button className="graph-gear icon-btn" title="Ajustes del grafo" onClick={() => setShowSettings(!showSettings)}>
        <Settings2 size={16} />
      </button>
      {showSettings && (
        <GraphSettings
          settings={settings}
          onChange={onSettings}
          local={!!focusId}
          onAnimate={animate}
          onClose={() => setShowSettings(false)}
        />
      )}
      {menu && (
        <div className="graph-menu" style={{ left: menu.x, top: menu.y }} onMouseLeave={() => setMenu(null)}>
          <button onClick={() => (setMenu(null), openNode(menu.node, false))}>Abrir</button>
          <button onClick={() => (setMenu(null), openNode(menu.node, true))}>Abrir en pestaña nueva</button>
          {menu.node.kind !== 'file' && (
            <button onClick={() => (setMenu(null), onOpen?.(menu.node.id, false, 'local'))}>Ver su grafo local</button>
          )}
        </div>
      )}
      {!graph.nodes.length && <div className="graph-empty">Nada que mostrar con estos filtros</div>}
    </div>
  );
}

export function readGraphSettings(key) {
  try {
    return { ...DEFAULTS, ...JSON.parse(localStorage.getItem(key) || '{}') };
  } catch {
    return { ...DEFAULTS };
  }
}

export function saveGraphSettings(key, s) {
  try {
    localStorage.setItem(key, JSON.stringify(s));
  } catch {}
}
