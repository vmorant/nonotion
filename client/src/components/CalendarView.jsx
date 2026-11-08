import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api.js';
import { OptionMenu } from './issues/fields.jsx';
import NewIssueDialog from './issues/NewIssueDialog.jsx';

// Calendario con varios tipos de fecha que se filtran por separado:
//   - Eventos y reuniones: páginas con fecha asignada
//   - Fechas de los tickets de las listas, según su tipo: fecha límite,
//     inicio, evento u otra (se configura en ⚙ Campos de cada lista)
//   - Actividad: páginas creadas o modificadas ese día
// Vistas de mes, semana y agenda (lo próximo y lo vencido).

export const MEETING_TEMPLATE = `## 👥 Asistentes

-

## 📋 Agenda

-

## 📝 Notas

## ✅ Acciones

- [ ] `;

const WEEKDAYS = ['lun', 'mar', 'mié', 'jue', 'vie', 'sáb', 'dom'];
const MONTHS = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];

// Tipos de fecha que se pueden mostrar u ocultar
export const KINDS = [
  { id: 'minutes', label: 'Actas', icon: '📝', hint: 'Actas de reunión' },
  { id: 'events', label: 'Eventos', icon: '📅', hint: 'Páginas con fecha asignada' },
  { id: 'deadline', label: 'Fechas límite', icon: '⏰', hint: 'Campos de fecha límite de las listas' },
  { id: 'start', label: 'Inicios', icon: '▶', hint: 'Campos de inicio de las listas' },
  { id: 'event', label: 'Eventos de listas', icon: '📌', hint: 'Campos de tipo evento de las listas' },
  { id: 'other', label: 'Otras fechas', icon: '•', hint: 'Otros campos de fecha de las listas' },
  { id: 'created', label: 'Creadas', icon: '✚', hint: 'Páginas creadas ese día' },
  { id: 'edited', label: 'Modificadas', icon: '✎', hint: 'Páginas editadas ese día' },
];
const DEFAULT_PREFS = { kinds: ['minutes', 'events', 'deadline', 'start', 'event', 'other'], trackers: [], hideDone: true, mode: 'month' };
const PREF_KEY = 'nn:calendar';
const readPrefs = () => {
  try {
    const saved = JSON.parse(localStorage.getItem(PREF_KEY)) || {};
    if (saved.kinds && !saved.v2) saved.kinds = [...new Set(['minutes', ...saved.kinds])];
    return { ...DEFAULT_PREFS, ...saved, v2: true };
  } catch {
    return DEFAULT_PREFS;
  }
};

const fmt = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const addDays = (d, n) => {
  const r = new Date(d);
  r.setDate(r.getDate() + n);
  return r;
};
const startOfWeek = (d) => addDays(d, -((d.getDay() + 6) % 7));
const dayLabel = (key) => {
  const d = new Date(`${key}T12:00:00`);
  return `${WEEKDAYS[(d.getDay() + 6) % 7]} ${d.getDate()} ${MONTHS[d.getMonth()].slice(0, 3)}`;
};

// Todo lo de un rango, ya como elementos del calendario
function toItems(data) {
  if (!data) return [];
  const out = [];
  for (const p of data.dated) {
    out.push({ kind: p.kind === 'minutes' ? 'minutes' : 'events', id: p.id, day: p.day, icon: p.icon || (p.kind === 'minutes' ? '📝' : '📅'), title: p.title || 'Sin título' });
  }
  for (const i of data.issues) {
    out.push({
      kind: i.role,
      id: i.id,
      day: i.day,
      icon: i.icon || '🎫',
      title: i.title || 'Sin título',
      key: i.key,
      field: i.field,
      tracker_id: i.tracker_id,
      tracker_title: i.tracker_title,
      status: i.status_name,
      category: i.category,
      overdue: i.overdue,
    });
  }
  for (const p of data.created) out.push({ kind: 'created', id: p.id, day: p.day, icon: p.icon || '📄', title: p.title || 'Sin título' });
  for (const p of data.edited) out.push({ kind: 'edited', id: p.id, day: p.day, icon: p.icon || '📄', title: p.title || 'Sin título', edits: p.edits });
  return out;
}

function Chip({ it, onOpen }) {
  const kind = KINDS.find((k) => k.id === it.kind);
  const title =
    `${kind?.label || ''}: ${it.key ? `${it.key} ` : ''}${it.title}` +
    (it.field ? ` — ${it.field} (${it.tracker_title}, ${it.status})` : '') +
    (it.edits ? ` (${it.edits}×)` : '');
  return (
    <button
      className={`chip k-${it.kind}` + (it.category === 'done' ? ' done' : '') + (it.overdue ? ' overdue' : '')}
      title={title}
      onClick={() => onOpen(it.id)}
    >
      <span className="chip-kind">{kind?.icon}</span>
      {it.key && <span className="chip-key">{it.key}</span>} {it.title}
    </button>
  );
}

