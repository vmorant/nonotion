import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { ListChecks, Plus, LayoutList, Columns3, OctagonAlert } from 'lucide-react';
import { api } from '../../api.js';
import NewIssueDialog from './NewIssueDialog.jsx';
import { StatusPill } from './IssuePanel.jsx';
import {
  STATUSES,
  OPEN_STATUSES,
  STATUS_LABELS,
  TYPES,
  TYPE_LABELS,
  TYPE_ICONS,
  PRIORITIES,
  PRIORITY_LABELS,
  overdue,
} from './model.js';

// Vista Seguimiento: todos los elementos del espacio como lista filtrable,
// tablero por estado o vista de bloqueos (qué está parado y por qué).

const ICON = { size: 15, strokeWidth: 1.9 };
const PRIO_ORDER = { critical: 0, high: 1, medium: 2, low: 3 };

function Row({ i, onOpen }) {
  return (
    <tr className={`issue-row status-${i.status}`} onClick={onOpen}>
      <td className="issue-key-cell">
        <span className="issue-key">{i.key}</span>
      </td>
      <td title={TYPE_LABELS[i.type]}>{TYPE_ICONS[i.type]}</td>
      <td className="issue-title-cell">
        {i.title || 'Sin título'}
        {i.blocked_by_open > 0 && <span className="issue-blocked-badge small">⛔ {i.blocked_by_open}</span>}
        {i.tags?.length > 0 && <span className="issue-row-tags">{i.tags.map((t) => `#${t}`).join(' ')}</span>}
      </td>
      <td>
        <StatusPill status={i.status} />
      </td>
      <td className={`prio prio-${i.priority}`}>{PRIORITY_LABELS[i.priority]}</td>
      <td className="issue-assignee">{i.assignee || '—'}</td>
      <td className={'issue-due' + (overdue(i) ? ' overdue' : '')}>{i.due_date || '—'}</td>
      <td className="issue-counts" title="Relaciones · comentarios">
        {i.links_count + i.blocks_count > 0 ? `🔗${i.links_count + i.blocks_count}` : ''} {i.comments ? `💬${i.comments}` : ''}
      </td>
    </tr>
  );
}

function Card({ i, onOpen, onDragStart }) {
  return (
    <button className={`issue-card prio-${i.priority}`} onClick={onOpen} draggable onDragStart={onDragStart}>
      <div className="issue-card-head">
        <span className="issue-key">{i.key}</span>
        <span>{TYPE_ICONS[i.type]}</span>
        {i.blocked_by_open > 0 && <span className="issue-blocked-badge small">⛔ {i.blocked_by_open}</span>}
      </div>
      <div className="issue-card-title">{i.title || 'Sin título'}</div>
      <div className="issue-card-meta">
        <span className={`prio prio-${i.priority}`}>{PRIORITY_LABELS[i.priority]}</span>
        {i.assignee && <span>{i.assignee}</span>}
        {i.due_date && <span className={overdue(i) ? 'overdue' : ''}>{i.due_date}</span>}
      </div>
    </button>
  );
}

