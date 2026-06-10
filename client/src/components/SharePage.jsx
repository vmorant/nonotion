import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { useEditor, EditorContent } from '@tiptap/react';
import { api, humanSize, parseContent } from '../api.js';
import { baseExtensions } from './Editor.jsx';

export default function SharePage() {
  const { token } = useParams();
  const [page, setPage] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    api.sharedPage(token).then(setPage).catch((e) => setError(e.message));
  }, [token]);

  const content = parseContent(page?.content);

  const editor = useEditor(
    {
      extensions: baseExtensions,
      content,
      editable: false,
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
        <EditorContent editor={editor} className="editor readonly" />
        {page.files?.length > 0 && (
          <section className="attachments">
            <div className="attachments-header">
              <span>📎 Archivos ({page.files.length})</span>
            </div>
            <ul className="file-list">
              {page.files.map((f) => (
                <li key={f.id} className="file-item">
                  <a href={`/files/${f.id}/${encodeURIComponent(f.name)}`} target="_blank" rel="noreferrer" className="file-name">
                    {f.name}
                  </a>
                  <span className="file-size">{humanSize(f.size)}</span>
                </li>
              ))}
            </ul>
          </section>
        )}
        <footer className="share-footer">Compartido con NoNotion · solo lectura</footer>
      </div>
    </div>
  );
}
