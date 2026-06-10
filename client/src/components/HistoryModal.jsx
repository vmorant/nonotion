import { useEffect, useState } from 'react';
import { useEditor, EditorContent } from '@tiptap/react';
import { api, parseContent } from '../api.js';
import { baseExtensions } from './Editor.jsx';

function formatDate(s) {
  // SQLite guarda en UTC ("YYYY-MM-DD HH:MM:SS")
  const d = new Date(s.replace(' ', 'T') + 'Z');
  return d.toLocaleString();
}

export default function HistoryModal({ pageId, onClose, onRestored }) {
  const [versions, setVersions] = useState(null);
  const [selected, setSelected] = useState(null);
  const [preview, setPreview] = useState(null);
  const [restoring, setRestoring] = useState(false);

  useEffect(() => {
    api.versions(pageId).then((v) => {
      setVersions(v);
      if (v.length) setSelected(v[0].id);
    });
  }, [pageId]);

  useEffect(() => {
    if (!selected) return;
    setPreview(null);
    api.version(selected).then(setPreview);
  }, [selected]);

  const editor = useEditor(
    {
      extensions: baseExtensions,
      content: preview ? parseContent(preview.content) : '',
      editable: false,
    },
    [preview]
  );

  const restore = async () => {
    if (!selected) return;
    if (!confirm('¿Restaurar esta versión? El estado actual se guardará en el historial.')) return;
    setRestoring(true);
    await api.restoreVersion(pageId, selected);
    setRestoring(false);
    onRestored();
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="history-modal" onClick={(e) => e.stopPropagation()}>
        <div className="history-list">
          <div className="history-header">🕘 Historial</div>
          {versions === null && <div className="history-empty">Cargando…</div>}
          {versions?.length === 0 && (
            <div className="history-empty">
              Sin versiones todavía. Se crean automáticamente al editar (máx. una cada 10 min).
            </div>
          )}
          {versions?.map((v) => (
            <button
              key={v.id}
              className={'history-item' + (v.id === selected ? ' selected' : '')}
              onClick={() => setSelected(v.id)}
            >
              <span className="history-date">{formatDate(v.created_at)}</span>
              <span className="history-title">{v.title || 'Sin título'}</span>
            </button>
          ))}
        </div>
        <div className="history-preview">
          <div className="history-preview-bar">
            <span>{preview ? `Versión del ${formatDate(preview.created_at)}` : 'Vista previa'}</span>
            <div>
              <button className="btn primary" onClick={restore} disabled={!selected || restoring}>
                {restoring ? 'Restaurando…' : 'Restaurar esta versión'}
              </button>
              <button className="btn" onClick={onClose} style={{ marginLeft: 8 }}>
                Cerrar
              </button>
            </div>
          </div>
          <div className="history-preview-body">
            {preview ? <EditorContent editor={editor} className="editor readonly" /> : <div className="history-empty">—</div>}
          </div>
        </div>
      </div>
    </div>
  );
}
