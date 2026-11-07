import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import MarkdownIt from 'markdown-it';
import { Plus, Trash2, Send, Link2 } from 'lucide-react';
import { api } from '../../api.js';
import {
  STATUSES,
  STATUS_LABELS,
  TYPES,
  TYPE_LABELS,
  TYPE_ICONS,
  PRIORITIES,
  PRIORITY_LABELS,
  LINK_TYPES,
  LINK_LABELS,
  LINK_INVERSE,
  FIELD_LABELS,
  valueLabel,
  fmtWhen,
  overdue,
} from './model.js';

// Panel de un elemento de seguimiento (encima y debajo de su descripción):
// campos (estado, tipo, prioridad, responsable, fecha, hito), relaciones con
// tipo, menciones y cronología con comentarios.

const md = new MarkdownIt({ html: false, linkify: true, breaks: true });
const ICON = { size: 14, strokeWidth: 1.9 };

export function StatusPill({ status }) {
  return <span className={`issue-status status-${status}`}>{STATUS_LABELS[status] || status}</span>;
}

export function IssueRefLink({ t }) {
  if (!t) return null;
  return (
    <Link to={`/p/${t.id}`} className={'issue-link-target' + (t.status ? ` status-${t.status}` : '')}>
      <span className="issue-link-icon">{t.icon || (t.kind === 'canvas' ? '🧩' : t.kind === 'idea' ? '💡' : '📄')}</span>
      {t.key && <span className="issue-key">{t.key}</span>}
      <span className="issue-link-title">{t.title || 'Sin título'}</span>
      {t.status && <StatusPill status={t.status} />}
    </Link>
  );
}

// Selector de página o elemento destino
function TargetPicker({ pages, exclude, onPick }) {
  const [q, setQ] = useState('');
  const list = useMemo(() => {
    const t = q.trim().toLowerCase();
    return pages
      .filter((p) => p.id !== exclude)
      .filter((p) => !t || (p.title || '').toLowerCase().includes(t) || (p.issue_key || '').toLowerCase().includes(t))
      .sort((a, b) => (b.updated_at || '').localeCompare(a.updated_at || ''))
      .slice(0, 10);
  }, [pages, q, exclude]);
  return (
    <div className="issue-picker">
      <input autoFocus placeholder="Buscar página, idea o elemento (AXA-12)…" value={q} onChange={(e) => setQ(e.target.value)} />
      <div className="issue-picker-list">
        {list.map((p) => (
          <button key={p.id} onClick={() => onPick(p)}>
            <span>{p.icon || (p.kind === 'canvas' ? '🧩' : p.kind === 'idea' ? '💡' : '📄')}</span>
            {p.issue_key && <span className="issue-key">{p.issue_key}</span>}
            <span className="issue-link-title">{p.title || 'Sin título'}</span>
          </button>
        ))}
        {!list.length && <div className="issue-hint">Sin coincidencias</div>}
      </div>
    </div>
  );
}

