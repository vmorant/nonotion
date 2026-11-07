import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Plus, Settings2, LayoutList, Columns3, Search, ArrowUp, ArrowDown, Trash2, X, GripVertical } from 'lucide-react';
import { api } from '../../api.js';
import { FieldEditor, OptionMenu, Pill, StatusPill } from './fields.jsx';
import { TargetPicker, IssueRefLink } from './IssuePanel.jsx';
import MoveDialog from '../MoveDialog.jsx';
import {
  CATEGORIES,
  CATEGORY_LABELS,
  FIELD_TYPES,
  FIELD_TYPE_LABELS,
  FIELD_TYPE_ICONS,
  COLORS,
  COLOR_LABELS,
  DATE_ROLES,
  DATE_ROLE_LABELS,
  LINK_LABELS,
  LINK_INVERSE,
  newId,
  valueLabel,
  peopleIn,
} from './model.js';

// Una lista de seguimiento: tabla editable en línea o tablero agrupado por
// cualquier desplegable, con filtros, alta rápida y configuración de campos.

const ICON = { size: 15, strokeWidth: 1.9 };
const readPref = (k, d) => {
  try {
    return JSON.parse(localStorage.getItem(k)) ?? d;
  } catch {
    return d;
  }
};
const writePref = (k, v) => {
  try {
    localStorage.setItem(k, JSON.stringify(v));
  } catch {}
};

// ---------- Configuración: estados, campos y opciones ----------

function OptionsEditor({ options, onChange }) {
  return (
    <div className="cfg-options">
      {options.map((o, i) => (
        <div key={o.id} className="cfg-option">
          <select className={`cfg-color tag-${o.color}`} value={o.color} title="Color" onChange={(e) => onChange(options.map((x, j) => (j === i ? { ...x, color: e.target.value } : x)))}>
            {COLORS.map((c) => (
              <option key={c} value={c}>
                {COLOR_LABELS[c]}
              </option>
            ))}
          </select>
          <input value={o.name} onChange={(e) => onChange(options.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))} />
          <button type="button" className="icon-btn danger" title="Quitar opción" onClick={() => onChange(options.filter((_, j) => j !== i))}>
            <X size={13} />
          </button>
        </div>
      ))}
      <button type="button" className="btn small" onClick={() => onChange([...options, { id: newId(), name: `Opción ${options.length + 1}`, color: COLORS[(options.length + 1) % COLORS.length] }])}>
        <Plus size={13} /> Opción
      </button>
    </div>
  );
}

