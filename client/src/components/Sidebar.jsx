import { useState } from 'react';
import { NavLink, useNavigate } from 'react-router-dom';
import { api } from '../api.js';
import MoveDialog from './MoveDialog.jsx';
import { LogoMark } from './Logo.jsx';
import ThemeToggle from './ThemeToggle.jsx';
import {
  ChevronRight,
  Plus,
  MoreHorizontal,
  PanelLeftClose,
  Search,
  CalendarDays,
  Tags,
  Trash2,
  Download,
  Link2,
  ChevronsUpDown,
  LayoutDashboard,
  Waypoints,
  Lightbulb,
} from 'lucide-react';

function TreeItem({ page, index, childrenMap, depth, onCreate, onDelete, onDuplicate, onMove, onFavorite, onMoveTo }) {
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
      // por id de la hermana: el índice visible no coincide con el del servidor
      // (la página arrastrada aún cuenta, y las ideas no se ven en el árbol)
      onMove(draggedId, page.parent_id, zone === 'before' ? { before_id: page.id } : { after_id: page.id });
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
          {kids.length > 0 ? (
            <ChevronRight size={14} strokeWidth={2} className={'tree-chevron' + (open ? ' open' : '')} />
          ) : (
            <span className="tree-dot" />
          )}
        </button>
        <span className="tree-icon">{page.icon || (page.kind === 'canvas' ? '🧩' : '📄')}</span>
        <span className="tree-title">{page.title || 'Sin título'}</span>
        {page.shared ? (
          <span className="tree-shared" title="Compartida públicamente">
            <Link2 size={13} />
          </span>
        ) : null}
        <span className="tree-actions" onClick={(e) => e.preventDefault()}>
          <button
            title="Añadir subpágina"
            onClick={(e) => {
              e.preventDefault();
              onCreate(page.id);
            }}
          >
            <Plus size={14} />
          </button>
          <button
            title="Más opciones"
            onClick={(e) => {
              e.preventDefault();
              setMenuOpen((v) => !v);
            }}
          >
            <MoreHorizontal size={14} />
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
              onCreate(page.id, 'canvas');
            }}
          >
            Añadir canvas dentro
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
              onMoveTo(page);
            }}
          >
            Mover a…
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
      {open && kids.length > 0 && (
        // la guía vertical cae bajo el triángulo del padre
        <div className="tree-children" style={{ '--guide': `${8 + depth * 14 + 9}px` }}>
        {kids.map((k, i) => (
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
            onMoveTo={onMoveTo}
          />
        ))}
        </div>
      )}
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
              <span className="tree-icon">{p.icon || (p.kind === 'canvas' ? '🧩' : '📄')}</span>
              <span className="tree-title">{p.title || 'Sin título'}</span>
              {parent && <span className="quick-parent">{parent.title || 'Sin título'}</span>}
            </NavLink>
          );
        })}
    </div>
  );
}

const RECENT_SHOWN = 5;

// Selector de espacio: cambia entre proyectos (cada uno con sus páginas,
// archivos, etiquetas, miembros y conector de Claude)
function WorkspaceSwitcher({ workspaces, currentWs, owner, onSwitch, onSettings, onCreate }) {
  const [open, setOpen] = useState(false);
  const current = workspaces.find((w) => w.id === currentWs);
  return (
    <div className="ws-switcher">
      <button className="ws-current" onClick={() => setOpen((v) => !v)} title="Cambiar de espacio">
        <span className="ws-icon">{current?.icon || '🗂️'}</span>
        <span className="ws-name">{current?.name || 'NoNotion'}</span>
        <ChevronsUpDown size={14} className="ws-caret" />
      </button>
      {open && (
        <div className="ws-menu" onMouseLeave={() => setOpen(false)}>
          {workspaces.map((w) => (
            <button
              key={w.id}
              className={'ws-item' + (w.id === currentWs ? ' active' : '')}
              onClick={() => {
                setOpen(false);
                if (w.id !== currentWs) onSwitch(w.id);
              }}
            >
              <span className="ws-icon">{w.icon}</span>
              <span className="ws-name">{w.name}</span>
              {w.id === currentWs && <span className="ws-check">✓</span>}
            </button>
          ))}
          <div className="ws-sep" />
          <button
            className="ws-item"
            onClick={() => {
              setOpen(false);
              onSettings();
            }}
          >
            ⚙ Ajustes del espacio{current?.role === 'admin' ? ' y miembros' : ''}
          </button>
          {owner && (
            <button
              className="ws-item"
              onClick={() => {
                setOpen(false);
                onCreate();
              }}
            >
              + Nuevo espacio
            </button>
          )}
        </div>
      )}
    </div>
  );
}

