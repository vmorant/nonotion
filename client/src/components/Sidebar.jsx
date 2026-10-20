import { useState } from 'react';
import { NavLink, useNavigate } from 'react-router-dom';
import { api } from '../api.js';

function TreeItem({ page, index, childrenMap, depth, onCreate, onDelete, onDuplicate, onMove, onFavorite }) {
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
            onClick={() => {
              setMenuOpen(false);
              onFavorite(page.id, !page.favorite_at);
            }}
          >
            {page.favorite_at ? 'Quitar de favoritas' : 'Añadir a favoritas'}
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
            onFavorite={onFavorite}
          />
        ))}
    </div>
  );
}

// Sección plegable de accesos rápidos (Favoritas, Recientes); se recuerda si está plegada
function QuickSection({ name, title, items, byId }) {
  const storeKey = `nn:sec:${name}`;
  const [open, setOpen] = useState(() => {
    try {
      return localStorage.getItem(storeKey) !== 'closed';
    } catch {
      return true;
    }
  });
  if (!items.length) return null;
  const toggle = () => {
    setOpen(!open);
    try {
      localStorage.setItem(storeKey, open ? 'closed' : 'open');
    } catch {}
  };
  return (
    <div className="sidebar-section quick-section">
      <button className="sidebar-section-title quick-title" onClick={toggle}>
        <span>
          {open ? '▾' : '▸'} {title}
        </span>
      </button>
      {open &&
        items.map((p) => {
          const parent = p.parent_id ? byId.get(p.parent_id) : null;
          return (
            <NavLink
              key={p.id}
              to={`/p/${p.id}`}
              className={({ isActive }) => 'tree-item quick-item' + (isActive ? ' active' : '')}
              title={parent ? `${parent.title || 'Sin título'} / ${p.title || 'Sin título'}` : p.title}
            >
              <span className="tree-icon">{p.icon || '📄'}</span>
              <span className="tree-title">{p.title || 'Sin título'}</span>
              {parent && <span className="quick-parent">{parent.title || 'Sin título'}</span>}
            </NavLink>
          );
        })}
    </div>
  );
}

const RECENT_SHOWN = 5;

export default function Sidebar({ pages, recent = [], me, onCreate, onDelete, onDuplicate, onMove, onFavorite, onSearch, onCollapse, onOpenTrash }) {
  const byId = new Map(pages.map((p) => [p.id, p]));
  const favorites = pages.filter((p) => p.favorite_at).sort((a, b) => a.favorite_at.localeCompare(b.favorite_at));
  const recentPages = recent.map((id) => byId.get(id)).filter(Boolean).slice(0, RECENT_SHOWN);

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
      <div className="sidebar-scroll">
      <QuickSection name="favorites" title="Favoritas" items={favorites} byId={byId} />
      <QuickSection name="recent" title="Recientes" items={recentPages} byId={byId} />
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
              onFavorite={onFavorite}
            />
          ))}
        </div>
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
        {me?.user ? (
          <div className="sidebar-user">
            {me.user.avatar_url && <img src={me.user.avatar_url} alt="" className="sidebar-avatar" />}
            <span className="sidebar-login" title="Sesión iniciada con GitHub">
              {me.user.login}
            </span>
            <button
              className="icon-btn"
              title="Cerrar sesión"
              onClick={async () => {
                try {
                  await api.logout();
                } catch {}
                window.location.href = '/login';
              }}
            >
              Salir
            </button>
          </div>
        ) : me?.email ? (
          <span title="Sesión de Cloudflare Access">👤 {me.email}</span>
        ) : (
          <span>Acceso local</span>
        )}
      </div>
    </aside>
  );
}
