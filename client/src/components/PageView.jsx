import { useCallback, useEffect, useRef, useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import { api, parseContent } from '../api.js';
import Editor from './Editor.jsx';
import Attachments from './Attachments.jsx';
import EmojiPicker from './EmojiPicker.jsx';
import HistoryModal from './HistoryModal.jsx';

function breadcrumb(pages, id) {
  const byId = new Map(pages.map((p) => [p.id, p]));
  const chain = [];
  let cur = byId.get(id);
  while (cur) {
    chain.unshift(cur);
    cur = cur.parent_id ? byId.get(cur.parent_id) : null;
  }
  return chain;
}

export default function PageView({ pages, onTreeChange, onDelete, onCreateChild, onDuplicate }) {
  const { id } = useParams();
  const [page, setPage] = useState(null);
  const [files, setFiles] = useState([]);
  const [status, setStatus] = useState('saved'); // saved | saving | error
  const [emojiOpen, setEmojiOpen] = useState(false);
  const [shareOpen, setShareOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [shareToken, setShareToken] = useState(null);
  const [copied, setCopied] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const editorRef = useRef(null);
  const saveTimer = useRef(null);
  const pending = useRef({});

  const loadPage = useCallback(() => {
    return api.page(id).then((p) => {
      setPage(p);
      setFiles(p.files || []);
      setShareToken(p.share_token);
    });
  }, [id]);

  useEffect(() => {
    setPage(null);
    setShareOpen(false);
    setEmojiOpen(false);
    setHistoryOpen(false);
    loadPage();
    return () => clearTimeout(saveTimer.current);
  }, [loadPage]);

  const flush = useCallback(async () => {
    const data = pending.current;
    pending.current = {};
    if (Object.keys(data).length === 0) return;
    setStatus('saving');
    try {
      await api.updatePage(id, data);
      setStatus('saved');
      if (data.title !== undefined || data.icon !== undefined) onTreeChange();
    } catch {
      setStatus('error');
    }
  }, [id, onTreeChange]);

  const queueSave = useCallback(
    (data) => {
      pending.current = { ...pending.current, ...data };
      setStatus('saving');
      clearTimeout(saveTimer.current);
      saveTimer.current = setTimeout(flush, 700);
    },
    [flush]
  );

  if (!page) return <div className="page-loading">Cargando…</div>;

  const crumbs = breadcrumb(pages, id);

  const toggleShare = async () => {
    if (shareToken) {
      await api.unshare(id);
      setShareToken(null);
    } else {
      const { token } = await api.share(id);
      setShareToken(token);
    }
    onTreeChange();
  };

  const copyShareLink = () => {
    navigator.clipboard.writeText(`${location.origin}/share/${shareToken}`);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  const exportMarkdown = () => {
    const md = editorRef.current?.storage?.markdown?.getMarkdown() || '';
    const blob = new Blob([`# ${page.title || 'Sin título'}\n\n${md}`], {
      type: 'text/markdown;charset=utf-8',
    });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${page.title || 'pagina'}.md`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  const onVersionRestored = async () => {
    setHistoryOpen(false);
    clearTimeout(saveTimer.current);
    pending.current = {};
    await loadPage();
    setReloadKey((k) => k + 1);
    onTreeChange();
  };

  return (
    <div className="page">
      <div className="page-topbar">
        <nav className="breadcrumbs">
          {crumbs.map((c, i) => (
            <span key={c.id}>
              {i > 0 && <span className="crumb-sep">/</span>}
              <Link to={`/p/${c.id}`}>
                {c.icon ? c.icon + ' ' : ''}
                {c.title || 'Sin título'}
              </Link>
            </span>
          ))}
        </nav>
        <div className="topbar-actions">
          <span className={`save-status ${status}`}>
            {status === 'saving' ? 'Guardando…' : status === 'error' ? '⚠ Error al guardar' : 'Guardado'}
          </span>
          <button className="btn" onClick={() => setHistoryOpen(true)} title="Historial de versiones">
            🕘
          </button>
          <button className="btn" onClick={exportMarkdown} title="Exportar como Markdown">
            ⬇ MD
          </button>
          <div className="share-wrap">
            <button className={'btn' + (shareToken ? ' shared' : '')} onClick={() => setShareOpen((v) => !v)}>
              Compartir
            </button>
            {shareOpen && (
              <div className="share-popover">
                <label className="share-toggle">
                  <input type="checkbox" checked={!!shareToken} onChange={toggleShare} />
                  Enlace público activo
                </label>
                {shareToken ? (
                  <>
                    <div className="share-url">{`${location.origin}/share/${shareToken}`}</div>
                    <button className="btn primary" onClick={copyShareLink}>
                      {copied ? '✓ Copiado' : 'Copiar enlace'}
                    </button>
                    <p className="share-note">
                      Requiere una regla de bypass en Cloudflare Access para <code>/share/*</code> y{' '}
                      <code>/files/*</code> (ver README).
                    </p>
                  </>
                ) : (
                  <p className="share-note">Activa el enlace para compartir esta página en solo lectura.</p>
                )}
              </div>
            )}
          </div>
          <button className="btn" onClick={() => onCreateChild(id)} title="Añadir subpágina">
            + Sub
          </button>
          <button className="btn" onClick={() => onDuplicate(id)} title="Duplicar página">
            ⧉
          </button>
          <button className="btn danger" onClick={() => onDelete(id)} title="Mover a la papelera">
            🗑
          </button>
        </div>
      </div>

      <div className="page-body">
        <div className="page-head">
          <button className="page-icon" onClick={() => setEmojiOpen((v) => !v)} title="Cambiar icono">
            {page.icon || '📄'}
          </button>
          {emojiOpen && (
            <EmojiPicker
              onPick={(emoji) => {
                setPage({ ...page, icon: emoji });
                queueSave({ icon: emoji });
                setEmojiOpen(false);
              }}
              onClose={() => setEmojiOpen(false)}
            />
          )}
          <input
            className="page-title"
            value={page.title}
            placeholder="Sin título"
            onChange={(e) => {
              setPage({ ...page, title: e.target.value });
              queueSave({ title: e.target.value });
            }}
          />
        </div>

        <Editor
          key={`${id}:${reloadKey}`}
          pageId={id}
          initialContent={parseContent(page.content)}
          onReady={(ed) => (editorRef.current = ed)}
          onChange={({ json, text }) => queueSave({ content: json, content_text: text })}
          onFileUploaded={(f) => setFiles((prev) => [...prev, f])}
        />

        <Attachments pageId={id} files={files} onChange={setFiles} />
      </div>

      {historyOpen && <HistoryModal pageId={id} onClose={() => setHistoryOpen(false)} onRestored={onVersionRestored} />}
    </div>
  );
}
