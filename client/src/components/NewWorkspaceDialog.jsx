import { useEffect, useRef, useState } from 'react';
import { EmojiButton } from './EmojiPicker.jsx';

// Diálogo propio para crear un espacio: window.prompt no funciona en apps
// instaladas (PWA) ni en algunos navegadores móviles, y el clic se perdía sin aviso.
export default function NewWorkspaceDialog({ onCreate, onClose }) {
  const [name, setName] = useState('');
  const [icon, setIcon] = useState('🗂️');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const inputRef = useRef(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const submit = async (e) => {
    e?.preventDefault();
    const n = name.trim();
    if (!n || busy) return;
    setBusy(true);
    setError(null);
    try {
      await onCreate({ name: n, icon: icon.trim() || '🗂️' });
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <form
        className="search-modal move-modal ws-new"
        onClick={(e) => e.stopPropagation()}
        onSubmit={submit}
        onKeyDown={(e) => e.key === 'Escape' && onClose()}
      >
        <div className="move-title">Nuevo espacio</div>
        <p className="ws-new-hint">
          Un espacio por proyecto o cliente: tendrá sus propias páginas, archivos, etiquetas, miembros y conector de Claude.
        </p>
        <div className="ws-new-row">
          <EmojiButton className="ws-new-icon" value={icon} onChange={setIcon} title="Emoji del espacio" />
          <input
            ref={inputRef}
            value={name}
            placeholder="Nombre del espacio (p. ej. el del proyecto)"
            maxLength={60}
            onChange={(e) => setName(e.target.value)}
          />
        </div>
        {error && <div className="ws-error">⚠ {error}</div>}
        <div className="ws-new-actions">
          <button type="button" className="btn" onClick={onClose} disabled={busy}>
            Cancelar
          </button>
          <button type="submit" className="btn primary" disabled={!name.trim() || busy}>
            {busy ? 'Creando…' : 'Crear espacio'}
          </button>
        </div>
      </form>
    </div>
  );
}
