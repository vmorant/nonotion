import { useEffect, useMemo, useRef, useState } from 'react';

// "Mover a…": elegir el nuevo padre de una página (o la raíz del espacio).
// Usa el mismo endpoint que arrastrar en el árbol y que el MCP (move_page).

const fold = (s) => (s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

export default function MoveDialog({ page, pages, onMove, onClose }) {
  const [q, setQ] = useState('');
  const [sel, setSel] = useState(0);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const inputRef = useRef(null);

  // Destinos posibles: todas las páginas menos ella misma y sus subpáginas
  const options = useMemo(() => {
    const byId = new Map(pages.map((p) => [p.id, p]));
    const kids = new Map();
    for (const p of pages) {
      const k = p.parent_id || null;
      if (!kids.has(k)) kids.set(k, []);
      kids.get(k).push(p.id);
    }
    const excluded = new Set();
    const stack = [page.id];
    while (stack.length) {
      const id = stack.pop();
      excluded.add(id);
      stack.push(...(kids.get(id) || []));
    }
    const pathOf = (p) => {
      const parts = [];
      for (let cur = p, n = 0; cur && n < 50; cur = cur.parent_id ? byId.get(cur.parent_id) : null, n++) {
        parts.unshift(cur.title || 'Sin título');
      }
      return parts.join(' / ');
    };
    const list = pages
      .filter((p) => !excluded.has(p.id))
      .map((p) => ({ id: p.id, icon: p.icon || '📄', path: pathOf(p), current: p.id === page.parent_id }));
    list.sort((a, b) => a.path.localeCompare(b.path, 'es'));
    return [{ id: null, icon: '↥', path: 'Raíz del espacio', current: !page.parent_id }, ...list];
  }, [page, pages]);

  const shown = q.trim() ? options.filter((o) => fold(o.path).includes(fold(q.trim()))) : options;

  useEffect(() => {
    inputRef.current?.focus();
  }, []);
  useEffect(() => setSel(0), [q]);

  const pick = async (o) => {
    if (!o || busy) return;
    setBusy(true);
    setError(null);
    const err = await onMove(page.id, o.id);
    setBusy(false);
    if (err) setError(err);
    else onClose();
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        className="search-modal move-modal"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === 'Escape') onClose();
          if (e.key === 'ArrowDown') {
            e.preventDefault();
            setSel((s) => Math.min(s + 1, shown.length - 1));
          }
          if (e.key === 'ArrowUp') {
            e.preventDefault();
            setSel((s) => Math.max(s - 1, 0));
          }
          if (e.key === 'Enter') pick(shown[sel]);
        }}
      >
        <div className="move-title">
          Mover «{page.title || 'Sin título'}» (con sus subpáginas) a…
        </div>
        <input ref={inputRef} value={q} onChange={(e) => setQ(e.target.value)} placeholder="Buscar página destino…" />
        {error && <div className="ws-error">⚠ {error}</div>}
        <div className="search-results">
          {shown.map((o, i) => (
            <button
              key={o.id || 'root'}
              className={'search-result' + (i === sel ? ' selected' : '')}
              onMouseEnter={() => setSel(i)}
              onClick={() => pick(o)}
              disabled={busy}
            >
              <span className="result-title">
                {o.icon} {o.path}
                {o.current && <span className="move-current"> · actual</span>}
              </span>
            </button>
          ))}
          {!shown.length && <div className="search-empty">Sin resultados</div>}
        </div>
      </div>
    </div>
  );
}
