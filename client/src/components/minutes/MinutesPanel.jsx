import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { Wand2, Check, X, RotateCcw, Sparkles, Copy } from 'lucide-react';
import { api } from '../../api.js';

// Acta de reunión: cabecera (fecha, proyecto, asistentes) y bandeja de
// propuestas que nada crea hasta que se aprueba.

export const ITEM_TYPES = ['task', 'list', 'doc', 'idea', 'event'];
export const ITEM_LABELS = { task: 'Tarea', list: 'Lista', doc: 'Documentación', idea: 'Idea', event: 'Evento' };
export const ITEM_ICONS = { task: '🎫', list: '📋', doc: '📄', idea: '💡', event: '📅' };
const SOURCE_LABELS = { auto: 'detectada', claude: 'Claude', manual: 'manual', api: 'API' };
const TEMPLATES = { issues: 'Issues', blockers: 'Bloqueos', todo: 'To-do', topics: 'Temas', blank: 'En blanco' };
const ICON = { size: 14, strokeWidth: 1.9 };

export function useMinutes(pageId, enabled, pageEvent) {
  const [detail, setDetail] = useState(null);
  const want = useRef(pageId);
  want.current = pageId;
  const load = useCallback(async () => {
    if (!enabled) return;
    try {
      const d = await api.minutes(pageId);
      if (want.current === pageId) setDetail(d);
    } catch {}
  }, [pageId, enabled]);
  useEffect(() => {
    setDetail(null);
    load();
  }, [load]);
  useEffect(() => {
    if (pageEvent && pageEvent.id === pageId) load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pageEvent]);
  return { detail, setDetail, load };
}

// Fecha, proyecto y asistentes (bajo el título)
export function MinutesHeader({ detail, pages, onChange }) {
  const [attendees, setAttendees] = useState(detail.attendees.join(', '));
  useEffect(() => setAttendees(detail.attendees.join(', ')), [detail.attendees]);
  const projects = pages.filter((p) => !p.kind || p.kind === 'doc').sort((a, b) => (a.title || '').localeCompare(b.title || '', 'es'));
  return (
    <div className="minutes-header">
      <label className="issue-field">
        <span>Fecha</span>
        <input type="date" className="field-input" value={detail.date || ''} onChange={(e) => e.target.value && onChange({ date: e.target.value })} />
      </label>
      <label className="issue-field">
        <span>Proyecto</span>
        <select className="field-input" value={detail.project?.id || ''} onChange={(e) => onChange({ project_id: e.target.value || null })}>
          <option value="">(sin proyecto)</option>
          {projects.map((p) => (
            <option key={p.id} value={p.id}>
              {p.icon || '📄'} {p.title || 'Sin título'}
            </option>
          ))}
        </select>
      </label>
      <label className="issue-field minutes-attendees">
        <span>Asistentes</span>
        <input
          className="field-input"
          placeholder="Ana, Luis, Equipo AXA…"
          value={attendees}
          onChange={(e) => setAttendees(e.target.value)}
          onBlur={() => attendees !== detail.attendees.join(', ') && onChange({ attendees })}
          onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
        />
      </label>
      {detail.project && (
        <Link className="minutes-project-link" to={`/p/${detail.project.id}`}>
          Abrir proyecto →
        </Link>
      )}
    </div>
  );
}

