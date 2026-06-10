import { useRef, useState } from 'react';
import { api, humanSize } from '../api.js';

// Reproductor inline para adjuntos de audio/vídeo (usado también en SharePage)
export function InlinePlayer({ file }) {
  const url = `/files/${file.id}/${encodeURIComponent(file.name)}`;
  if (file.mime?.startsWith('video/')) return <video className="file-player" src={url} controls preload="metadata" />;
  if (file.mime?.startsWith('audio/')) return <audio className="file-player" src={url} controls preload="metadata" />;
  return null;
}

export const isPlayable = (mime = '') => mime.startsWith('video/') || mime.startsWith('audio/');

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
  const [uploading, setUploading] = useState(false);
  const [playingId, setPlayingId] = useState(null);

  const uploadFiles = async (list) => {
    setUploading(true);
    const added = [];
    for (const file of list) {
      try {
        added.push(await api.uploadFile(file, pageId));
      } catch (err) {
        console.error(err);
      }
    }
    onChange([...files, ...added]);
    setUploading(false);
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
      {files.length === 0 && <div className="attachments-empty">Arrastra archivos aquí o usa el botón. Sin límite de tamaño.</div>}
      <ul className="file-list">
        {files.map((f) => (
          <li key={f.id}>
            <div className="file-item">
              <span className="file-icon">{fileIcon(f.mime)}</span>
              <a href={`/files/${f.id}/${encodeURIComponent(f.name)}`} target="_blank" rel="noreferrer" className="file-name">
                {f.name}
              </a>
              <span className="file-size">{humanSize(f.size)}</span>
              {isPlayable(f.mime) && (
                <button
                  className="icon-btn"
                  title={playingId === f.id ? 'Cerrar reproductor' : 'Reproducir'}
                  onClick={() => setPlayingId(playingId === f.id ? null : f.id)}
                >
                  {playingId === f.id ? '◼' : '▶'}
                </button>
              )}
              <button className="icon-btn danger" onClick={() => remove(f.id)} title="Eliminar archivo">
                ✕
              </button>
            </div>
            {playingId === f.id && <InlinePlayer file={f} />}
          </li>
        ))}
      </ul>
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