export default function IssuesView({ pages, members = [], onChanged }) {
  const [params, setParams] = useSearchParams();
  const view = params.get('v') || 'list';
  const statusF = params.get('status') || 'active';
  const typeF = params.get('type') || '';
  const prioF = params.get('priority') || '';
  const [q, setQ] = useState('');
  const [assignee, setAssignee] = useState('');
  const [data, setData] = useState(null);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState(null);
  const navigate = useNavigate();

  const setParam = (k, v) => {
    const next = new URLSearchParams(params);
    if (v) next.set(k, v);
    else next.delete(k);
    setParams(next, { replace: true });
  };

  // Se recarga con cada cambio del árbol (el servidor avisa también de los elementos)
  useEffect(() => {
    let cancelled = false;
    api
      .issues()
      .then((r) => !cancelled && setData(r))
      .catch((e) => !cancelled && setError(e.message));
    return () => {
      cancelled = true;
    };
  }, [pages]);

  const all = data?.issues || [];
  const filtered = useMemo(() => {
    const t = q.trim().toLowerCase();
    const a = assignee.trim().toLowerCase();
    return all
      // el tablero enseña todas las columnas: el filtro de estado es solo de la lista
      .filter((i) => view === 'board' || (statusF === 'all' ? true : statusF === 'active' ? OPEN_STATUSES.has(i.status) : i.status === statusF))
      .filter((i) => !typeF || i.type === typeF)
      .filter((i) => !prioF || i.priority === prioF)
      .filter((i) => !a || (a === 'none' ? !i.assignee : (i.assignee || '').toLowerCase().includes(a)))
      .filter((i) => !t || i.key.toLowerCase().includes(t) || (i.title || '').toLowerCase().includes(t) || i.tags?.some((x) => x.includes(t.replace(/^#/, ''))))
      .sort((x, y) => PRIO_ORDER[x.priority] - PRIO_ORDER[y.priority] || (y.updated_at || '').localeCompare(x.updated_at || ''));
  }, [all, q, assignee, statusF, typeF, prioF, view]);

  const blocked = useMemo(
    () =>
      all
        .filter((i) => OPEN_STATUSES.has(i.status) && (i.status === 'blocked' || i.blocked_by_open > 0 || i.type === 'blocker'))
        .sort((x, y) => PRIO_ORDER[x.priority] - PRIO_ORDER[y.priority]),
    [all]
  );

  const counts = useMemo(() => {
    const c = Object.fromEntries(STATUSES.map((s) => [s, 0]));
    for (const i of all) c[i.status]++;
    return c;
  }, [all]);

  const create = async (body) => {
    const d = await api.createIssue(body);
    setCreating(false);
    await onChanged?.();
    navigate(`/p/${d.page_id}`);
  };

  const moveTo = async (id, status) => {
    try {
      await api.updateIssue(id, { status });
      setData((d) => ({ ...d, issues: d.issues.map((i) => (i.id === id ? { ...i, status } : i)) }));
      onChanged?.();
    } catch (e) {
      setError(e.message);
    }
  };

  return (
    <div className="issues-view">
      <div className="issues-head">
        <h2>
          <ListChecks size={20} strokeWidth={1.9} /> Seguimiento
          {data && <span className="issues-prefix">{data.prefix}</span>}
        </h2>
        <p className="issues-intro">
          Bloqueos, problemas, riesgos, tareas, decisiones y preguntas del proyecto, con su estado y relacionados con las páginas que los
          documentan. Escribe su clave (p. ej. <code>{data?.prefix || 'AXA'}-12</code>) en cualquier página para enlazarlos.
        </p>
        <div className="issues-toolbar">
          <div className="issues-tabs">
            <button className={view === 'list' ? 'active' : ''} onClick={() => setParam('v', '')}>
              <LayoutList {...ICON} /> Lista
            </button>
            <button className={view === 'board' ? 'active' : ''} onClick={() => setParam('v', 'board')}>
              <Columns3 {...ICON} /> Tablero
            </button>
            <button className={view === 'blocked' ? 'active' : ''} onClick={() => setParam('v', 'blocked')}>
              <OctagonAlert {...ICON} /> Bloqueos {blocked.length > 0 && <span className="issues-count danger">{blocked.length}</span>}
            </button>
          </div>
          <button className="btn primary" onClick={() => setCreating(true)}>
            <Plus {...ICON} /> Nuevo elemento
          </button>
        </div>
        {view !== 'blocked' && (
          <div className="issues-filters">
            <input className="issues-search" placeholder="Buscar por clave, título o #etiqueta…" value={q} onChange={(e) => setQ(e.target.value)} />
            {view === 'list' && (
              <select value={statusF} onChange={(e) => setParam('status', e.target.value === 'active' ? '' : e.target.value)}>
                <option value="active">Activos ({counts.open + counts.in_progress + counts.blocked})</option>
                <option value="all">Todos ({all.length})</option>
                {STATUSES.map((s) => (
                  <option key={s} value={s}>
                    {STATUS_LABELS[s]} ({counts[s]})
                  </option>
                ))}
              </select>
            )}
            <select value={typeF} onChange={(e) => setParam('type', e.target.value)}>
              <option value="">Todos los tipos</option>
              {TYPES.map((t) => (
                <option key={t} value={t}>
                  {TYPE_ICONS[t]} {TYPE_LABELS[t]}
                </option>
              ))}
            </select>
            <select value={prioF} onChange={(e) => setParam('priority', e.target.value)}>
              <option value="">Toda prioridad</option>
              {PRIORITIES.map((p) => (
                <option key={p} value={p}>
                  {PRIORITY_LABELS[p]}
                </option>
              ))}
            </select>
            <input className="issues-assignee" list="issues-assignees" placeholder="Responsable" value={assignee} onChange={(e) => setAssignee(e.target.value)} />
            <datalist id="issues-assignees">
              <option value="none">Sin asignar</option>
              {[...new Set([...members, ...all.map((i) => i.assignee).filter(Boolean)])].map((m) => (
                <option key={m} value={m} />
              ))}
            </datalist>
          </div>
        )}
      </div>
      {error && <div className="issue-error">⚠ {error}</div>}

      {data && all.length === 0 && (
        <div className="issues-empty">
          <ListChecks size={40} strokeWidth={1.4} />
          <p>Todavía no hay elementos. Crea el primero, conviértelo desde una idea o pídele a Claude «apunta como bloqueo que…».</p>
        </div>
      )}

      {all.length > 0 && view === 'list' && (
        <table className="issues-table">
          <thead>
            <tr>
              <th>Clave</th>
              <th />
              <th>Título</th>
              <th>Estado</th>
              <th>Prioridad</th>
              <th>Responsable</th>
              <th>Fecha límite</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {filtered.map((i) => (
              <Row key={i.id} i={i} onOpen={() => navigate(`/p/${i.id}`)} />
            ))}
            {!filtered.length && (
              <tr>
                <td colSpan={8} className="issue-hint">
                  Ningún elemento coincide con los filtros.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      )}

      {all.length > 0 && view === 'board' && (
        <div className="issues-board">
          {STATUSES.map((s) => (
            <section
              key={s}
              className={`issues-column status-${s}`}
              onDragOver={(e) => e.dataTransfer.types.includes('text/nonotion-issue') && e.preventDefault()}
              onDrop={(e) => {
                const id = e.dataTransfer.getData('text/nonotion-issue');
                if (id) moveTo(id, s);
              }}
            >
              <h3>
                {STATUS_LABELS[s]} <span className="issues-count">{filtered.filter((i) => i.status === s).length}</span>
              </h3>
              {filtered
                .filter((i) => i.status === s)
                .map((i) => (
                  <Card
                    key={i.id}
                    i={i}
                    onOpen={() => navigate(`/p/${i.id}`)}
                    onDragStart={(e) => e.dataTransfer.setData('text/nonotion-issue', i.id)}
                  />
                ))}
            </section>
          ))}
        </div>
      )}

      {all.length > 0 && view === 'blocked' && (
        <div className="issues-blocked">
          {!blocked.length && <p className="issue-hint">Nada bloqueado ahora mismo. 🎉</p>}
          {blocked.map((i) => (
            <BlockedItem key={i.id} i={i} onOpen={(id) => navigate(`/p/${id}`)} />
          ))}
        </div>
      )}

      {creating && <NewIssueDialog members={members} onCreate={create} onClose={() => setCreating(false)} />}
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
  const by = (d?.incoming || []).filter((l) => l.type === 'blocks' && OPEN_STATUSES.has(l.source.status));
  const blocks = (d?.links || []).filter((l) => l.type === 'blocks');
  const docs = (d?.links || []).filter((l) => l.type === 'documents');
  return (
    <div className={`issue-blocked-item prio-${i.priority}`}>
      <button className="issue-blocked-main" onClick={() => onOpen(i.id)}>
        <span className="issue-key">{i.key}</span> {TYPE_ICONS[i.type]} <strong>{i.title}</strong> <StatusPill status={i.status} />
        <span className={`prio prio-${i.priority}`}>{PRIORITY_LABELS[i.priority]}</span>
        {i.assignee && <span className="issue-assignee">· {i.assignee}</span>}
        {i.due_date && <span className={'issue-due' + (overdue(i) ? ' overdue' : '')}>· {i.due_date}</span>}
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
