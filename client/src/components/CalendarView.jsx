import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api.js';

export const MEETING_TEMPLATE = `## 👥 Asistentes

-

## 📋 Agenda

-

## 📝 Notas

## ✅ Acciones

- [ ] `;

const WEEKDAYS = ['lun', 'mar', 'mié', 'jue', 'vie', 'sáb', 'dom'];
const MONTHS = [
  'enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio',
  'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre',
];

const fmt = (d) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

const addDays = (d, n) => {
  const r = new Date(d);
  r.setDate(r.getDate() + n);
  return r;
};

// Lunes de la semana de `d`
const startOfWeek = (d) => addDays(d, -((d.getDay() + 6) % 7));

export default function CalendarView() {
  const [mode, setMode] = useState('month'); // 'month' | 'week'
  const [anchor, setAnchor] = useState(() => new Date());
  const [data, setData] = useState(null);
  const navigate = useNavigate();
  const today = fmt(new Date());

  const { days, from, to, label } = useMemo(() => {
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
    return {
      days,
      from: fmt(start),
      to: fmt(end),
      label: `${MONTHS[anchor.getMonth()]} ${anchor.getFullYear()}`,
    };
  }, [mode, anchor]);

  useEffect(() => {
    api.calendar(from, to).then(setData);
  }, [from, to]);

  const byDay = useMemo(() => {
    const map = new Map();
    if (!data) return map;
    const push = (kind) => (item) => {
      if (!map.has(item.day)) map.set(item.day, []);
      map.get(item.day).push({ ...item, kind });
    };
    data.dated.forEach(push('dated'));
    data.created.forEach(push('created'));
    data.edited.forEach(push('edited'));
    return map;
  }, [data]);

  const move = (dir) => {
    if (mode === 'week') setAnchor((a) => addDays(a, dir * 7));
    else setAnchor((a) => new Date(a.getFullYear(), a.getMonth() + dir, 1));
  };

  const newMeeting = async (day) => {
    const page = await api.createPage({
      title: 'Reunión',
      icon: '🗓️',
      page_date: day,
      content: MEETING_TEMPLATE,
    });
    navigate(`/p/${page.id}`);
  };

  const maxChips = mode === 'month' ? 3 : 12;

  return (
    <div className="calendar">
      <div className="calendar-bar">
        <h2>📅 {label}</h2>
        <div className="calendar-controls">
          <button className="btn" onClick={() => move(-1)} title="Anterior">‹</button>
          <button className="btn" onClick={() => setAnchor(new Date())}>Hoy</button>
          <button className="btn" onClick={() => move(1)} title="Siguiente">›</button>
          <span className="calendar-sep" />
          <button className={'btn' + (mode === 'week' ? ' shared' : '')} onClick={() => setMode('week')}>
            Semana
          </button>
          <button className={'btn' + (mode === 'month' ? ' shared' : '')} onClick={() => setMode('month')}>
            Mes
          </button>
        </div>
      </div>
      <div className="calendar-legend">
        <span><i className="dot dated" /> Con fecha (reuniones)</span>
        <span><i className="dot created" /> Creada</span>
        <span><i className="dot edited" /> Editada</span>
      </div>
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
              className={
                'calendar-day' + (key === today ? ' today' : '') + (outside ? ' outside' : '') +
                (items.length === 0 ? ' empty' : '')
              }
            >
              <div className="calendar-day-head">
                <span className="calendar-day-num">{d.getDate()}</span>
                <button className="calendar-add" title="Nueva reunión este día" onClick={() => newMeeting(key)}>
                  +
                </button>
              </div>
              <div className="calendar-chips">
                {items.slice(0, maxChips).map((it, i) => (
                  <button
                    key={`${it.kind}-${it.id}-${i}`}
                    className={`chip ${it.kind}`}
                    title={
                      (it.kind === 'dated' ? 'Con fecha' : it.kind === 'created' ? 'Creada' : `Editada (${it.edits || 1}×)`) +
                      `: ${it.title || 'Sin título'}`
                    }
                    onClick={() => navigate(`/p/${it.id}`)}
                  >
                    {it.icon || '📄'} {it.title || 'Sin título'}
                  </button>
                ))}
                {items.length > maxChips && (
                  <span className="chip-more">+{items.length - maxChips} más</span>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
