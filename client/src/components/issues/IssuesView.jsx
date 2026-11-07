import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { ListChecks, Plus, LayoutGrid, OctagonAlert, Rows3 } from 'lucide-react';
import { api } from '../../api.js';
import { StatusPill } from './fields.jsx';
import { CATEGORIES, CATEGORY_LABELS, OPEN_CATEGORIES } from './model.js';

// Seguimiento: el panel de todas las listas del espacio (Bloqueos, To-do,
// Temas…), lo bloqueado en cualquiera de ellas y todos los tickets juntos.

const ICON = { size: 15, strokeWidth: 1.9 };

function NewTrackerDialog({ templates, pages, onCreate, onClose }) {
  const [title, setTitle] = useState('');
  const [template, setTemplate] = useState('blockers');
  const [parent, setParent] = useState('');
  const [prefix, setPrefix] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const parents = pages.filter((p) => !p.kind || p.kind === 'doc').sort((a, b) => (a.title || '').localeCompare(b.title || ''));
  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await onCreate({ title: title.trim() || undefined, template, parent_id: parent || undefined, prefix: prefix || undefined });
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  };
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && !busy && onClose()}>
      <form className="issue-new" onSubmit={submit}>
        <div className="issue-new-title">Nueva lista de seguimiento</div>
        <div className="tracker-templates">
          {templates.map((t) => (
            <button type="button" key={t.id} className={'tracker-template' + (template === t.id ? ' active' : '')} onClick={() => setTemplate(t.id)}>
              <span className="tracker-template-icon">{t.icon}</span>
              {t.label}
            </button>
          ))}
        </div>
        <input
          autoFocus
          className="issue-new-name"
          placeholder={`Nombre (p. ej. ${templates.find((t) => t.id === template)?.label || 'Bloqueantes AXA'})`}
          value={title}
          onChange={(e) => setTitle(e.target.value)}
        />
        <div className="issue-new-row">
          <label>
            Dentro de
            <select value={parent} onChange={(e) => setParent(e.target.value)}>
              <option value="">(raíz del espacio)</option>
              {parents.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.icon || '📄'} {p.title || 'Sin título'}
                </option>
              ))}
            </select>
          </label>
          <label>
            Prefijo (opcional)
            <input value={prefix} maxLength={10} placeholder="BLQ" onChange={(e) => setPrefix(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ''))} />
          </label>
        </div>
        <p className="issue-hint">Los campos y estados de la plantilla se pueden cambiar después en ⚙ Campos.</p>
        {error && <div className="issue-error">⚠ {error}</div>}
        <div className="issue-new-actions">
          <button type="button" className="btn" onClick={onClose} disabled={busy}>
            Cancelar
          </button>
          <button type="submit" className="btn primary" disabled={busy}>
            {busy ? 'Creando…' : 'Crear lista'}
          </button>
        </div>
      </form>
    </div>
  );
}

