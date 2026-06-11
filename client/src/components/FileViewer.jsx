import { useEffect, useState } from 'react';

const OFFICE_EXTS = ['.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx', '.odt', '.ods', '.odp', '.rtf'];
const TEXT_LIMIT = 500 * 1024;

const ext = (name = '') => name.slice(name.lastIndexOf('.')).toLowerCase();

// Qué visor usar para un archivo, o null si no hay vista previa
export function previewKind(file) {
  const mime = file.mime || '';
  if (mime === 'application/pdf') return 'pdf';
  if (mime.startsWith('image/')) return 'image';
  if (mime.startsWith('video/')) return 'video';
  if (mime.startsWith('audio/')) return 'audio';
  if (OFFICE_EXTS.includes(ext(file.name))) return 'office';
  if (mime.startsWith('text/') || /json|javascript|xml|yaml|x-sh/.test(mime)) return 'text';
  return null;
}

function OfficeFrame({ file }) {
  const [state, setState] = useState({ status: 'loading' });

  useEffect(() => {
    let url = null;
    let cancelled = false;
    setState({ status: 'loading' });
    fetch(`/files/${file.id}/preview`)
      .then(async (res) => {
        if (!res.ok) {
          const err = await res.json().catch(() => ({}));
          throw new Error(err.error || `Error ${res.status}`);
        }
        return res.blob();
      })
      .then((blob) => {
        if (cancelled) return;
        url = URL.createObjectURL(blob);
        setState({ status: 'ready', url });
      })
      .catch((e) => !cancelled && setState({ status: 'error', message: e.message }));
    return () => {
      cancelled = true;
      if (url) URL.revokeObjectURL(url);
    };
  }, [file.id]);

  if (state.status === 'loading')
    return <div className="viewer-status">Convirtiendo documento… (la primera vez tarda unos segundos)</div>;
  if (state.status === 'error') return <div className="viewer-status error">⚠ {state.message}</div>;
  return <iframe className="viewer-frame" src={state.url} title={file.name} />;
}

function TextView({ url }) {
  const [text, setText] = useState(null);
  useEffect(() => {
    fetch(url)
      .then((r) => r.text())
      .then((t) => setText(t.length > TEXT_LIMIT ? t.slice(0, TEXT_LIMIT) + '\n\n… (truncado)' : t))
      .catch(() => setText('No se pudo cargar el archivo.'));
  }, [url]);
  if (text === null) return <div className="viewer-status">Cargando…</div>;
  return <pre className="viewer-text">{text}</pre>;
}

export default function FileViewer({ file, onClose }) {
  const url = `/files/${file.id}/${encodeURIComponent(file.name)}`;
  const kind = previewKind(file);

  useEffect(() => {
    const onKey = (e) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="viewer-modal" onClick={(e) => e.stopPropagation()}>
        <div className="viewer-bar">
          <span className="viewer-title">{file.name}</span>
          <div className="viewer-actions">
            <a className="btn" href={url} target="_blank" rel="noreferrer">
              Abrir en pestaña
            </a>
            <a className="btn" href={url} download={file.name}>
              ⬇ Descargar
            </a>
            <button className="btn" onClick={onClose}>
              Cerrar
            </button>
          </div>
        </div>
        <div className="viewer-body">
          {kind === 'pdf' && <iframe className="viewer-frame" src={url} title={file.name} />}
          {kind === 'office' && <OfficeFrame file={file} />}
          {kind === 'image' && <img className="viewer-image" src={url} alt={file.name} />}
          {kind === 'video' && <video className="viewer-media" src={url} controls autoPlay />}
          {kind === 'audio' && (
            <div className="viewer-status">
              <audio src={url} controls autoPlay style={{ width: '100%' }} />
            </div>
          )}
          {kind === 'text' && <TextView url={url} />}
          {kind === null && (
            <div className="viewer-status">Sin vista previa para este tipo de archivo. Usa "Descargar".</div>
          )}
        </div>
      </div>
    </div>
  );
}
