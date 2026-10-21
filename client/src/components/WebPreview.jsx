import { useEffect } from 'react';
import { openInNewTab } from '../fileLinks.js';

// Vista previa de una web externa dentro de NoNotion. Muchas webs (portales
// con login, SharePoint, Azure…) prohíben mostrarse dentro de otra página: en
// ese caso el navegador deja el recuadro en blanco y hay que abrir en pestaña.
export default function WebPreview({ url, onClose }) {
  useEffect(() => {
    const onKey = (e) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="viewer-modal wide" onClick={(e) => e.stopPropagation()}>
        <div className="viewer-bar">
          <span className="viewer-title" title={url}>
            🌐 {url}
          </span>
          <div className="viewer-actions">
            <button className="btn primary" onClick={() => (openInNewTab(url), onClose())}>
              ↗ Abrir en pestaña nueva
            </button>
            <button className="btn" onClick={onClose}>
              Cerrar
            </button>
          </div>
        </div>
        <div className="web-preview-note">
          Si se queda en blanco, esa web no permite mostrarse dentro de otras (pasa con SharePoint, Azure, Confluence…):
          usa "Abrir en pestaña nueva".
        </div>
        <div className="viewer-body">
          <iframe
            className="viewer-frame"
            src={url}
            title={url}
            sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox"
            referrerPolicy="no-referrer"
          />
        </div>
      </div>
    </div>
  );
}
