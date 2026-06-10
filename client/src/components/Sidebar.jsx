import { useState } from 'react';
import { NavLink, useNavigate } from 'react-router-dom';

function TreeItem({ page, childrenMap, depth, onCreate, onDelete }) {
  const [open, setOpen] = useState(depth < 1);
  const [menuOpen, setMenuOpen] = useState(false);
  const kids = childrenMap.get(page.id) || [];
  const navigate = useNavigate();

  return (
    <div>
      <NavLink
        to={`/p/${page.id}`}
        className={({ isActive }) => 'tree-item' + (isActive ? ' active' : '')}
        style={{ paddingLeft: 8 + depth * 14 }}
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
            className="danger"
            onClick={() => {
              setMenuOpen(false);
              onDelete(page.id);
            }}
          >
            Eliminar
          </button>
        </div>
      )}
      {open &&
        kids.map((k) => (
          <TreeItem key={k.id} page={k} childrenMap={childrenMap} depth={depth + 1} onCreate={onCreate} onDelete={onDelete} />
        ))}
    </div>
  );
}

export default function Sidebar({ pages, me, onCreate, onDelete, onSearch, onCollapse }) {
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
        <div className="tree">
          {roots.length === 0 && <div className="tree-empty">Sin páginas todavía</div>}
          {roots.map((p) => (
            <TreeItem key={p.id} page={p} childrenMap={childrenMap} depth={0} onCreate={onCreate} onDelete={onDelete} />
          ))}
        </div>
      </div>
      <div className="sidebar-footer">
        {me?.email ? <span title="Sesión de Cloudflare Access">👤 {me.email}</span> : <span>Acceso local</span>}
      </div>
    </aside>
  );
}
