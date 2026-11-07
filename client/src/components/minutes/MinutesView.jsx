import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { NotebookPen, Plus } from 'lucide-react';
import { api } from '../../api.js';

// Sección Actas: todas las reuniones (fecha, proyecto, asistentes) y lo que
// queda por aprobar en cada una.

const MONTHS = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
const ICON = { size: 15, strokeWidth: 1.9 };
const today = () => new Date().toISOString().slice(0, 10);

function NewMinutesDialog({ pages, onCreate, onClose }) {
  const [title, setTitle] = useState('');
  const [date, setDate] = useState(today());
  const [project, setProject] = useState('');
  const [attendees, setAttendees] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const projects = pages.filter((p) => !p.kind || p.kind === 'doc').sort((a, b) => (a.title || '').localeCompare(b.title || '', 'es'));
  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await onCreate({ title: title.trim() || undefined, date, project_id: project || undefined, attendees });
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  };
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && !busy && onClose()}>
      <form className="issue-new" onSubmit={submit}>
        <div className="issue-new-title">Nueva acta de reunión</div>
        <input autoFocus className="issue-new-name" placeholder={`Reunión ${date}`} value={title} onChange={(e) => setTitle(e.target.value)} />
        <div className="issue-new-row">
          <label>
            Fecha
            <input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
          </label>
          <label>
            Proyecto
            <select value={project} onChange={(e) => setProject(e.target.value)}>
              <option value="">(sin proyecto)</option>
              {projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.icon || '📄'} {p.title || 'Sin título'}
                </option>
              ))}
            </select>
          </label>
        </div>
        <input className="issue-new-name small" placeholder="Asistentes: Ana, Luis…" value={attendees} onChange={(e) => setAttendees(e.target.value)} />
        <p className="issue-hint">Se crea con la plantilla de acta (asistentes, agenda, notas, acciones, decisiones, ideas).</p>
        {error && <div className="issue-error">⚠ {error}</div>}
        <div className="issue-new-actions">
          <button type="button" className="btn" onClick={onClose} disabled={busy}>
            Cancelar
          </button>
          <button type="submit" className="btn primary" disabled={busy || !date}>
            {busy ? 'Creando…' : 'Crear acta'}
          </button>
        </div>
      </form>
    </div>
  );
}

export default function MinutesView({ pages, onChanged }) {
  const [list, setList] = useState(null);
  const [q, setQ] = useState('');
  const [project, setProject] = useState('');
  const [onlyPending, setOnlyPending] = useState(false);
  const [creating, setCreating] = useState(false);
  const navigate = useNavigate();

  useEffect(() => {
    let cancelled = false;
    api
      .minutesList()
      .then((r) => !cancelled && setList(r.minutes))
      .catch(() => !cancelled && setList([]));
    return () => {
      cancelled = true;
    };
  }, [pages]);

  const projects = useMemo(() => {
    const m = new Map();
    for (const a of list || []) if (a.project) m.set(a.project.id, a.project);
    return [...m.values()];
  }, [list]);

  const groups = useMemo(() => {
    const t = q.trim().toLowerCase();
    const shown = (list || []).filter(
      (a) =>
        (!t || `${a.title} ${a.attendees.join(' ')} ${a.project?.title || ''}`.toLowerCase().includes(t)) &&
        (!project || a.project?.id === project) &&
        (!onlyPending || a.pending > 0)
    );
    const by = new Map();
    for (const a of shown) {
      const k = (a.date || '').slice(0, 7) || 'sin fecha';
      if (!by.has(k)) by.set(k, []);
      by.get(k).push(a);
    }
    return [...by.entries()];
  }, [list, q, project, onlyPending]);

  const pendingTotal = (list || []).reduce((n, a) => n + a.pending, 0);

  return (
    <div className="issues-view">
      <div className="issues-head">
        <h2>
          <NotebookPen size={20} strokeWidth={1.9} /> Actas de reunión
        </h2>
        <p className="issues-intro">
          Cada acta guarda lo que se habló y propone lo que sale de ella —tareas con seguimiento, listas, documentación, ideas y eventos— para que tú lo apruebes. Las
          actas salen en el calendario.
        </p>
        <div className="issues-toolbar">
          <div className="issues-filters">
            <input className="issues-search" placeholder="Buscar por título, asistente o proyecto…" value={q} onChange={(e) => setQ(e.target.value)} />
            {projects.length > 0 && (
              <select value={project} onChange={(e) => setProject(e.target.value)}>
                <option value="">Todos los proyectos</option>
                {projects.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.icon || '📄'} {p.title}
                  </option>
                ))}
              </select>
            )}
            <label className="tracker-hide-done">
              <input type="checkbox" checked={onlyPending} onChange={(e) => setOnlyPending(e.target.checked)} /> Con propuestas por aprobar
              {pendingTotal > 0 && <span className="issues-count danger">{pendingTotal}</span>}
            </label>
          </div>
          <button className="btn primary" onClick={() => setCreating(true)}>
            <Plus {...ICON} /> Nueva acta
          </button>
        </div>
      </div>

      {list && !list.length && (
        <div className="issues-empty">
          <NotebookPen size={40} strokeWidth={1.4} />
          <p>Todavía no hay actas. Crea la primera, o pídele a Claude «guarda el acta de esta reunión».</p>
        </div>
      )}

      {groups.map(([month, items]) => (
        <section key={month} className="minutes-month">
          <h3>{month === 'sin fecha' ? 'Sin fecha' : `${MONTHS[Number(month.slice(5, 7)) - 1]} ${month.slice(0, 4)}`}</h3>
          {items.map((a) => (
            <button key={a.id} className="minutes-row" onClick={() => navigate(`/p/${a.id}`)}>
              <span className="minutes-date">{a.date ? a.date.slice(8, 10) : '—'}</span>
              <span className="minutes-row-main">
                <span className="minutes-row-title">
                  {a.icon || '📝'} {a.title}
                </span>
                <span className="issue-hint">
                  {a.project ? `${a.project.icon || '📄'} ${a.project.title}` : 'Sin proyecto'}
                  {a.attendees.length ? ` · ${a.attendees.join(', ')}` : ''}
                </span>
              </span>
              {a.pending > 0 && <span className="issues-count danger">{a.pending} por aprobar</span>}
              {a.created > 0 && <span className="cat-count cat-done">{a.created} creadas</span>}
            </button>
          ))}
        </section>
      ))}

      {creating && (
        <NewMinutesDialog
          pages={pages}
          onClose={() => setCreating(false)}
          onCreate={async (body) => {
            const d = await api.createMinutes(body);
            setCreating(false);
            await onChanged?.();
            navigate(`/p/${d.page_id}`);
          }}
        />
      )}
    </div>
  );
}
