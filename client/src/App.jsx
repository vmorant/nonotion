import { useCallback, useEffect, useState } from 'react';
import { Routes, Route, useNavigate, useLocation } from 'react-router-dom';
import { api, CLIENT_ID, hasUnsavedWork, readRecent, pushRecent } from './api.js';
import Sidebar from './components/Sidebar.jsx';
import PageView from './components/PageView.jsx';
import SearchModal from './components/SearchModal.jsx';
import TrashModal from './components/TrashModal.jsx';
import CalendarView from './components/CalendarView.jsx';
import TagsView from './components/TagsView.jsx';
import FileViewer from './components/FileViewer.jsx';
import WebPreview from './components/WebPreview.jsx';

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
  const navigate = useNavigate();
  const location = useLocation();

  const refreshTree = useCallback(async () => {
    const [p, t] = await Promise.all([api.pages(), api.tags().catch(() => null)]);
    setPages(p);
    if (t) setTags(t);
  }, []);

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
    refreshTree();
    api.me().then(setMe).catch(() => {});
  }, [refreshTree]);

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
    const es = new EventSource(`/api/events?client=${encodeURIComponent(CLIENT_ID)}`);
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
      }
    };
    return () => {
      clearTimeout(treeTimer);
      es.close();
    };
  }, [refreshTree]);

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

  const createPage = async (parentId = null) => {
    const page = await api.createPage({ parent_id: parentId });
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

  const movePage = async (id, parentId, index) => {
    try {
      await api.movePage(id, parentId, index);
    } catch {
      // movimiento inválido (p. ej. un padre dentro de su hijo): se ignora
    }
    await refreshTree();
  };

  return (
    <div className="app">
      {sidebarOpen && (
        <Sidebar
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
            ☰
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
                allTags={tags}
              />
            }
          />
          <Route path="/tags" element={<TagsView pages={pages} tags={tags} onChanged={refreshTree} />} />
          <Route path="/calendar" element={<CalendarView />} />
          <Route
            path="*"
            element={
              <div className="empty-state">
                <h1>NoNotion</h1>
                <p>Tu espacio personal de apuntes, respuestas de IA y archivos. Sin límites.</p>
                <ul className="hints">
                  <li>Pega respuestas de Claude en Markdown y se formatean solas.</li>
                  <li>Escribe <kbd>/</kbd> en una página para insertar bloques.</li>
                  <li>Arrastra archivos a una página para adjuntarlos.</li>
                  <li>Pulsa <kbd>Ctrl</kbd>+<kbd>K</kbd> para buscar.</li>
                  <li>Envía respuestas desde tu PC de IA con <code>cli/nonotion-send.sh</code>.</li>
                </ul>
                <button className="btn primary" onClick={() => createPage(null)}>
                  + Crear una página
                </button>
              </div>
            }
          />
        </Routes>
      </main>
      {searchOpen && <SearchModal tags={tags} onClose={() => setSearchOpen(false)} />}
      {viewing && <FileViewer file={viewing} onClose={() => setViewing(null)} />}
      {previewing && <WebPreview url={previewing} onClose={() => setPreviewing(null)} />}
      {trashOpen && <TrashModal onClose={() => setTrashOpen(false)} onChanged={refreshTree} />}
    </div>
  );
}
