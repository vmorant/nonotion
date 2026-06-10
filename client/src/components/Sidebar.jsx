import { useState } from 'react';
import { NavLink, useNavigate } from 'react-router-dom';

function TreeItem({ page, index, childrenMap, depth, onCreate, onDelete, onDuplicate, onMove }) {
  const [open, setOpen] = useState(depth < 1);
  const [menuOpen, setMenuOpen] = useState(false);
  const [dropZone, setDropZone] = useState(null); // 'before' | 'inside' | 'after'
  const kids = childrenMap.get(page.id) || [];
  const navigate = useNavigate();

  const zoneFromEvent = (e) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const y = (e.clientY - rect.top) / rect.height;
    if (y < 0.25) return 'before';
    if (y > 0.75) return 'after';
    return 'inside';
  };

  const handleDrop = (e) => {
    e.preventDefault();
    e.stopPropagation();
    const draggedId = e.dataTransfer.getData('text/nonotion-page');
    const zone = dropZone;
    setDropZone(null);
    if (!draggedId || draggedId === page.id) return;
    if (zone === 'inside') {
      onMove(draggedId, page.id, kids.length);
      setOpen(true);
    } else {
      onMove(draggedId, page.parent_id, zone === 'before' ? index : index + 1);
    }
  };

  return (
    <div>
      <NavLink
        to={`/p/${page.id}`}
        className={({ isActive }) =>
          'tree-item' + (isActive ? ' active' : '') + (dropZone ? ` drop-${dropZone}` : '')
        }
        style={{ paddingLeft: 8 + depth * 14 }}
        draggable
        onDragStart={(e) => {
          e.dataTransfer.setData('text/nonotion-page', page.id);
          e.dataTransfer.effectAllowed = 'move';
        }}
        onDragOver={(e) => {
          if (!e.dataTransfer.types.includes('text/nonotion-page')) return;
          e.preventDefault();
          e.stopPropagation();
          setDropZone(zoneFromEvent(e));
        }}
        onDragLeave={() => setDropZone(null)}
        onDrop={handleDrop}
      >
        <button
          className="tree-toggle"
          onClick={(e) => {
            e.preventDefault();
            setOpen((v) => !v);
          }}
        >
          {kids.length > 0 ? (open ? '▾' : '▸') : '·'}
        </button>
        <span className="tree-icon">{page.icon || '📄'}</span>
        <span className="tree-title">{page.title || 'Sin título'}</span>
        {page.shared ? <span className="tree-shared" title="Compartida públicamente">🔗</span> : null}
        <span className="tree-actions" onClick={(e) => e.preventDefault()}>
          <button
            title="Añadir subpágina"
            onClick={(e) => {
              e.preventDefault();
              onCreate(page.id);
            }}
          >
            +
          </button>
          <button
            title="Más opciones"
            onClick={(e) => {
              e.preventDefault();
              setMenuOpen((v) => !v);
            }}
          >
            ⋯
          </button>
        </span>
      </NavLink>
      {menuOpen && (
        <div className="tree-menu" onMouseLeave={() => setMenuOpen(false)}>
          <button
            onClick={() => {
              setMenuOpen(false);
              navigate(`/p/${page.id}`);
            }}
          >
            Abrir
          </button>
          <button
            onClick={() => {
              setMenuOpen(false);
              onCreate(page.id);
            }}
          >
            Añadir subpágina
          </button>
          <button
            onClick={() => {
              setMenuOpen(false);
              onDuplicate(page.id);
            }}
          >
            Duplicar
          </button>
          <button
            className="danger"
            onClick={() => {
              setMenuOpen(false);
              onDelete(page.id);
            }}
          >
            Mover a la papelera
          </button>
        </div>
      )}
      {open &&
        kids.map((k, i) => (
          <TreeItem
            key={k.id}
            page={k}
            index={i}
            childrenMap={childrenMap}
            depth={depth + 1}
            onCreate={onCreate}
            onDelete={onDelete}
            onDuplicate={onDuplicate}
            onMove={onMove}
          />
        ))}
    </div>
  );
}

export default function Sidebar({ pages, me, onCreate, onDelete, onDuplicate, onMove, onSearch, onCollapse, onOpenTrash }) {
  const childrenMap = new Map();
  for (const p of pages) {
    const key = p.parent_id || null;
    if (!childrenMap.has(key)) childrenMap.set(key, []);
    childrenMap.get(key).push(p);
  }
  const roots = childrenMap.get(null) || [];

  return (
    <aside className="sidebar">
      <div className="sidebar-header">
        <span className="logo">🗂️ NoNotion</span>
        <button className="icon-btn" onClick={onCollapse} title="Ocultar barra lateral">
          «
        </button>
      </div>
      <button className="sidebar-search" onClick={onSearch}>
        🔍 Buscar <kbd>Ctrl+K</kbd>
      </button>
      <div className="sidebar-section">
        <div className="sidebar-section-title">
          <span>Páginas</span>
          <button className="icon-btn" onClick={() => onCreate(null)} title="Nueva página">
            +
          </button>
        </div>
        <div
          className="tree"
          onDragOver={(e) => {
            if (e.dataTransfer.types.includes('text/nonotion-page')) e.preventDefault();
          }}
          onDrop={(e) => {
            // Soltar en el espacio vacío del árbol = mover al final de la raíz
            const draggedId = e.dataTransfer.getData('text/nonotion-page');
            if (draggedId) onMove(draggedId, null, roots.length);
          }}
        >
          {roots.length === 0 && <div className="tree-empty">Sin páginas todavía</div>}
          {roots.map((p, i) => (
            <TreeItem
              key={p.id}
              page={p}
              index={i}
              childrenMap={childrenMap}
              depth={0}
              onCreate={onCreate}
              onDelete={onDelete}
              onDuplicate={onDuplicate}
              onMove={onMove}
            />
          ))}
        </div>
      </div>
      <div className="sidebar-tools">
        <NavLink to="/calendar" className={({ isActive }) => 'sidebar-tool-link' + (isActive ? ' active' : '')}>
          📅 Calendario
        </NavLink>
        <button onClick={onOpenTrash}>🗑 Papelera</button>
        <button onClick={() => window.open('/api/export')} title="Descargar todo el workspace como Markdown + archivos">
          ⬇ Exportar todo
        </button>
      </div>
      <div className="sidebar-footer">
        {me?.email ? <span title="Sesión de Cloudflare Access">👤 {me.email}</span> : <span>Acceso local</span>}
      </div>
    </aside>
  );
}