// Una propuesta pendiente: se puede ajustar antes de aprobar
function Proposal({ item, trackers, pages, selected, onSelect, onApprove, onReject, onOverrides, busy }) {
  const [title, setTitle] = useState(item.title);
  const [p, setP] = useState(item.payload);
  const [type, setType] = useState(item.type);
  useEffect(() => {
    setTitle(item.title);
    setP(item.payload);
    setType(item.type);
  }, [item]);
  const set = (k, v) => setP((x) => ({ ...x, [k]: v || undefined }));
  const suggested =
    type === 'task' && !p.tracker_id
      ? trackers.find((t) => (p.tracker_hint === 'blockers' ? /bloq|blq|riesgo|imped/i : /to-?do|tarea|acci|pendiente/i).test(`${t.title} ${t.prefix}`))
      : null;
  const parents = pages.filter((x) => !x.kind || x.kind === 'doc');
  const overrides = () => ({ type, title, payload: { ...p, ...(type === 'task' && !p.tracker_id && suggested ? { tracker_id: suggested.id } : {}) } });
  // los ajustes también valen para «Aprobar seleccionadas»
  useEffect(() => {
    onOverrides?.(overrides());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [type, title, p, suggested?.id]);
  return (
    <div className={`proposal type-${type}`}>
      <div className="proposal-head">
        <input type="checkbox" checked={selected} onChange={(e) => onSelect(e.target.checked)} title="Incluir en «Aprobar seleccionadas»" />
        <select value={type} onChange={(e) => setType(e.target.value)} className="proposal-type">
          {ITEM_TYPES.map((t) => (
            <option key={t} value={t}>
              {ITEM_ICONS[t]} {ITEM_LABELS[t]}
            </option>
          ))}
        </select>
        <input className="proposal-title" value={title} onChange={(e) => setTitle(e.target.value)} />
        <span className="proposal-source">{SOURCE_LABELS[item.source] || item.source}</span>
        <button className="btn small primary" disabled={busy} onClick={() => onApprove(overrides())} title="Crear y enlazar con el acta">
          <Check {...ICON} /> Aprobar
        </button>
        <button className="btn small" disabled={busy} onClick={onReject} title="Descartar (se puede recuperar)">
          <X {...ICON} />
        </button>
      </div>
      <div className="proposal-opts">
        {type === 'task' && (
          <>
            <label>
              Lista
              <select value={p.tracker_id || suggested?.id || ''} onChange={(e) => set('tracker_id', e.target.value)}>
                <option value="">— elige —</option>
                {trackers.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.icon} {t.title} ({t.prefix})
                  </option>
                ))}
              </select>
            </label>
            <label>
              Responsable
              <input value={p.assignee || ''} placeholder="—" onChange={(e) => set('assignee', e.target.value)} />
            </label>
            <label>
              Fecha límite
              <input type="date" value={p.date || ''} onChange={(e) => set('date', e.target.value)} />
            </label>
          </>
        )}
        {type === 'event' && (
          <label>
            Fecha
            <input type="date" value={p.date || ''} onChange={(e) => set('date', e.target.value)} />
          </label>
        )}
        {type === 'list' && (
          <label>
            Plantilla
            <select value={p.template || 'todo'} onChange={(e) => set('template', e.target.value)}>
              {Object.entries(TEMPLATES).map(([k, v]) => (
                <option key={k} value={k}>
                  {v}
                </option>
              ))}
            </select>
          </label>
        )}
        {(type === 'doc' || type === 'event' || type === 'list') && (
          <label>
            Dentro de
            <select value={p.parent_id || ''} onChange={(e) => set('parent_id', e.target.value)}>
              <option value="">(el proyecto del acta)</option>
              {parents.map((x) => (
                <option key={x.id} value={x.id}>
                  {x.icon || '📄'} {x.title || 'Sin título'}
                </option>
              ))}
            </select>
          </label>
        )}
        {item.details && item.details !== item.title && <span className="proposal-details">{item.details}</span>}
      </div>
    </div>
  );
}

