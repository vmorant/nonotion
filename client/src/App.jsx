import { useCallback, useEffect, useRef, useState } from 'react';
import { Routes, Route, useNavigate, useLocation } from 'react-router-dom';
import {
  api,
  hasUnsavedWork,
  readRecent,
  pushRecent,
  setCurrentWorkspace,
  readStoredWorkspace,
  storeWorkspace,
} from './api.js';
import Sidebar from './components/Sidebar.jsx';
import PageView from './components/PageView.jsx';
import SearchModal from './components/SearchModal.jsx';
import TrashModal from './components/TrashModal.jsx';
import CalendarView from './components/CalendarView.jsx';
import TagsView from './components/TagsView.jsx';
import FileViewer from './components/FileViewer.jsx';
import WebPreview from './components/WebPreview.jsx';
import WorkspaceSettings from './components/WorkspaceSettings.jsx';
import NewWorkspaceDialog from './components/NewWorkspaceDialog.jsx';
import { LogoMark, Wordmark } from './components/Logo.jsx';
import { PanelLeftOpen } from 'lucide-react';
import GraphPage from './components/graph/GraphPage.jsx';
import IdeasView from './components/ideas/IdeasView.jsx';
import IssuesView from './components/issues/IssuesView.jsx';

export default function App() {
  const [pages, setPages] = useState([]);
  const [me, setMe] = useState(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const [trashOpen, setTrashOpen] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [pageEvent, setPageEvent] = useState(null); // { id, n } cuando una página cambia en remoto
  const [recent, setRecent] = useState(readRecent);
  const [tags, setTags] = useState([]);
  const [viewing, setViewing] = useState(null); // adjunto abierto en el visor (desde enlaces o imágenes)
  const [previewing, setPreviewing] = useState(null); // web externa en vista previa
  const [workspaces, setWorkspaces] = useState(null); // null = cargando
  const [owner, setOwner] = useState(false); // propietario de la instancia
  const [ws, setWs] = useState(null); // espacio actual
  const [wsSettings, setWsSettings] = useState(false);
  const [wsNew, setWsNew] = useState(false); // diálogo de nuevo espacio
  const [members, setMembers] = useState([]); // responsables sugeridos en Seguimiento
  const wsRef = useRef(null); // espacio actual, también para la cabecera X-Workspace de api.js
  const wantedWsRef = useRef(null); // espacio de una página abierta antes de cargar la lista
  const navigate = useNavigate();
  const location = useLocation();

  const refreshTree = useCallback(async () => {
    const [p, t] = await Promise.all([api.pages(), api.tags().catch(() => null)]);
    setPages(p);
    if (t) setTags(t);
  }, []);

  // Espacios a los que tengo acceso; se queda en el guardado si sigue disponible
  const loadWorkspaces = useCallback(async () => {
    const r = await api.workspaces();
    setWorkspaces(r.workspaces);
    setOwner(r.owner);
    const ids = r.workspaces.map((w) => w.id);
    const cur = wsRef.current;
    const wanted = wantedWsRef.current;
    wantedWsRef.current = null;
    const stored = readStoredWorkspace();
    const next = ids.includes(wanted) ? wanted : ids.includes(cur) ? cur : ids.includes(stored) ? stored : ids[0] || null;
    wsRef.current = next;
    setCurrentWorkspace(next);
    if (next) storeWorkspace(next);
    setWs(next);
    return r.workspaces;
  }, []);

  const switchWorkspace = useCallback(
    (id, { stay = false } = {}) => {
      if (!id) return;
      wsRef.current = id;
      setCurrentWorkspace(id);
      storeWorkspace(id);
      setWs(id);
      setPages([]);
      setTags([]);
      if (!stay) navigate('/');
    },
    [navigate]
  );

  // Al abrir una página de otro espacio (enlace, historial), se cambia a ese espacio
  const onWorkspaceSeen = useCallback(
    (id) => {
      if (!id || id === wsRef.current) return;
      if (!workspaces) wantedWsRef.current = id; // la lista aún no ha llegado
      else if (workspaces.some((w) => w.id === id)) switchWorkspace(id, { stay: true });
    },
    [workspaces, switchWorkspace]
  );

  // Diálogo propio (window.prompt no se muestra en apps instaladas ni en algunos móviles)
  const createWorkspace = async (data) => {
    const created = await api.createWorkspace(data);
    setWsNew(false);
    await loadWorkspaces();
    switchWorkspace(created.id);
    setWsSettings(true);
  };

  // Enlaces a adjuntos e imágenes → visor; webs externas → vista previa
  useEffect(() => {
    const onView = (e) => setViewing(e.detail);
    const onPreview = (e) => setPreviewing(e.detail);
    document.addEventListener('nonotion:view-file', onView);
    document.addEventListener('nonotion:preview-url', onPreview);
    return () => {
      document.removeEventListener('nonotion:view-file', onView);
      document.removeEventListener('nonotion:preview-url', onPreview);
    };
  }, []);

  useEffect(() => {
    loadWorkspaces().catch(() => setWorkspaces([]));
    api.me().then(setMe).catch(() => {});
  }, [loadWorkspaces]);

  useEffect(() => {
    if (ws) refreshTree();
  }, [ws, refreshTree]);

  // Personas del espacio (propietarios y miembros de GitHub) para sugerir responsables
  useEffect(() => {
    if (!ws) return;
    let cancelled = false;
    api
      .members(ws)
      .then((m) => !cancelled && setMembers([...new Set([...(m.owners || []), ...(m.members || []).map((x) => x.github_login)])]))
      .catch(() => !cancelled && setMembers([]));
    return () => {
      cancelled = true;
    };
  }, [ws]);

  // Si hay cambios sin confirmar o subidas en curso, el navegador avisa antes
  // de cerrar o recargar la pestaña
  useEffect(() => {
    const onBeforeUnload = (e) => {
      if (!hasUnsavedWork()) return;
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, []);

  // Sincronización en vivo: el servidor avisa cuando cambia algo (otra persona o el MCP)
  useEffect(() => {
    if (!ws) return undefined;
    const es = new EventSource(api.eventsUrl());
    let treeTimer;
    let counter = 0;
    es.onmessage = (e) => {
      let msg;
      try {
        msg = JSON.parse(e.data);
      } catch {
        return;
      }
      if (msg.type === 'tree') {
        clearTimeout(treeTimer);
        treeTimer = setTimeout(() => refreshTree(), 800); // agrupa ráfagas (p. ej. al teclear un título)
      } else if (msg.type === 'page') {
        setPageEvent({ id: msg.id, n: ++counter });
      } else if (msg.type === 'workspaces') {
        loadWorkspaces().catch(() => {});
      }
    };
    return () => {
      clearTimeout(treeTimer);
      es.close();
    };
  }, [ws, refreshTree, loadWorkspaces]);

  // Recientes: las páginas que se abren en este navegador
  useEffect(() => {
    const m = location.pathname.match(/^\/p\/([^/]+)/);
    if (m) setRecent(pushRecent(m[1]));
  }, [location.pathname]);

  useEffect(() => {
    const onKey = (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setSearchOpen((v) => !v);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const createPage = async (parentId = null, kind = 'doc') => {
    if (kind === 'tracker') {
      // lista de seguimiento: plantilla de bloqueos (se cambia en ⚙ Campos)
      const t = await api.createTracker({ parent_id: parentId, template: 'blockers', title: 'Seguimiento' });
      await refreshTree();
      navigate(`/p/${t.id}`);
      return;
    }
    const page = await api.createPage({ parent_id: parentId, ...(kind === 'canvas' ? { kind, icon: '🧩', title: 'Canvas' } : {}) });
    await refreshTree();
    navigate(`/p/${page.id}`);
  };

  const deletePage = async (id) => {
    await api.deletePage(id);
    await refreshTree();
    if (location.pathname.includes(id)) navigate('/');
  };

  const duplicatePage = async (id) => {
    const copy = await api.duplicatePage(id);
    await refreshTree();
    navigate(`/p/${copy.id}`);
  };

  const setFavorite = async (id, favorite) => {
    await api.pagePrefs(id, { favorite });
    await refreshTree();
  };

  // Arrastrar en el árbol y "Mover a…": devuelve el error (o null) para mostrarlo
  const movePage = async (id, parentId, index) => {
    let error = null;
    try {
      await api.movePage(id, parentId, index);
    } catch (e) {
      error = e.message; // p. ej. soltar un padre dentro de su hijo: el árbol no cambia
    }
    await refreshTree();
    return error;
  };

  return (
    <div className="app">
      {sidebarOpen && (
        <Sidebar
          workspaces={workspaces || []}
          currentWs={ws}
          owner={owner}
          onSwitchWorkspace={switchWorkspace}
          onWorkspaceSettings={() => setWsSettings(true)}
          onCreateWorkspace={() => setWsNew(true)}
          pages={pages}
          recent={recent}
          me={me}
          onFavorite={setFavorite}
          onCreate={createPage}
          onDelete={deletePage}
          onDuplicate={duplicatePage}
          onMove={movePage}
          onSearch={() => setSearchOpen(true)}
          onCollapse={() => setSidebarOpen(false)}
          onOpenTrash={() => setTrashOpen(true)}
        />
      )}
      <main className="main">
        {!sidebarOpen && (
          <button className="sidebar-reopen" onClick={() => setSidebarOpen(true)} title="Abrir barra lateral">
            <PanelLeftOpen size={18} strokeWidth={1.8} />
          </button>
        )}
        <Routes>
          <Route
            path="/p/:id"
            element={
              <PageView
                pages={pages}
                pageEvent={pageEvent}
                onTreeChange={refreshTree}
                onDelete={deletePage}
                onCreateChild={createPage}
                onDuplicate={duplicatePage}
                onFavorite={setFavorite}
                onWorkspaceSeen={onWorkspaceSeen}
                allTags={tags}
                members={members}
                onMove={movePage}
              />
            }
          />
          <Route path="/tags" element={<TagsView pages={pages} tags={tags} onChanged={refreshTree} />} />
          <Route path="/calendar" element={<CalendarView onChanged={refreshTree} />} />
          <Route path="/graph" element={<GraphPage pages={pages} />} />
          <Route path="/ideas" element={<IdeasView pages={pages} onChanged={refreshTree} />} />
          <Route path="/issues" element={<IssuesView pages={pages} onChanged={refreshTree} />} />
          <Route
            path="*"
            element={
              workspaces && !workspaces.length ? (
                <div className="empty-state">
                  <h1>Sin espacios</h1>
                  <p>Tu cuenta todavía no tiene acceso a ningún espacio. Pide a quien administra el proyecto que te añada.</p>
                </div>
              ) : (
              <div className="empty-state">
                <div className="empty-brand">
                  <LogoMark size={72} />
                  <Wordmark />
                </div>
                <p>Tu espacio personal de apuntes, respuestas de IA y archivos. Sin límites.</p>
                <ul className="hints">
                  <li>Pega respuestas de Claude en Markdown y se formatean solas.</li>
                  <li>Escribe <kbd>/</kbd> en una página para insertar bloques.</li>
                  <li>Arrastra archivos a una página para adjuntarlos.</li>
                  <li>Pulsa <kbd>Ctrl</kbd>+<kbd>K</kbd> para buscar.</li>
                  <li>Guarda capturas y textos sueltos en <strong>Ideas</strong> y desarróllalos con Claude hasta documentarlos.</li>
                  <li>Envía respuestas desde tu PC de IA con <code>cli/nonotion-send.sh</code>.</li>
                </ul>
                <button className="btn primary" onClick={() => createPage(null)}>
                  + Crear una página
                </button>
              </div>
              )
            }
          />
        </Routes>
      </main>
      {searchOpen && <SearchModal tags={tags} onClose={() => setSearchOpen(false)} />}
      {viewing && <FileViewer file={viewing} onClose={() => setViewing(null)} />}
      {previewing && <WebPreview url={previewing} onClose={() => setPreviewing(null)} />}
      {wsSettings && ws && (
        <WorkspaceSettings
          workspace={workspaces?.find((w) => w.id === ws)}
          owner={owner}
          me={me}
          onChanged={loadWorkspaces}
          onDeleted={async () => {
            setWsSettings(false);
            const list = await loadWorkspaces();
            switchWorkspace(list[0]?.id);
          }}
          onClose={() => setWsSettings(false)}
        />
      )}
      {trashOpen && <TrashModal onClose={() => setTrashOpen(false)} onChanged={refreshTree} />}
      {wsNew && <NewWorkspaceDialog onCreate={createWorkspace} onClose={() => setWsNew(false)} />}
    </div>
  );
}