export default function Sidebar({
  workspaces = [],
  currentWs,
  owner,
  onSwitchWorkspace,
  onWorkspaceSettings,
  onCreateWorkspace,
  pages,
  recent = [],
  me,
  onCreate,
  onDelete,
  onDuplicate,
  onMove,
  onFavorite,
  onSearch,
  onCollapse,
  onOpenTrash,
}) {
  const [moving, setMoving] = useState(null); // página con "Mover a…" abierto
  const byId = new Map(pages.map((p) => [p.id, p]));
  const favorites = pages.filter((p) => p.favorite_at).sort((a, b) => a.favorite_at.localeCompare(b.favorite_at));
  const recentPages = recent.map((id) => byId.get(id)).filter(Boolean).slice(0, RECENT_SHOWN);

  // Las ideas viven en su propia vista, no en el árbol
  const ideasCount = pages.filter((p) => p.kind === 'idea').length;
  const childrenMap = new Map();
  for (const p of pages) {
    if (p.kind === 'idea') continue;
    const key = p.parent_id || null;
    if (!childrenMap.has(key)) childrenMap.set(key, []);
    childrenMap.get(key).push(p);
  }
  const roots = childrenMap.get(null) || [];

  return (
    <aside className="sidebar">
      {moving && <MoveDialog page={moving} pages={pages} onMove={onMove} onClose={() => setMoving(null)} />}
      <div className="sidebar-header">
        <LogoMark size={22} />
        <WorkspaceSwitcher
          workspaces={workspaces}
          currentWs={currentWs}
          owner={owner}
          onSwitch={onSwitchWorkspace}
          onSettings={onWorkspaceSettings}
          onCreate={onCreateWorkspace}
        />
        <button className="icon-btn" onClick={onCollapse} title="Ocultar barra lateral">
          <PanelLeftClose size={16} strokeWidth={1.8} />
        </button>
      </div>
      <button className="sidebar-search" onClick={onSearch}>
        <Search size={15} strokeWidth={1.8} /> Buscar <kbd>Ctrl+K</kbd>
      </button>
      <div className="sidebar-scroll">
      <QuickSection name="favorites" title="Favoritas" items={favorites} byId={byId} />
      <QuickSection name="recent" title="Recientes" items={recentPages} byId={byId} />
      <div className="sidebar-section">
        <div className="sidebar-section-title">
          <span>Páginas</span>
          <span className="sidebar-section-actions">
            <button className="icon-btn" onClick={() => onCreate(null, 'canvas')} title="Nuevo canvas">
              <LayoutDashboard size={14} />
            </button>
            <button className="icon-btn" onClick={() => onCreate(null)} title="Nueva página">
              <Plus size={14} />
            </button>
          </span>
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
              onMoveTo={setMoving}
            />
          ))}
        </div>
      </div>
      </div>
      <div className="sidebar-tools">
        <NavLink to="/calendar" className={({ isActive }) => 'sidebar-tool-link' + (isActive ? ' active' : '')}>
          <CalendarDays size={16} strokeWidth={1.8} /> Calendario
        </NavLink>
        <NavLink to="/ideas" className={({ isActive }) => 'sidebar-tool-link' + (isActive ? ' active' : '')}>
          <Lightbulb size={16} strokeWidth={1.8} /> Ideas
          {ideasCount > 0 && <span className="sidebar-count">{ideasCount}</span>}
        </NavLink>
        <NavLink to="/graph" className={({ isActive }) => 'sidebar-tool-link' + (isActive ? ' active' : '')}>
          <Waypoints size={16} strokeWidth={1.8} /> Grafo
        </NavLink>
        <NavLink to="/tags" className={({ isActive }) => 'sidebar-tool-link' + (isActive ? ' active' : '')}>
          <Tags size={16} strokeWidth={1.8} /> Etiquetas
        </NavLink>
        <button onClick={onOpenTrash}>
          <Trash2 size={16} strokeWidth={1.8} /> Papelera
        </button>
        <button onClick={() => window.open(api.exportUrl())} title="Descargar todo este espacio como Markdown + archivos">
          <Download size={16} strokeWidth={1.8} /> Exportar todo
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
        <ThemeToggle />
      </div>
    </aside>
  );
}