function TrackerSettings({ detail, onSave, onClose }) {
  const [prefix, setPrefix] = useState(detail.prefix);
  const [statuses, setStatuses] = useState(detail.config.statuses);
  const [fields, setFields] = useState(detail.config.fields);
  const [moveTo, setMoveTo] = useState({}); // estado borrado → a dónde van sus tickets
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const inUse = useMemo(() => {
    const m = {};
    for (const i of detail.issues) m[i.status] = (m[i.status] || 0) + 1;
    return m;
  }, [detail.issues]);
  const removed = detail.config.statuses.filter((s) => !statuses.some((x) => x.id === s.id) && inUse[s.id]);

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      await onSave({ prefix, config: { statuses, fields }, move_status: moveTo });
      onClose();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="tracker-settings">
        <div className="tracker-settings-head">
          <strong>Campos y estados</strong>
          <button className="icon-btn" onClick={onClose} title="Cerrar">
            <X size={16} />
          </button>
        </div>
        <div className="tracker-settings-body">
          <section>
            <h4>Prefijo de las claves</h4>
            <div className="cfg-row">
              <input className="cfg-prefix" value={prefix} maxLength={10} onChange={(e) => setPrefix(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ''))} />
              <span className="issue-hint">
                Tickets: {prefix || '?'}-1, {prefix || '?'}-2… Si lo cambias, las menciones con el prefijo antiguo dejan de enlazarse.
              </span>
            </div>
          </section>

          <section>
            <h4>Estados</h4>
            <p className="issue-hint">La categoría dice qué significa cada estado: pendiente, en curso, bloqueado o hecho (cerrado).</p>
            {statuses.map((s, i) => (
              <div key={s.id} className="cfg-row">
                <select className={`cfg-color tag-${s.color}`} value={s.color} title="Color" onChange={(e) => setStatuses(statuses.map((x, j) => (j === i ? { ...x, color: e.target.value } : x)))}>
                  {COLORS.map((c) => (
                    <option key={c} value={c}>
                      {COLOR_LABELS[c]}
                    </option>
                  ))}
                </select>
                <input value={s.name} onChange={(e) => setStatuses(statuses.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))} />
                <select value={s.category} onChange={(e) => setStatuses(statuses.map((x, j) => (j === i ? { ...x, category: e.target.value } : x)))}>
                  {CATEGORIES.map((c) => (
                    <option key={c} value={c}>
                      {CATEGORY_LABELS[c]}
                    </option>
                  ))}
                </select>
                <span className="cfg-count">{inUse[s.id] ? `${inUse[s.id]} ticket(s)` : ''}</span>
                <button
                  type="button"
                  className="icon-btn danger"
                  title="Quitar estado"
                  disabled={statuses.length === 1}
                  onClick={() => setStatuses(statuses.filter((_, j) => j !== i))}
                >
                  <Trash2 size={13} />
                </button>
              </div>
            ))}
            {removed.map((s) => (
              <div key={s.id} className="cfg-row warn">
                «{s.name}» tiene {inUse[s.id]} ticket(s); pasan a:
                <select value={moveTo[s.id] || ''} onChange={(e) => setMoveTo({ ...moveTo, [s.id]: e.target.value })}>
                  <option value="">— elige —</option>
                  {statuses.map((x) => (
                    <option key={x.id} value={x.id}>
                      {x.name}
                    </option>
                  ))}
                </select>
              </div>
            ))}
            <button type="button" className="btn small" onClick={() => setStatuses([...statuses, { id: newId(), name: 'Nuevo estado', category: 'doing', color: 'yellow' }])}>
              <Plus size={13} /> Estado
            </button>
          </section>

          <section>
            <h4>Campos</h4>
            {!fields.length && <p className="issue-hint">Solo título y estado. Añade los campos que necesites.</p>}
            {fields.map((f, i) => (
              <div key={f.id} className="cfg-field">
                <div className="cfg-row">
                  <span className="cfg-type" title={FIELD_TYPE_LABELS[f.type]}>
                    {FIELD_TYPE_ICONS[f.type]}
                  </span>
                  <input value={f.name} onChange={(e) => setFields(fields.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))} />
                  <span className="cfg-count">{FIELD_TYPE_LABELS[f.type]}</span>
                  <label className="cfg-hide" title="No mostrar en la tabla (sigue en cada ticket)">
                    <input type="checkbox" checked={Boolean(f.hidden)} onChange={(e) => setFields(fields.map((x, j) => (j === i ? { ...x, hidden: e.target.checked } : x)))} /> oculto
                  </label>
                  <button type="button" className="icon-btn" title="Subir" disabled={i === 0} onClick={() => setFields(fields.map((x, j) => (j === i - 1 ? fields[i] : j === i ? fields[i - 1] : x)))}>
                    <ArrowUp size={13} />
                  </button>
                  <button
                    type="button"
                    className="icon-btn"
                    title="Bajar"
                    disabled={i === fields.length - 1}
                    onClick={() => setFields(fields.map((x, j) => (j === i + 1 ? fields[i] : j === i ? fields[i + 1] : x)))}
                  >
                    <ArrowDown size={13} />
                  </button>
                  <button
                    type="button"
                    className="icon-btn danger"
                    title="Quitar campo"
                    onClick={() => confirm(`¿Quitar el campo «${f.name}»? Sus valores dejarán de verse en los tickets.`) && setFields(fields.filter((_, j) => j !== i))}
                  >
                    <Trash2 size={13} />
                  </button>
                </div>
                {(f.type === 'select' || f.type === 'multi') && (
                  <OptionsEditor options={f.options || []} onChange={(options) => setFields(fields.map((x, j) => (j === i ? { ...x, options } : x)))} />
                )}
                {f.type === 'date' && (
                  <div className="cfg-row cfg-sub">
                    <span className="issue-hint">En el calendario es</span>
                    <select value={f.date_role || 'other'} onChange={(e) => setFields(fields.map((x, j) => (j === i ? { ...x, date_role: e.target.value } : x)))}>
                      {DATE_ROLES.map((r) => (
                        <option key={r} value={r}>
                          {DATE_ROLE_LABELS[r]}
                        </option>
                      ))}
                    </select>
                  </div>
                )}
              </div>
            ))}
            <div className="cfg-add-field">
              {FIELD_TYPES.map((t) => (
                <button
                  type="button"
                  key={t}
                  className="btn small"
                  onClick={() =>
                    setFields([
                      ...fields,
                      {
                        id: newId(),
                        name: FIELD_TYPE_LABELS[t],
                        type: t,
                        ...(t === 'select' || t === 'multi' ? { options: [] } : {}),
                        ...(t === 'date' ? { date_role: 'deadline' } : {}),
                      },
                    ])
                  }
                >
                  {FIELD_TYPE_ICONS[t]} {FIELD_TYPE_LABELS[t]}
                </button>
              ))}
            </div>
          </section>
        </div>
        {error && <div className="issue-error">⚠ {error}</div>}
        <div className="tracker-settings-foot">
          <button className="btn" onClick={onClose}>
            Cancelar
          </button>
          <button className="btn primary" onClick={save} disabled={busy || removed.some((s) => !moveTo[s.id])}>
            {busy ? 'Guardando…' : 'Guardar'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ---------- Vista de la lista ----------

// Dónde está la lista (en una página o independiente) y con qué se relaciona
function TrackerContext({ detail, pages, onMove, onChanged }) {
  const [moving, setMoving] = useState(false);
  const [adding, setAdding] = useState(false);
  const [linkType, setLinkType] = useState('relates');
  const [error, setError] = useState(null);
  const parent = detail.parent_id ? pages.find((p) => p.id === detail.parent_id) : null;
  const self = pages.find((p) => p.id === detail.id) || { id: detail.id, title: 'Lista', kind: 'tracker' };
  const run = async (fn) => {
    setError(null);
    try {
      await fn();
      await onChanged();
    } catch (e) {
      setError(e.message);
    }
  };
  return (
    <div className="tracker-context">
      <div className="tracker-context-row">
        <span className="tracker-context-label">📍</span>
        {parent ? (
          <>
            En <IssueRefLink t={parent} />
          </>
        ) : (
          <span className="issue-hint">Lista independiente: no está en el árbol, solo en Listas y Seguimiento.</span>
        )}
        {onMove && (
          <>
            <button className="btn small" onClick={() => setMoving(true)}>
              {parent ? 'Cambiar de página' : 'Vincular a una página'}
            </button>
            {parent && (
              <button className="btn small" onClick={() => run(() => onMove(detail.id, null).then((e) => e && Promise.reject(new Error(e))))}>
                Sacar de la página
              </button>
            )}
          </>
        )}
      </div>
      <div className="tracker-context-row">
        <span className="tracker-context-label">🔗</span>
        {detail.links.map((l) => (
          <span key={l.id} className="tracker-link-chip" title={LINK_LABELS[l.type]}>
            <span className="issue-hint">{LINK_LABELS[l.type]}</span> <IssueRefLink t={l.target} />
            <button className="icon-btn" title="Quitar relación" onClick={() => run(() => api.unlinkIssue(detail.id, l.id))}>
              <X size={12} />
            </button>
          </span>
        ))}
        {detail.incoming?.map((l) => (
          <span key={`in-${l.id}`} className="tracker-link-chip">
            <span className="issue-hint">{LINK_INVERSE[l.type]}</span> <IssueRefLink t={l.source} />
          </span>
        ))}
        {!detail.links.length && !detail.incoming?.length && !adding && <span className="issue-hint">Sin relaciones</span>}
        {adding ? (
          <div className="issue-add-link">
            <select value={linkType} onChange={(e) => setLinkType(e.target.value)}>
              {['relates', 'documents', 'origin'].map((t) => (
                <option key={t} value={t}>
                  {LINK_LABELS[t]}
                </option>
              ))}
            </select>
            <TargetPicker
              pages={pages.filter((p) => p.kind !== 'issue' || p.parent_id !== detail.id)}
              exclude={detail.id}
              onPick={(p) =>
                run(async () => {
                  await api.linkIssue(detail.id, linkType, p.id);
                  setAdding(false);
                })
              }
            />
            <button className="btn small" onClick={() => setAdding(false)}>
              Cancelar
            </button>
          </div>
        ) : (
          <button className="btn small" onClick={() => setAdding(true)}>
            <Plus size={13} /> Relacionar la lista
          </button>
        )}
      </div>
      {error && <div className="issue-error">⚠ {error}</div>}
      {moving && (
        <MoveDialog
          page={self}
          pages={pages}
          onMove={async (id, parentId) => {
            const err = await onMove(id, parentId);
            if (!err) await onChanged();
            return err;
          }}
          onClose={() => setMoving(false)}
        />
      )}
    </div>
  );
}

export default function TrackerView({ pageId, pageEvent, members = [], pages = [], onMove, onTreeChange, readOnly = false, initial = null }) {
  const [detail, setDetail] = useState(initial);
  const [error, setError] = useState(null);
  const prefKey = `nn:tracker:${pageId}`;
  const [prefs, setPrefs] = useState(() => readPref(prefKey, {}));
  const [q, setQ] = useState('');
  const [filters, setFilters] = useState({}); // fieldId|'status' → [optionIds]
  const [newTitle, setNewTitle] = useState('');
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [sort, setSort] = useState({ by: 'number', dir: -1 });
  const navigate = useNavigate();
  const want = useRef(pageId);
  want.current = pageId;

  const load = useCallback(async () => {
    if (readOnly) return;
    try {
      const d = await api.tracker(pageId);
      if (want.current === pageId) setDetail(d);
    } catch (e) {
      setError(e.message);
    }
  }, [pageId, readOnly]);
  useEffect(() => {
    if (!initial) {
      setDetail(null);
      load();
    }
  }, [load, initial]);
  useEffect(() => {
    if (pageEvent && pageEvent.id === pageId) load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pageEvent]);

  const setPref = (k, v) => {
    const next = { ...prefs, [k]: v };
    setPrefs(next);
    writePref(prefKey, next);
  };

  const config = detail?.config;
  const mode = prefs.mode || config?.view?.mode || 'table';
  const groupBy = prefs.group_by || config?.view?.group_by || 'status';
  const hideDone = prefs.hide_done ?? false;
  const statusById = useMemo(() => new Map((config?.statuses || []).map((s) => [s.id, s])), [config]);
  const visibleFields = (config?.fields || []).filter((f) => !f.hidden);
  const filterable = (config?.fields || []).filter((f) => f.type === 'select' || f.type === 'multi');
  const people = useMemo(() => [...new Set([...members, ...(detail ? peopleIn(detail.issues, config) : [])])], [members, detail, config]);
  const peopleListId = `people-${pageId}`;

  const rows = useMemo(() => {
    if (!detail) return [];
    const t = q.trim().toLowerCase();
    let list = detail.issues.filter((i) => !t || i.key.toLowerCase().includes(t) || (i.title || '').toLowerCase().includes(t));
    if (hideDone) list = list.filter((i) => i.category !== 'done');
    for (const [fid, opts] of Object.entries(filters)) {
      if (!opts?.length) continue;
      list = list.filter((i) => {
        const v = fid === 'status' ? i.status : i.values[fid];
        return Array.isArray(v) ? v.some((x) => opts.includes(x)) : opts.includes(v);
      });
    }
    const field = config.fields.find((f) => f.id === sort.by);
    const keyOf = (i) => {
      if (sort.by === 'number') return i.number;
      if (sort.by === 'title') return (i.title || '').toLowerCase();
      if (sort.by === 'status') return config.statuses.findIndex((s) => s.id === i.status);
      const v = i.values[sort.by];
      if (field?.type === 'select') return v ? field.options.findIndex((o) => o.id === v) : 999;
      return v == null ? '￿' : typeof v === 'string' ? v.toLowerCase() : v;
    };
    return [...list].sort((a, b) => {
      const x = keyOf(a);
      const y = keyOf(b);
      return (x < y ? -1 : x > y ? 1 : 0) * sort.dir;
    });
  }, [detail, q, filters, sort, hideDone, config]);

  // Cambios: se aplican en local al momento y se confirman con el servidor
  const patchIssue = async (issueId, body) => {
    setError(null);
    try {
      const d = await api.updateIssue(issueId, body);
      setDetail((cur) => ({
        ...cur,
        issues: cur.issues.map((i) => (i.id === issueId ? { ...i, status: d.status, category: d.category, values: d.values } : i)),
      }));
      onTreeChange?.();
    } catch (e) {
      setError(e.message);
      load();
    }
  };
  const setField = (i, field, v) => patchIssue(i.id, { values: { [field.id]: v } });

  const create = async (extra = {}) => {
    const title = newTitle.trim();
    if (!title) return;
    setError(null);
    try {
      await api.createIssue({ tracker_id: pageId, title, ...extra });
      setNewTitle('');
      await load();
      onTreeChange?.();
    } catch (e) {
      setError(e.message);
    }
  };

  const saveSettings = async (body) => {
    const d = await api.updateTracker(pageId, body);
    setDetail(d);
    onTreeChange?.();
  };

  if (!detail) return <div className="page-loading">{error ? `⚠ ${error}` : 'Cargando…'}</div>;

  const sortHead = (by, label) => (
    <th className="sortable" onClick={() => setSort((s) => ({ by, dir: s.by === by ? -s.dir : 1 }))}>
      {label} {sort.by === by && (sort.dir > 0 ? '▲' : '▼')}
    </th>
  );

  // Columnas del tablero según el campo de agrupación
  const groupField = groupBy === 'status' ? null : config.fields.find((f) => f.id === groupBy && f.type === 'select');
  const columns = groupField
    ? [...groupField.options.map((o) => ({ id: o.id, name: o.name, color: o.color })), { id: null, name: 'Sin valor', color: 'gray' }]
    : config.statuses;
  const inColumn = (i, col) => (groupField ? (i.values[groupField.id] ?? null) === col.id : i.status === col.id);
  const dropTo = (issueId, col) => (groupField ? patchIssue(issueId, { values: { [groupField.id]: col.id } }) : patchIssue(issueId, { status: col.id }));

  return (
    <div className="tracker-view">
      {!readOnly && (
        <TrackerContext
          detail={detail}
          pages={pages}
          onMove={onMove}
          onChanged={async () => {
            await load();
            onTreeChange?.();
          }}
        />
      )}
      <datalist id={peopleListId}>
        {people.map((p) => (
          <option key={p} value={p} />
        ))}
      </datalist>
      <div className="tracker-toolbar">
        <div className="issues-tabs">
          <button className={mode === 'table' ? 'active' : ''} onClick={() => setPref('mode', 'table')}>
            <LayoutList {...ICON} /> Tabla
          </button>
          <button className={mode === 'board' ? 'active' : ''} onClick={() => setPref('mode', 'board')}>
            <Columns3 {...ICON} /> Tablero
          </button>
        </div>
        {mode === 'board' && (
          <label className="tracker-group">
            Agrupar por
            <select value={groupField ? groupField.id : 'status'} onChange={(e) => setPref('group_by', e.target.value)}>
              <option value="status">Estado</option>
              {config.fields
                .filter((f) => f.type === 'select')
                .map((f) => (
                  <option key={f.id} value={f.id}>
                    {f.name}
                  </option>
                ))}
            </select>
          </label>
        )}
        <span className="tracker-search">
          <Search size={14} />
          <input placeholder="Buscar…" value={q} onChange={(e) => setQ(e.target.value)} />
        </span>
        <span className="tracker-filter">
          Estado
          <OptionMenu multi options={config.statuses} value={filters.status || []} onChange={(v) => setFilters({ ...filters, status: v })} placeholder="todos" />
        </span>
        {filterable.map((f) => (
          <span key={f.id} className="tracker-filter">
            {f.name}
            <OptionMenu multi options={f.options} value={filters[f.id] || []} onChange={(v) => setFilters({ ...filters, [f.id]: v })} placeholder="todos" />
          </span>
        ))}
        <label className="tracker-hide-done">
          <input type="checkbox" checked={hideDone} onChange={(e) => setPref('hide_done', e.target.checked)} /> Ocultar hechos
        </label>
        <span className="tracker-count">
          {rows.length} de {detail.issues.length}
        </span>
        {!readOnly && (
          <button className="btn" onClick={() => setSettingsOpen(true)} title="Campos, opciones, estados y prefijo">
            <Settings2 {...ICON} /> Campos
          </button>
        )}
      </div>
      {error && <div className="issue-error">⚠ {error}</div>}

      {!readOnly && (
        <div className="tracker-quick-add">
          <Plus {...ICON} />
          <input
            placeholder={`Nuevo ticket (${detail.prefix}-${(detail.issues[0]?.number || 0) + 1})… escribe el título y Enter`}
            value={newTitle}
            onChange={(e) => setNewTitle(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && create()}
          />
        </div>
      )}

      {mode === 'table' ? (
        <div className="tracker-table-wrap">
          <table className="tracker-table">
            <thead>
              <tr>
                {sortHead('number', 'Clave')}
                {sortHead('title', 'Título')}
                {sortHead('status', 'Estado')}
                {visibleFields.map((f) => (
                  <th key={f.id} className="sortable" onClick={() => setSort((s) => ({ by: f.id, dir: s.by === f.id ? -s.dir : 1 }))}>
                    {f.name} {sort.by === f.id && (sort.dir > 0 ? '▲' : '▼')}
                  </th>
                ))}
                <th />
              </tr>
            </thead>
            <tbody>
              {rows.map((i) => (
                <tr key={i.id} className={`tracker-row cat-${i.category}`}>
                  <td className="issue-key-cell">
                    <Link to={readOnly ? '#' : `/p/${i.id}`} className="issue-key">
                      {i.key}
                    </Link>
                  </td>
                  <td className="tracker-title-cell">
                    {readOnly ? (
                      i.title
                    ) : (
                      <Link to={`/p/${i.id}`} className="tracker-title-link">
                        {i.title || 'Sin título'}
                      </Link>
                    )}
                    {i.blocked_by_open > 0 && <span className="issue-blocked-badge small">⛔ {i.blocked_by_open}</span>}
                  </td>
                  <td>
                    <OptionMenu
                      options={config.statuses}
                      value={i.status}
                      disabled={readOnly}
                      onChange={(v) => v && patchIssue(i.id, { status: v })}
                      renderValue={(s) => <StatusPill status={s[0] || statusById.get(i.status)} />}
                    />
                  </td>
                  {visibleFields.map((f) => (
                    <td key={f.id} className={`cell-${f.type}`}>
                      <FieldEditor field={f} value={i.values[f.id]} category={i.category} readOnly={readOnly} peopleListId={peopleListId} onChange={(v) => setField(i, f, v)} />
                    </td>
                  ))}
                  <td className="issue-counts">
                    {i.links_count > 0 && `🔗${i.links_count}`} {i.comments > 0 && `💬${i.comments}`}
                  </td>
                </tr>
              ))}
              {!rows.length && (
                <tr>
                  <td colSpan={4 + visibleFields.length} className="issue-hint">
                    {detail.issues.length ? 'Ningún ticket coincide con los filtros.' : 'Todavía no hay tickets: escribe uno arriba.'}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="tracker-board">
          {columns.map((col) => (
            <section
              key={col.id ?? 'none'}
              className={'tracker-column' + (col.category ? ` cat-${col.category}` : '')}
              onDragOver={(e) => !readOnly && e.dataTransfer.types.includes('text/nonotion-issue') && e.preventDefault()}
              onDrop={(e) => {
                const id = e.dataTransfer.getData('text/nonotion-issue');
                if (id) dropTo(id, col);
              }}
            >
              <h3>
                <Pill name={col.name} color={col.color} /> <span className="issues-count">{rows.filter((i) => inColumn(i, col)).length}</span>
              </h3>
              {rows
                .filter((i) => inColumn(i, col))
                .map((i) => (
                  <div
                    key={i.id}
                    className="tracker-card"
                    draggable={!readOnly}
                    onDragStart={(e) => e.dataTransfer.setData('text/nonotion-issue', i.id)}
                    onClick={() => !readOnly && navigate(`/p/${i.id}`)}
                  >
                    <div className="issue-card-head">
                      <GripVertical size={12} className="tracker-grip" />
                      <span className="issue-key">{i.key}</span>
                      {groupField && <StatusPill status={statusById.get(i.status)} />}
                      {i.blocked_by_open > 0 && <span className="issue-blocked-badge small">⛔ {i.blocked_by_open}</span>}
                    </div>
                    <div className="issue-card-title">{i.title || 'Sin título'}</div>
                    <div className="tracker-card-fields">
                      {visibleFields
                        .filter((f) => f.id !== groupField?.id && valueLabel(f, i.values[f.id]))
                        .slice(0, 4)
                        .map((f) =>
                          f.type === 'select' ? (
                            <Pill key={f.id} name={valueLabel(f, i.values[f.id])} color={f.options.find((o) => o.id === i.values[f.id])?.color} />
                          ) : (
                            <span key={f.id} className="tracker-card-field" title={f.name}>
                              {f.type === 'person' ? '👤 ' : f.type === 'date' ? '📅 ' : ''}
                              {valueLabel(f, i.values[f.id])}
                            </span>
                          )
                        )}
                    </div>
                  </div>
                ))}
            </section>
          ))}
        </div>
      )}

      {settingsOpen && <TrackerSettings detail={detail} onSave={saveSettings} onClose={() => setSettingsOpen(false)} />}
    </div>
  );
}

