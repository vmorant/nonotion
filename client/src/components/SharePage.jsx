import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { useEditor, EditorContent } from '@tiptap/react';
import { api, humanSize, parseContent } from '../api.js';
import { baseExtensions } from './Editor.jsx';
import FileViewer, { previewKind } from './FileViewer.jsx';
import { fileFromHref } from '../fileLinks.js';
import CanvasView from './canvas/CanvasView.jsx';
import IdeaView from './ideas/IdeaView.jsx';
import { StatusPill } from './issues/fields.jsx';
import TrackerView from './issues/TrackerView.jsx';

export default function SharePage() {
  const { token } = useParams();
  const [page, setPage] = useState(null);
  const [error, setError] = useState(null);
  const [viewing, setViewing] = useState(null);

  // Clic en una imagen → visor
  useEffect(() => {
    const onView = (e) => setViewing(e.detail);
    document.addEventListener('nonotion:view-file', onView);
    return () => document.removeEventListener('nonotion:view-file', onView);
  }, []);

  useEffect(() => {
    api.sharedPage(token).then(setPage).catch((e) => setError(e.message));
  }, [token]);

  // un canvas no pasa por el editor de texto
  const content = page?.kind === 'canvas' || page?.kind === 'idea' || page?.kind === 'tracker' ? '' : parseContent(page?.content);

  const editor = useEditor(
    {
      extensions: baseExtensions,
      content,
      editable: false,
      editorProps: {
        // Enlaces a adjuntos: visor; el resto se abre en pestaña nueva (target _blank)
        handleClick: (view, pos, event) => {
          const a = event.target.closest?.('a[href]');
          const f = a && fileFromHref(a.getAttribute('href'));
          if (!f || !previewKind(f)) return false;
          event.preventDefault();
          setViewing(f);
          return true;
        },
      },
    },
    [page]
  );

  if (error) return <div className="share-error">⚠ {error}</div>;
  if (!page) return <div className="page-loading">Cargando…</div>;

  return (
    <div className="share-page">
      <div className="page-body">
        <div className="page-head readonly">
          <span className="page-icon">{page.icon || '📄'}</span>
          <h1 className="page-title-static">{page.title || 'Sin título'}</h1>
        </div>
        {page.issue && (
          <div className="issue-fields readonly">
            <span className="issue-key big">{page.issue.key}</span>
            <StatusPill status={{ name: page.issue.status, color: page.issue.color, category: page.issue.category }} />
            {page.issue.fields.map((f) => (
              <span key={f.name}>
                {f.name}: <strong>{f.value}</strong>
              </span>
            ))}
          </div>
        )}
        {page.kind === 'tracker' && page.tracker ? (
          <TrackerView pageId={`share-${token}`} readOnly initial={{ id: page.id, prefix: page.tracker.prefix, config: page.tracker.config, issues: page.tracker.issues }} />
        ) : page.kind === 'idea' ? (
          <IdeaView pageId={page.id} title={page.title} initialContent={page.content} files={page.files || []} readOnly />
        ) : page.kind === 'canvas' ? (
          <CanvasView pageId={`share-${token}`} initialContent={page.content} readOnly />
        ) : (
          <EditorContent editor={editor} className="editor readonly" />
        )}
        {page.files?.length > 0 && (
          <section className="attachments">
            <div className="attachments-header">
              <span>📎 Archivos ({page.files.length})</span>
            </div>
            <ul className="file-list">
              {page.files.map((f) => (
                <li key={f.id} className="file-item">
                  <a
                    href={`/files/${f.id}/${encodeURIComponent(f.name)}`}
                    target="_blank"
                    rel="noreferrer"
                    className="file-name"
                    onClick={(e) => {
                      if (previewKind(f)) {
                        e.preventDefault();
                        setViewing(f);
                      }
                    }}
                  >
                    {f.name}
                  </a>
                  <span className="file-size">{humanSize(f.size)}</span>
                </li>
              ))}
            </ul>
          </section>
        )}
        {viewing && <FileViewer file={viewing} onClose={() => setViewing(null)} />}
        <footer className="share-footer">Compartido con NoNotion · solo lectura</footer>
      </div>
    </div>
  );
}