// Campos del elemento: van justo bajo el título
export function IssueFields({ detail, members = [], onUpdate, readOnly }) {
  const [assignee, setAssignee] = useState(detail.assignee || '');
  const [milestone, setMilestone] = useState(detail.milestone || '');
  useEffect(() => setAssignee(detail.assignee || ''), [detail.assignee]);
  useEffect(() => setMilestone(detail.milestone || ''), [detail.milestone]);
  const commitText = (field, value) => {
    const v = value.trim() || null;
    if (v !== (detail[field] || null)) onUpdate({ [field]: v });
  };
  return (
    <div className="issue-fields">
      <span className="issue-key big">{detail.key}</span>
      <label className="issue-field">
        <span>Estado</span>
        <select className={`status-${detail.status}`} value={detail.status} disabled={readOnly} onChange={(e) => onUpdate({ status: e.target.value })}>
          {STATUSES.map((s) => (
            <option key={s} value={s}>
              {STATUS_LABELS[s]}
            </option>
          ))}
        </select>
      </label>
      <label className="issue-field">
        <span>Tipo</span>
        <select value={detail.type} disabled={readOnly} onChange={(e) => onUpdate({ type: e.target.value })}>
          {TYPES.map((t) => (
            <option key={t} value={t}>
              {TYPE_ICONS[t]} {TYPE_LABELS[t]}
            </option>
          ))}
        </select>
      </label>
      <label className="issue-field">
        <span>Prioridad</span>
        <select className={`prio-${detail.priority}`} value={detail.priority} disabled={readOnly} onChange={(e) => onUpdate({ priority: e.target.value })}>
          {PRIORITIES.map((p) => (
            <option key={p} value={p}>
              {PRIORITY_LABELS[p]}
            </option>
          ))}
        </select>
      </label>
      <label className="issue-field">
        <span>Responsable</span>
        <input
          list="issue-assignees"
          value={assignee}
          placeholder="Sin asignar"
          disabled={readOnly}
          onChange={(e) => setAssignee(e.target.value)}
          onBlur={() => commitText('assignee', assignee)}
          onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
        />
        <datalist id="issue-assignees">
          {members.map((m) => (
            <option key={m} value={m} />
          ))}
        </datalist>
      </label>
      <label className={'issue-field' + (overdue(detail) ? ' overdue' : '')}>
        <span>Fecha límite</span>
        <input type="date" value={detail.due_date || ''} disabled={readOnly} onChange={(e) => onUpdate({ due_date: e.target.value || null })} />
      </label>
      <label className="issue-field">
        <span>Hito</span>
        <input
          value={milestone}
          placeholder="—"
          disabled={readOnly}
          onChange={(e) => setMilestone(e.target.value)}
          onBlur={() => commitText('milestone', milestone)}
          onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
        />
      </label>
      {detail.blocked_by_open > 0 && <span className="issue-blocked-badge">⛔ Bloqueado por {detail.blocked_by_open}</span>}
    </div>
  );
}

