import { useCallback, useEffect, useState } from 'react';
import { Routes, Route, useNavigate } from 'react-router-dom';
import { api } from './api.js';
import Sidebar from './components/Sidebar.jsx';
import PageView from './components/PageView.jsx';
import SearchModal from './components/SearchModal.jsx';

export default function App() {
  const [pages, setPages] = useState([]);
  const [me, setMe] = useState(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const navigate = useNavigate();

  const refreshTree = useCallback(async () => {
    setPages(await api.pages());
  }, []);

  useEffect(() => {
    refreshTree();
    api.me().then(setMe).catch(() => {});
  }, [refreshTree]);

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
    if (!confirm('¿Eliminar esta página y todas sus subpáginas y archivos?')) return;
    await api.deletePage(id);
    await refreshTree();
    navigate('/');
  };

  return (
    <div className="app">
      {sidebarOpen && (
        <Sidebar
          pages={pages}
          me={me}
          onCreate={createPage}
          onDelete={deletePage}
          onSearch={() => setSearchOpen(true)}
          onCollapse={() => setSidebarOpen(false)}
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
            element={<PageView pages={pages} onTreeChange={refreshTree} onDelete={deletePage} onCreateChild={createPage} />}
          />
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
                </ul>
                <button className="btn primary" onClick={() => createPage(null)}>
                  + Crear una página
                </button>
              </div>
            }
          />
        </Routes>
      </main>
      {searchOpen && <SearchModal onClose={() => setSearchOpen(false)} />}
    </div>
  );
}
