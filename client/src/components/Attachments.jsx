import { useRef, useState } from 'react';
import { api, humanSize } from '../api.js';
import FileViewer, { previewKind } from './FileViewer.jsx';

function fileIcon(mime = '') {
  if (mime.startsWith('image/')) return '🖼️';
  if (mime.startsWith('video/')) return '🎬';
  if (mime.startsWith('audio/')) return '🎵';
  if (mime === 'application/pdf') return '📕';
  if (mime.includes('zip') || mime.includes('compressed') || mime.includes('tar')) return '🗜️';
  if (mime.startsWith('text/') || mime.includes('json') || mime.includes('javascript')) return '📝';
  return '📎';
}

export default function Attachments({ pageId, files, onChange }) {
  const inputRef = useRef(null);
  const [dragOver, setDragOver] = useState(false);
  const [uploads, setUploads] = useState([]); // [{ key, name, pct, error }]
  const [viewing, setViewing] = useState(null);
  const uploading = uploads.length > 0;

  const uploadFiles = async (list) => {
    const items = Array.from(list).map((file) => ({
      key: `${file.name}-${file.size}-${Math.random().toString(36).slice(2)}`,
      file,
    }));
    setUploads((u) => [...u, ...items.map(({ key, file }) => ({ key, name: file.name, pct: 0 }))]);
    for (const { key, file } of items) {
      try {
        const meta = await api.uploadFileProgress(file, pageId, (frac) =>
          setUploads((u) => u.map((it) => (it.key === key ? { ...it, pct: Math.round(frac * 100) } : it)))
        );
        onChange((prev) => [...prev, meta]); // setFiles funcional: evita carreras al subir varios
        setUploads((u) => u.filter((it) => it.key !== key));
      } catch (err) {
        setUploads((u) => u.map((it) => (it.key === key ? { ...it, error: err.message } : it)));
      }
    }
  };

  const remove = async (id) => {
    await api.deleteFile(id);
    onChange(files.filter((f) => f.id !== id));
  };

  return (
    <section
      className={'attachments' + (dragOver ? ' dragover' : '')}
      onDragOver={(e) => {
        e.preventDefault();
        setDragOver(true);
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDragOver(false);
        uploadFiles(Array.from(e.dataTransfer.files));
      }}
    >
      <div className="attachments-header">
        <span>📎 Archivos adjuntos ({files.length})</span>
        <button className="btn" onClick={() => inputRef.current?.click()} disabled={uploading}>
          {uploading ? 'Subiendo…' : '+ Subir archivo'}
        </button>
      </div>
      {files.length === 0 && uploads.length === 0 && (
        <div className="attachments-empty">Arrastra archivos aquí o usa el botón. Sin límite de tamaño.</div>
      )}
      {uploads.length > 0 && (
        <ul className="upload-list">
          {uploads.map((u) => (
            <li key={u.key} className={'upload-item' + (u.error ? ' error' : '')}>
              <div className="upload-row">
                <span className="upload-name">{u.name}</span>
                <span className="upload-pct">{u.error ? '⚠' : `${u.pct}%`}</span>
              </div>
              {u.error ? (
                <div className="upload-error">{u.error}</div>
              ) : (
                <div className="upload-bar">
                  <div className="upload-bar-fill" style={{ width: `${u.pct}%` }} />
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
      <ul className="file-list">
        {files.map((f) => (
          <li key={f.id} className="file-item">
            <span className="file-icon">{fileIcon(f.mime)}</span>
            <a
              href={`/files/${f.id}/${encodeURIComponent(f.name)}`}
              target="_blank"
              rel="noreferrer"
              className="file-name"
              title={previewKind(f) ? 'Ver' : 'Abrir'}
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
            <button className="icon-btn danger" onClick={() => remove(f.id)} title="Eliminar archivo">
              ✕
            </button>
          </li>
        ))}
      </ul>
      {viewing && <FileViewer file={viewing} onClose={() => setViewing(null)} />}
      <input
        ref={inputRef}
        type="file"
        multiple
        hidden
        onChange={(e) => {
          uploadFiles(Array.from(e.target.files || []));
          e.target.value = '';
        }}
      />
    </section>
  );
}