// Relaciones, menciones y cronología: van debajo de la descripción
export function IssueActivity({ detail, pages, onChanged, readOnly }) {
  const [adding, setAdding] = useState(false);
  const [linkType, setLinkType] = useState('documents');
  const [comment, setComment] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const run = async (fn) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      await onChanged();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };

  const groups = [];
  for (const t of LINK_TYPES) {
    const out = detail.links.filter((l) => l.type === t).map((l) => ({ id: l.id, target: l.target }));
    if (out.length) groups.push({ label: LINK_LABELS[t], items: out });
  }
  for (const t of LINK_TYPES) {
    const inc = detail.incoming.filter((l) => l.type === t).map((l) => ({ id: l.id, target: l.source, incoming: true }));
    if (inc.length) groups.push({ label: LINK_INVERSE[t] + (t === 'relates' ? ' (desde el otro)' : ''), items: inc });
  }

  return (
    <div className="issue-activity">
      <section className="issue-section">
        <h3>
          <Link2 {...ICON} /> Relaciones
        </h3>
        {groups.map((g) => (
          <div key={g.label} className="issue-rel-group">
            <div className="issue-rel-label">{g.label}</div>
            {g.items.map((it) => (
              <div key={`${g.label}-${it.id}`} className="issue-rel-item">
                <IssueRefLink t={it.target} />
                {!readOnly && (
                  <button className="icon-btn danger" title="Quitar relación" onClick={() => run(() => api.unlinkIssue(detail.page_id, it.id))}>
                    <Trash2 {...ICON} />
                  </button>
                )}
              </div>
            ))}
          </div>
        ))}
        {detail.mentions?.length > 0 && (
          <div className="issue-rel-group">
            <div className="issue-rel-label">Mencionado en</div>
            {detail.mentions.map((m) => (
              <div key={m.id} className="issue-rel-item">
                <IssueRefLink t={m} />
              </div>
            ))}
          </div>
        )}
        {!groups.length && !detail.mentions?.length && <p className="issue-hint">Sin relaciones. Enlaza las páginas de AXA que lo documentan, de dónde sale o qué bloquea.</p>}
        {!readOnly &&
          (adding ? (
            <div className="issue-add-link">
              <select value={linkType} onChange={(e) => setLinkType(e.target.value)}>
                {LINK_TYPES.map((t) => (
                  <option key={t} value={t}>
                    {LINK_LABELS[t]}
                  </option>
                ))}
              </select>
              <TargetPicker
                pages={linkType === 'blocks' ? pages.filter((p) => p.kind === 'issue') : pages}
                exclude={detail.page_id}
                onPick={(p) =>
                  run(async () => {
                    await api.linkIssue(detail.page_id, linkType, p.id);
                    setAdding(false);
                  })
                }
              />
              <button className="btn" onClick={() => setAdding(false)}>
                Cancelar
              </button>
            </div>
          ) : (
            <button className="btn" onClick={() => setAdding(true)} disabled={busy}>
              <Plus {...ICON} /> Relacionar
            </button>
          ))}
      </section>

      <section className="issue-section">
        <h3>Cronología</h3>
        <ol className="issue-timeline">
          {detail.events.map((e) => (
            <li key={e.id} className={`issue-event kind-${e.kind}`}>
              <div className="issue-event-head">
                <span className={'issue-by' + (/^Claude/.test(e.by || '') ? ' claude' : '')}>{e.by || '?'}</span>
                <span className="issue-when">{fmtWhen(e.at)}</span>
              </div>
              {e.kind === 'created' && <div>creó el elemento</div>}
              {e.kind === 'change' && (
                <div>
                  {FIELD_LABELS[e.data.field] || e.data.field}: <s>{valueLabel(e.data.field, e.data.from)}</s> → <strong>{valueLabel(e.data.field, e.data.to)}</strong>
                </div>
              )}
              {e.kind === 'link' && (
                <div>
                  {LINK_LABELS[e.data.type]} <Link to={`/p/${e.data.target_id}`}>«{e.data.title || e.data.target_id}»</Link>
                </div>
              )}
              {e.kind === 'unlink' && (
                <div>
                  quitó «{LINK_LABELS[e.data.type]}» «{e.data.title || e.data.target_id}»
                </div>
              )}
              {e.kind === 'comment' && <div className="issue-comment" dangerouslySetInnerHTML={{ __html: md.render(e.text || '') }} />}
            </li>
          ))}
        </ol>
        {!readOnly && (
          <div className="issue-comment-box">
            <textarea
              placeholder="Comentario o avance (Markdown). Ctrl+Enter para enviar."
              value={comment}
              rows={3}
              onChange={(e) => setComment(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && comment.trim()) {
                  run(async () => {
                    await api.updateIssue(detail.page_id, { comment });
                    setComment('');
                  });
                }
              }}
            />
            <button
              className="btn primary"
              disabled={!comment.trim() || busy}
              onClick={() =>
                run(async () => {
                  await api.updateIssue(detail.page_id, { comment });
                  setComment('');
                })
              }
            >
              <Send {...ICON} /> Comentar
            </button>
          </div>
        )}
        {error && <div className="issue-error">⚠ {error}</div>}
      </section>
    </div>
  );
}

// Carga y mantiene al día el detalle de un elemento (para PageView)
export function useIssue(pageId, enabled, pageEvent) {
  const [detail, setDetail] = useState(null);
  const [error, setError] = useState(null);
  const want = useRef(pageId);
  want.current = pageId;
  const load = useCallback(async () => {
    if (!enabled) return;
    try {
      const d = await api.issue(pageId);
      if (want.current === pageId) setDetail(d);
    } catch (e) {
      setError(e.message);
    }
  }, [pageId, enabled]);
  useEffect(() => {
    setDetail(null);
    load();
  }, [load]);
  useEffect(() => {
    if (pageEvent && pageEvent.id === pageId) load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pageEvent]);
  const update = async (patch) => {
    setError(null);
    try {
      const d = await api.updateIssue(pageId, patch);
      setDetail(d);
      return d;
    } catch (e) {
      setError(e.message);
      return null;
    }
  };
  return { detail, error, load, update };
}
