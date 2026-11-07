import { useEffect, useRef, useState } from 'react';
import { api } from '../../api.js';
import { LINK_LABELS } from './model.js';

const CONTEXT_LINKS = ['origin', 'documents', 'relates'];

// Alta rápida de un ticket eligiendo la lista. Puede venir prellenado desde
// una página (la selección como título y la relación con ella) o desde una idea.
// El resto de campos de la lista se rellenan después en el ticket.
export default function NewIssueDialog({ initial = {}, context, trackerId: fixedTracker, onCreate, onClose }) {
  const [trackers, setTrackers] = useState(null);
  const [trackerId, setTrackerId] = useState(fixedTracker || '');
  const [title, setTitle] = useState(initial.title || '');
  const [description, setDescription] = useState(initial.description || '');
  const [linkType, setLinkType] = useState(context?.type || 'origin');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const ref = useRef(null);

  useEffect(() => {
    let cancelled = false;
    api
      .trackers()
      .then((r) => {
        if (cancelled) return;
        setTrackers(r.trackers);
        if (!fixedTracker) {
          // la última lista usada en este navegador, o la primera
          let last = null;
          try {
            last = localStorage.getItem('nn:last-tracker');
          } catch {}
          setTrackerId(r.trackers.find((t) => t.id === last)?.id || r.trackers[0]?.id || '');
        }
      })
      .catch((e) => setError(e.message));
    ref.current?.focus();
    return () => {
      cancelled = true;
    };
  }, [fixedTracker]);

  useEffect(() => {
    const onKey = (e) => e.key === 'Escape' && !busy && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [busy, onClose]);

  const submit = async (e) => {
    e?.preventDefault();
    if (!title.trim() || !trackerId || busy) return;
    setBusy(true);
    setError(null);
    try {
      try {
        localStorage.setItem('nn:last-tracker', trackerId);
      } catch {}
      await onCreate({
        ...initial.extra,
        tracker_id: trackerId,
        title: title.trim(),
        description: description.trim() || undefined,
        ...(context ? { links: [{ type: linkType, target: context.id }] } : {}),
      });
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  };

  const tracker = trackers?.find((t) => t.id === trackerId);

  return (
    <div
      className="modal-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && !busy) e.currentTarget.dataset.down = '1';
      }}
      onMouseUp={(e) => {
        if (e.target === e.currentTarget && e.currentTarget.dataset.down === '1' && !busy) onClose();
        delete e.currentTarget.dataset.down;
      }}
    >
      <form className="issue-new" onSubmit={submit}>
        <div className="issue-new-title">Nuevo ticket</div>
        {trackers && !trackers.length ? (
          <p className="issue-hint">Todavía no hay listas de seguimiento. Crea una desde Seguimiento (Bloqueos, To-do, Temas…) y vuelve.</p>
        ) : (
          <label className="issue-new-list">
            Lista
            <select value={trackerId} disabled={Boolean(fixedTracker)} onChange={(e) => setTrackerId(e.target.value)}>
              {(trackers || []).map((t) => (
                <option key={t.id} value={t.id}>
                  {t.icon} {t.title} ({t.prefix})
                </option>
              ))}
            </select>
          </label>
        )}
        {context && (
          <div className="issue-new-context">
            <select value={linkType} onChange={(e) => setLinkType(e.target.value)} title="Relación con la página de la que lo creas">
              {CONTEXT_LINKS.map((t) => (
                <option key={t} value={t}>
                  {LINK_LABELS[t]}
                </option>
              ))}
            </select>
            <span>
              {context.icon || '📄'} {context.title || 'Sin título'}
            </span>
          </div>
        )}
        <input ref={ref} className="issue-new-name" value={title} maxLength={300} placeholder="Título del ticket" onChange={(e) => setTitle(e.target.value)} />
        <textarea rows={4} placeholder="Descripción (opcional, Markdown)" value={description} onChange={(e) => setDescription(e.target.value)} />
        {tracker && tracker.config.fields.length > 0 && (
          <p className="issue-hint">Después podrás rellenar: {tracker.config.fields.map((f) => f.name).join(', ')}.</p>
        )}
        {error && <div className="issue-error">⚠ {error}</div>}
        <div className="issue-new-actions">
          <button type="button" className="btn" onClick={onClose} disabled={busy}>
            Cancelar
          </button>
          <button type="submit" className="btn primary" disabled={!title.trim() || !trackerId || busy}>
            {busy ? 'Creando…' : 'Crear ticket'}
          </button>
        </div>
      </form>
    </div>
  );
}