// Un bloqueo con lo que lo bloquea y lo que arrastra detrás
function BlockedItem({ i, onOpen }) {
  const [d, setD] = useState(null);
  useEffect(() => {
    let cancelled = false;
    api.issue(i.id).then((r) => !cancelled && setD(r)).catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [i.id, i.status]);
  const by = (d?.incoming || []).filter((l) => l.type === 'blocks' && OPEN_CATEGORIES.has(l.source.category));
  const blocks = (d?.links || []).filter((l) => l.type === 'blocks');
  const docs = (d?.links || []).filter((l) => l.type === 'documents');
  return (
    <div className="issue-blocked-item">
      <button className="issue-blocked-main" onClick={() => onOpen(i.id)}>
        <span className="issue-key">{i.key}</span> <strong>{i.title}</strong> <StatusPill status={{ name: i.status_name, color: i.color, category: i.category }} />
        <span className="issue-hint">· {i.tracker_title}</span>
      </button>
      {by.length > 0 && (
        <div className="issue-chain">
          ⛔ Bloqueado por:{' '}
          {by.map((l) => (
            <button key={l.id} className="issue-chip" onClick={() => onOpen(l.source.id)}>
              {l.source.key} {l.source.title}
            </button>
          ))}
        </div>
      )}
      {blocks.length > 0 && (
        <div className="issue-chain">
          ⏩ Frena a:{' '}
          {blocks.map((l) => (
            <button key={l.id} className="issue-chip" onClick={() => onOpen(l.target.id)}>
              {l.target.key} {l.target.title}
            </button>
          ))}
        </div>
      )}
      {docs.length > 0 && (
        <div className="issue-chain">
          📄 Documentado en:{' '}
          {docs.map((l) => (
            <button key={l.id} className="issue-chip" onClick={() => onOpen(l.target.id)}>
              {l.target.icon || '📄'} {l.target.title}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export default function IssuesView({ pages, onChanged }) {
  const [params, setParams] = useSearchParams();
  const tab = params.get('v') || 'lists';
  const [data, setData] = useState(null);
  const [issues, setIssues] = useState(null);
  const [creating, setCreating] = useState(false);
  const [q, setQ] = useState('');
  const [onlyActive, setOnlyActive] = useState(true);
  const [error, setError] = useState(null);
  const navigate = useNavigate();

  // Se recarga con cada cambio del árbol (el servidor avisa también de los tickets)
  useEffect(() => {
    let cancelled = false;
    Promise.all([api.trackers(), api.issues()])
      .then(([t, i]) => {
        if (cancelled) return;
        setData(t);
        setIssues(i.issues);
      })
      .catch((e) => !cancelled && setError(e.message));
    return () => {
      cancelled = true;
    };
  }, [pages]);

  const blocked = useMemo(
    () => (issues || []).filter((i) => OPEN_CATEGORIES.has(i.category) && (i.category === 'blocked' || i.blocked_by_open > 0)),
    [issues]
  );
  const all = useMemo(() => {
    const t = q.trim().toLowerCase();
    return (issues || [])
      .filter((i) => !onlyActive || OPEN_CATEGORIES.has(i.category))
      .filter((i) => !t || i.key.toLowerCase().includes(t) || (i.title || '').toLowerCase().includes(t) || (i.tracker_title || '').toLowerCase().includes(t));
  }, [issues, q, onlyActive]);
  const setTab = (v) => setParams(v === 'lists' ? {} : { v }, { replace: true });

  const createTracker = async (body) => {
    const d = await api.createTracker(body);
    setCreating(false);
    await onChanged?.();
    navigate(`/p/${d.id}`);
  };

  return (
    <div className="issues-view">
      <div className="issues-head">
        <h2>
          <ListChecks size={20} strokeWidth={1.9} /> Seguimiento
        </h2>
        <p className="issues-intro">
          Tus listas de seguimiento —bloqueos, tareas, temas, lo que necesites— como un Jira ligero: cada una con sus propios campos y
          estados, y sus tickets relacionados con las páginas que los documentan. Escribe la clave de un ticket (p. ej. <code>BLQ-12</code>)
          en cualquier página para enlazarlo.
        </p>
        <div className="issues-toolbar">
          <div className="issues-tabs">
            <button className={tab === 'lists' ? 'active' : ''} onClick={() => setTab('lists')}>
              <LayoutGrid {...ICON} /> Listas
            </button>
            <button className={tab === 'blocked' ? 'active' : ''} onClick={() => setTab('blocked')}>
              <OctagonAlert {...ICON} /> Bloqueos {blocked.length > 0 && <span className="issues-count danger">{blocked.length}</span>}
            </button>
            <button className={tab === 'all' ? 'active' : ''} onClick={() => setTab('all')}>
              <Rows3 {...ICON} /> Todos los tickets
            </button>
          </div>
          <button className="btn primary" onClick={() => setCreating(true)}>
            <Plus {...ICON} /> Nueva lista
          </button>
        </div>
      </div>
      {error && <div className="issue-error">⚠ {error}</div>}

      {tab === 'lists' && data && (
        <>
          {!data.trackers.length && (
            <div className="issues-empty">
              <ListChecks size={40} strokeWidth={1.4} />
              <p>Todavía no hay listas. Crea la primera desde una plantilla (Bloqueos, To-do, Temas) o en blanco, y colócala donde quieras del árbol.</p>
            </div>
          )}
          <div className="tracker-cards">
            {data.trackers.map((t) => {
              const open = t.counts.todo + t.counts.doing + t.counts.blocked;
              const parent = t.parent_id ? pages.find((p) => p.id === t.parent_id) : null;
              return (
                <button key={t.id} className="tracker-card-big" onClick={() => navigate(`/p/${t.id}`)}>
                  <div className="tracker-card-title">
                    <span className="tracker-card-icon">{t.icon || '📋'}</span>
                    <span>{t.title}</span>
                    <span className="issues-prefix">{t.prefix}</span>
                  </div>
                  {parent && <div className="issue-hint">en {parent.title || 'Sin título'}</div>}
                  <div className="tracker-card-counts">
                    {CATEGORIES.map((c) =>
                      t.counts[c] ? (
                        <span key={c} className={`cat-count cat-${c}`}>
                          {t.counts[c]} {CATEGORY_LABELS[c].toLowerCase()}
                        </span>
                      ) : null
                    )}
                    {!open && !t.counts.done && <span className="issue-hint">Sin tickets</span>}
                  </div>
                  <div className="issue-hint">
                    {t.config.fields.length ? t.config.fields.map((f) => f.name).join(' · ') : 'Solo título y estado'}
                  </div>
                </button>
              );
            })}
          </div>
        </>
      )}

      {tab === 'blocked' && issues && (
        <div className="issues-blocked">
          {!blocked.length && <p className="issue-hint">Nada bloqueado ahora mismo. 🎉</p>}
          {blocked.map((i) => (
            <BlockedItem key={i.id} i={i} onOpen={(id) => navigate(`/p/${id}`)} />
          ))}
        </div>
      )}

      {tab === 'all' && issues && (
        <>
          <div className="issues-filters">
            <input className="issues-search" placeholder="Buscar por clave, título o lista…" value={q} onChange={(e) => setQ(e.target.value)} />
            <label className="tracker-hide-done">
              <input type="checkbox" checked={onlyActive} onChange={(e) => setOnlyActive(e.target.checked)} /> Solo abiertos
            </label>
          </div>
          <table className="issues-table">
            <thead>
              <tr>
                <th>Clave</th>
                <th>Título</th>
                <th>Lista</th>
                <th>Estado</th>
                <th>Actualizado</th>
              </tr>
            </thead>
            <tbody>
              {all.map((i) => (
                <tr key={i.id} className={`issue-row cat-${i.category}`} onClick={() => navigate(`/p/${i.id}`)}>
                  <td>
                    <span className="issue-key">{i.key}</span>
                  </td>
                  <td className="issue-title-cell">
                    {i.title}
                    {i.blocked_by_open > 0 && <span className="issue-blocked-badge small">⛔ {i.blocked_by_open}</span>}
                  </td>
                  <td className="issue-hint">{i.tracker_title}</td>
                  <td>
                    <StatusPill status={{ name: i.status_name, color: i.color, category: i.category }} />
                  </td>
                  <td className="issue-hint">{(i.updated_at || '').slice(0, 10)}</td>
                </tr>
              ))}
              {!all.length && (
                <tr>
                  <td colSpan={5} className="issue-hint">
                    Sin tickets.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </>
      )}

      {creating && data && <NewTrackerDialog templates={data.templates} pages={pages} onCreate={createTracker} onClose={() => setCreating(false)} />}
    </div>
  );
}