export function MinutesProposals({ detail, pages, onChanged }) {
  const [trackers, setTrackers] = useState([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [info, setInfo] = useState(null);
  const [selected, setSelected] = useState({});
  const [claudeOpen, setClaudeOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const [manual, setManual] = useState('');
  const [manualType, setManualType] = useState('task');
  const overridesRef = useRef({});

  useEffect(() => {
    api
      .trackers()
      .then((r) => setTrackers(r.trackers))
      .catch(() => {});
  }, [pages]);

  const pending = detail.items.filter((i) => i.status === 'pending');
  const created = detail.items.filter((i) => i.status === 'created');
  const rejected = detail.items.filter((i) => i.status === 'rejected');
  const counts = useMemo(() => ({ pending: pending.length, created: created.length, rejected: rejected.length }), [pending, created, rejected]);

  const run = async (fn, msg) => {
    setBusy(true);
    setError(null);
    setInfo(null);
    try {
      const r = await fn();
      if (msg) setInfo(typeof msg === 'function' ? msg(r) : msg);
      await onChanged();
    } catch (e) {
      setError(e.message);
      await onChanged();
    } finally {
      setBusy(false);
    }
  };
  const approve = (it, overrides) => run(() => api.approveMinutesItem(detail.page_id, it.id, overrides));
  const approveSelected = () =>
    run(async () => {
      const ids = pending.filter((i) => selected[i.id]);
      const errors = [];
      for (const it of ids) {
        try {
          await api.approveMinutesItem(detail.page_id, it.id, overridesRef.current[it.id] || {});
        } catch (e) {
          errors.push(`«${it.title}»: ${e.message}`);
        }
      }
      setSelected({});
      if (errors.length) throw new Error(errors.join(' · '));
    });

  const prompt = `Lee el acta «${detail.title}» (id: ${detail.page_id}) de NoNotion con read_page y, con list_trackers para elegir las listas, añade con propose_from_minutes lo que debería salir de ella: tareas con responsable y fecha, documentación, ideas y eventos de calendario. No crees nada directamente: lo apruebo yo en la app.`;

  return (
    <section className="minutes-proposals">
      <div className="minutes-proposals-head">
        <h3>
          📥 Propuestas del acta
          {counts.pending > 0 && <span className="issues-count danger">{counts.pending} por aprobar</span>}
        </h3>
        <div className="minutes-proposals-actions">
          <button className="btn" disabled={busy} onClick={() => run(() => api.detectMinutes(detail.page_id), (r) => (r.added ? `${r.added} propuesta(s) nuevas detectadas en el texto` : 'No hay nada nuevo que proponer en el texto'))}>
            <Wand2 {...ICON} /> Detectar en el texto
          </button>
          <button className={'btn' + (claudeOpen ? ' active' : '')} onClick={() => setClaudeOpen((v) => !v)}>
            <Sparkles {...ICON} /> Con Claude
          </button>
          {pending.length > 0 && (
            <button
              className="btn primary"
              disabled={busy || !pending.some((i) => selected[i.id])}
              onClick={approveSelected}
              title="Crea todas las seleccionadas"
            >
              <Check {...ICON} /> Aprobar seleccionadas
            </button>
          )}
        </div>
      </div>
      {claudeOpen && (
        <div className="minutes-claude">
          <p className="issue-hint">
            En claude.ai, con el conector de NoNotion, pega esto. Claude analizará el acta y dejará aquí sus propuestas; tú decides cuáles se crean.
          </p>
          <pre className="idea-prompt">{prompt}</pre>
          <button
            className="btn small"
            onClick={async () => {
              try {
                await navigator.clipboard.writeText(prompt);
                setCopied(true);
                setTimeout(() => setCopied(false), 1500);
              } catch {}
            }}
          >
            <Copy {...ICON} /> {copied ? 'Copiado' : 'Copiar'}
          </button>
        </div>
      )}
      <p className="issue-hint">
        Nada se crea hasta que lo apruebas. «Detectar» lee las tareas <code>- [ ]</code> (con <code>@persona</code> y fecha), las secciones Decisiones, Ideas y
        Riesgos, y «Próxima reunión: fecha».
      </p>
      {error && <div className="issue-error">⚠ {error}</div>}
      {info && <div className="minutes-info">{info}</div>}

      {pending.length > 0 && (
        <div className="minutes-select-all">
          <label>
            <input
              type="checkbox"
              checked={pending.every((i) => selected[i.id])}
              onChange={(e) => setSelected(e.target.checked ? Object.fromEntries(pending.map((i) => [i.id, true])) : {})}
            />{' '}
            Seleccionar todas
          </label>
        </div>
      )}
      {pending.map((it) => (
        <Proposal
          key={it.id}
          item={it}
          trackers={trackers}
          pages={pages}
          busy={busy}
          selected={Boolean(selected[it.id])}
          onSelect={(v) => setSelected((s) => ({ ...s, [it.id]: v }))}
          onApprove={(o) => approve(it, o)}
          onOverrides={(o) => (overridesRef.current[it.id] = o)}
          onReject={() => run(() => api.rejectMinutesItem(detail.page_id, it.id))}
        />
      ))}
      {!pending.length && <p className="issue-hint">No hay propuestas pendientes.</p>}

      <div className="minutes-manual">
        <select value={manualType} onChange={(e) => setManualType(e.target.value)}>
          {ITEM_TYPES.map((t) => (
            <option key={t} value={t}>
              {ITEM_ICONS[t]} {ITEM_LABELS[t]}
            </option>
          ))}
        </select>
        <input
          placeholder="Añadir una propuesta a mano…"
          value={manual}
          onChange={(e) => setManual(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && manual.trim()) {
              const title = manual.trim();
              run(async () => {
                await api.proposeMinutes(detail.page_id, [{ type: manualType, title }]);
                setManual('');
              });
            }
          }}
        />
      </div>

      {created.length > 0 && (
        <div className="minutes-done">
          <h4>✅ Creado desde el acta ({created.length})</h4>
          {created.map((it) => (
            <div key={it.id} className="minutes-done-item">
              <span>{ITEM_ICONS[it.type]}</span>
              {it.result ? (
                <Link to={`/p/${it.result.id}`}>{it.result.title}</Link>
              ) : (
                <span>{it.title}</span>
              )}
              <span className="issue-hint">
                {ITEM_LABELS[it.type]}
                {it.decided_by ? ` · aprobada por ${it.decided_by}` : ''}
              </span>
            </div>
          ))}
        </div>
      )}
      {rejected.length > 0 && (
        <details className="minutes-rejected">
          <summary>Descartadas ({rejected.length})</summary>
          {rejected.map((it) => (
            <div key={it.id} className="minutes-done-item">
              <span>{ITEM_ICONS[it.type]}</span> <s>{it.title}</s>
              <button className="btn small" onClick={() => run(() => api.reopenMinutesItem(detail.page_id, it.id))}>
                <RotateCcw size={12} /> Recuperar
              </button>
            </div>
          ))}
        </details>
      )}
    </section>
  );
}