// Menú "+" de un día: reunión, evento o ticket con esa fecha
function DayAdd({ day, onMeeting, onEvent, onTicket }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  useEffect(() => {
    if (!open) return undefined;
    const close = (e) => ref.current && !ref.current.contains(e.target) && setOpen(false);
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [open]);
  return (
    <span className="calendar-add-wrap" ref={ref}>
      <button className="calendar-add" title={`Añadir el ${day}`} onClick={() => setOpen((v) => !v)}>
        +
      </button>
      {open && (
        <div className="calendar-add-menu">
          <button onClick={() => (setOpen(false), onMeeting(day))}>🗓️ Reunión (con plantilla)</button>
          <button onClick={() => (setOpen(false), onEvent(day))}>📅 Evento</button>
          <button onClick={() => (setOpen(false), onTicket(day))}>🎫 Ticket con esta fecha…</button>
        </div>
      )}
    </span>
  );
}

export default function CalendarView({ onChanged }) {
  const [prefs, setPrefs] = useState(readPrefs);
  const [anchor, setAnchor] = useState(() => new Date());
  const [data, setData] = useState(null);
  const [ticketDay, setTicketDay] = useState(null);
  const navigate = useNavigate();
  const today = fmt(new Date());
  const mode = prefs.mode;

  const savePrefs = (patch) => {
    const next = { ...prefs, ...patch };
    setPrefs(next);
    try {
      localStorage.setItem(PREF_KEY, JSON.stringify(next));
    } catch {}
  };

  const { days, from, to, label } = useMemo(() => {
    if (mode === 'agenda') {
      const start = new Date(anchor.getFullYear(), anchor.getMonth(), anchor.getDate());
      const end = addDays(start, 30);
      return { days: [], from: fmt(start), to: fmt(end), label: `Agenda · ${dayLabel(fmt(start))} – ${dayLabel(fmt(end))}` };
    }
    if (mode === 'week') {
      const start = startOfWeek(anchor);
      const days = Array.from({ length: 7 }, (_, i) => addDays(start, i));
      const end = days[6];
      return {
        days,
        from: fmt(start),
        to: fmt(end),
        label: `${start.getDate()} ${MONTHS[start.getMonth()].slice(0, 3)} – ${end.getDate()} ${MONTHS[end.getMonth()].slice(0, 3)} ${end.getFullYear()}`,
      };
    }
    const first = new Date(anchor.getFullYear(), anchor.getMonth(), 1);
    const last = new Date(anchor.getFullYear(), anchor.getMonth() + 1, 0);
    const start = startOfWeek(first);
    const end = addDays(startOfWeek(last), 6);
    const days = [];
    for (let d = start; d <= end; d = addDays(d, 1)) days.push(d);
    return { days, from: fmt(start), to: fmt(end), label: `${MONTHS[anchor.getMonth()]} ${anchor.getFullYear()}` };
  }, [mode, anchor]);

  const load = () =>
    api
      .calendar(from, to, mode === 'agenda' ? today : null)
      .then(setData)
      .catch(() => {});
  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [from, to, mode]);

  // Filtros: tipos de fecha, listas y tickets hechos
  const kinds = new Set(prefs.kinds);
  const trackerFilter = new Set(prefs.trackers);
  const all = useMemo(() => toItems(data), [data]);
  const visible = all.filter(
    (it) =>
      kinds.has(it.kind) &&
      (!it.tracker_id || !trackerFilter.size || trackerFilter.has(it.tracker_id)) &&
      (!prefs.hideDone || it.category !== 'done')
  );
  const counts = useMemo(() => {
    const c = {};
    for (const it of all) if (!prefs.hideDone || it.category !== 'done') c[it.kind] = (c[it.kind] || 0) + 1;
    return c;
  }, [all, prefs.hideDone]);
  const byDay = useMemo(() => {
    const map = new Map();
    for (const it of visible) {
      if (!map.has(it.day)) map.set(it.day, []);
      map.get(it.day).push(it);
    }
    return map;
  }, [visible]);

  const move = (dir) => {
    if (mode === 'agenda') setAnchor((a) => addDays(a, dir * 30));
    else if (mode === 'week') setAnchor((a) => addDays(a, dir * 7));
    else setAnchor((a) => new Date(a.getFullYear(), a.getMonth() + dir, 1));
  };

  const newPage = async (day, meeting) => {
    const page = await api.createPage({
      title: meeting ? 'Reunión' : 'Evento',
      icon: meeting ? '🗓️' : '📅',
      page_date: day,
      ...(meeting ? { content: MEETING_TEMPLATE } : {}),
    });
    await onChanged?.();
    navigate(`/p/${page.id}`);
  };

  const trackerOptions = (data?.trackers || []).filter((t) => t.has_dates).map((t) => ({ id: t.id, name: `${t.icon || '📋'} ${t.title}`, color: 'blue' }));
  const maxChips = mode === 'month' ? 4 : 14;
  const overdue = mode === 'agenda' ? visible.filter((it) => it.overdue && it.day < from) : [];
  const agendaDays = mode === 'agenda' ? [...byDay.keys()].filter((d) => d >= from).sort() : [];

  return (
    <div className="calendar">
      <div className="calendar-bar">
        <h2>📅 {label}</h2>
        <div className="calendar-controls">
          <button className="btn" onClick={() => move(-1)} title="Anterior">
            ‹
          </button>
          <button className="btn" onClick={() => setAnchor(new Date())}>
            Hoy
          </button>
          <button className="btn" onClick={() => move(1)} title="Siguiente">
            ›
          </button>
          <span className="calendar-sep" />
          {[
            ['agenda', 'Agenda'],
            ['week', 'Semana'],
            ['month', 'Mes'],
          ].map(([m, l]) => (
            <button key={m} className={'btn' + (mode === m ? ' shared' : '')} onClick={() => savePrefs({ mode: m })}>
              {l}
            </button>
          ))}
        </div>
      </div>

      <div className="calendar-filters">
        {KINDS.map((k) => (
          <button
            key={k.id}
            className={`cal-filter k-${k.id}` + (kinds.has(k.id) ? ' on' : '')}
            title={k.hint}
            onClick={() => savePrefs({ kinds: kinds.has(k.id) ? prefs.kinds.filter((x) => x !== k.id) : [...prefs.kinds, k.id] })}
          >
            <span className="chip-kind">{k.icon}</span> {k.label}
            {counts[k.id] ? <span className="cal-filter-n">{counts[k.id]}</span> : null}
          </button>
        ))}
        {trackerOptions.length > 0 && (
          <span className="tracker-filter">
            Listas
            <OptionMenu multi options={trackerOptions} value={prefs.trackers} onChange={(v) => savePrefs({ trackers: v })} placeholder="todas" />
          </span>
        )}
        <label className="tracker-hide-done">
          <input type="checkbox" checked={prefs.hideDone} onChange={(e) => savePrefs({ hideDone: e.target.checked })} /> Ocultar tickets hechos
        </label>
      </div>

      {mode === 'agenda' ? (
        <div className="agenda">
          {overdue.length > 0 && (
            <section className="agenda-day overdue">
              <h3>⚠ Vencido</h3>
              {overdue.map((it, i) => (
                <div key={`o-${it.id}-${i}`} className="agenda-item">
                  <span className="agenda-date">{dayLabel(it.day)}</span>
                  <Chip it={it} onOpen={(id) => navigate(`/p/${id}`)} />
                  {it.field && <span className="issue-hint">{it.field} · {it.tracker_title}</span>}
                </div>
              ))}
            </section>
          )}
          {agendaDays.map((d) => (
            <section key={d} className={'agenda-day' + (d === today ? ' today' : '')}>
              <h3>
                {d === today ? 'Hoy · ' : ''}
                {dayLabel(d)}
                <DayAdd day={d} onMeeting={(x) => newPage(x, true)} onEvent={(x) => newPage(x, false)} onTicket={setTicketDay} />
              </h3>
              {byDay.get(d).map((it, i) => (
                <div key={`${it.kind}-${it.id}-${i}`} className="agenda-item">
                  <Chip it={it} onOpen={(id) => navigate(`/p/${id}`)} />
                  {it.field && <span className="issue-hint">{it.field} · {it.tracker_title} · {it.status}</span>}
                </div>
              ))}
            </section>
          ))}
          {!overdue.length && !agendaDays.length && <p className="issue-hint">Nada en los próximos 30 días con los filtros elegidos.</p>}
        </div>
      ) : (
        <>
          <div className="calendar-weekdays">
            {WEEKDAYS.map((w) => (
              <div key={w}>{w}</div>
            ))}
          </div>
          <div className={`calendar-grid ${mode}`}>
            {days.map((d) => {
              const key = fmt(d);
              const items = byDay.get(key) || [];
              const outside = mode === 'month' && d.getMonth() !== anchor.getMonth();
              return (
                <div
                  key={key}
                  className={'calendar-day' + (key === today ? ' today' : '') + (outside ? ' outside' : '') + (items.length === 0 ? ' empty' : '')}
                >
                  <div className="calendar-day-head">
                    <span className="calendar-day-num">{d.getDate()}</span>
                    <DayAdd day={key} onMeeting={(x) => newPage(x, true)} onEvent={(x) => newPage(x, false)} onTicket={setTicketDay} />
                  </div>
                  <div className="calendar-chips">
                    {items.slice(0, maxChips).map((it, i) => (
                      <Chip key={`${it.kind}-${it.id}-${i}`} it={it} onOpen={(id) => navigate(`/p/${id}`)} />
                    ))}
                    {items.length > maxChips && <span className="chip-more">+{items.length - maxChips} más</span>}
                  </div>
                </div>
              );
            })}
          </div>
        </>
      )}

      {ticketDay && (
        <NewIssueDialog
          initialDate={ticketDay}
          onClose={() => setTicketDay(null)}
          onCreate={async (body) => {
            const d = await api.createIssue(body);
            setTicketDay(null);
            await onChanged?.();
            load();
            navigate(`/p/${d.page_id}`);
          }}
        />
      )}
    </div>
  );
}
