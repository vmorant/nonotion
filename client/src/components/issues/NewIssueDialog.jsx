import { useEffect, useRef, useState } from 'react';
import { TYPES, TYPE_LABELS, TYPE_ICONS, PRIORITIES, PRIORITY_LABELS, LINK_LABELS } from './model.js';

const CONTEXT_LINKS = ['origin', 'documents', 'relates'];

// Alta rápida de un elemento de seguimiento. Puede venir prellenado desde una
// página (selección como título, relación "viene de") o desde una idea.
export default function NewIssueDialog({ initial = {}, context, members = [], onCreate, onClose }) {
  const [title, setTitle] = useState(initial.title || '');
  const [type, setType] = useState(initial.type || 'task');
  const [priority, setPriority] = useState(initial.priority || 'medium');
  const [assignee, setAssignee] = useState(initial.assignee || '');
  const [due, setDue] = useState(initial.due_date || '');
  const [description, setDescription] = useState(initial.description || '');
  const [linkType, setLinkType] = useState(context?.type || 'origin');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const ref = useRef(null);

  useEffect(() => {
    ref.current?.focus();
    ref.current?.select();
    const onKey = (e) => e.key === 'Escape' && !busy && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [busy, onClose]);

  const submit = async (e) => {
    e?.preventDefault();
    if (!title.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      await onCreate({
        ...initial.extra,
        title: title.trim(),
        type,
        priority,
        assignee: assignee.trim() || undefined,
        due_date: due || undefined,
        description: description.trim() || undefined,
        ...(context ? { links: [{ type: linkType, target: context.id }] } : {}),
      });
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  };

  return (
    <div
      className="modal-backdrop"
      onMouseDown={(e) => {
        // solo un clic que empieza y acaba en el fondo cierra (no al arrastrar desde un campo)
        if (e.target === e.currentTarget && !busy) e.currentTarget.dataset.down = '1';
      }}
      onMouseUp={(e) => {
        if (e.target === e.currentTarget && e.currentTarget.dataset.down === '1' && !busy) onClose();
        delete e.currentTarget.dataset.down;
      }}
    >
      <form className="issue-new" onSubmit={submit}>
        <div className="issue-new-title">Nuevo elemento de seguimiento</div>
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
        <input ref={ref} className="issue-new-name" value={title} maxLength={300} placeholder="¿Qué hay que seguir? (p. ej. Falta acceso a Unity Catalog)" onChange={(e) => setTitle(e.target.value)} />
        <div className="issue-type-row">
          {TYPES.map((t) => (
            <button type="button" key={t} className={'issue-type-btn' + (type === t ? ' active' : '')} onClick={() => setType(t)}>
              {TYPE_ICONS[t]} {TYPE_LABELS[t]}
            </button>
          ))}
        </div>
        <div className="issue-new-row">
          <label>
            Prioridad
            <select value={priority} onChange={(e) => setPriority(e.target.value)}>
              {PRIORITIES.map((p) => (
                <option key={p} value={p}>
                  {PRIORITY_LABELS[p]}
                </option>
              ))}
            </select>
          </label>
          <label>
            Responsable
            <input list="issue-new-assignees" value={assignee} placeholder="Sin asignar" onChange={(e) => setAssignee(e.target.value)} />
            <datalist id="issue-new-assignees">
              {members.map((m) => (
                <option key={m} value={m} />
              ))}
            </datalist>
          </label>
          <label>
            Fecha límite
            <input type="date" value={due} onChange={(e) => setDue(e.target.value)} />
          </label>
        </div>
        <textarea rows={4} placeholder="Descripción (opcional, Markdown): contexto, impacto, qué se necesita" value={description} onChange={(e) => setDescription(e.target.value)} />
        {error && <div className="issue-error">⚠ {error}</div>}
        <div className="issue-new-actions">
          <button type="button" className="btn" onClick={onClose} disabled={busy}>
            Cancelar
          </button>
          <button type="submit" className="btn primary" disabled={!title.trim() || busy}>
            {busy ? 'Creando…' : 'Crear elemento'}
          </button>
        </div>
      </form>
    </div>
  );
}
