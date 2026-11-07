// Seguimiento: listas (trackers) con tickets y campos propios. El servidor
// valida en server/issues.js; aquí solo lo que comparten las vistas.

export const CATEGORIES = ['todo', 'doing', 'blocked', 'done'];
export const CATEGORY_LABELS = { todo: 'Pendiente', doing: 'En curso', blocked: 'Bloqueado', done: 'Hecho' };
export const OPEN_CATEGORIES = new Set(['todo', 'doing', 'blocked']);
export const FIELD_TYPES = ['select', 'multi', 'text', 'number', 'date', 'person', 'checkbox', 'url'];
export const FIELD_TYPE_LABELS = {
  select: 'Desplegable',
  multi: 'Varias opciones',
  text: 'Texto',
  number: 'Número',
  date: 'Fecha',
  person: 'Persona',
  checkbox: 'Casilla',
  url: 'Enlace',
};
export const FIELD_TYPE_ICONS = { select: '▾', multi: '☰', text: 'T', number: '#', date: '📅', person: '👤', checkbox: '☑', url: '🔗' };
export const COLORS = ['gray', 'blue', 'green', 'yellow', 'orange', 'red', 'purple', 'pink', 'teal'];
export const COLOR_LABELS = { gray: 'Gris', blue: 'Azul', green: 'Verde', yellow: 'Amarillo', orange: 'Naranja', red: 'Rojo', purple: 'Morado', pink: 'Rosa', teal: 'Turquesa' };
export const DATE_ROLES = ['deadline', 'start', 'event', 'other'];
export const DATE_ROLE_LABELS = { deadline: 'Fecha límite', start: 'Inicio', event: 'Evento', other: 'Otra fecha' };
export const LINK_TYPES = ['blocks', 'relates', 'documents', 'origin'];
export const LINK_LABELS = { blocks: 'Bloquea a', relates: 'Relacionado con', documents: 'Documentado en', origin: 'Viene de' };
export const LINK_INVERSE = { blocks: 'Bloqueado por', relates: 'Relacionado con', documents: 'Documenta', origin: 'Originó' };

export const newId = () => Math.random().toString(16).slice(2, 10);

export function valueLabel(field, v) {
  if (v === null || v === undefined || v === '' || (Array.isArray(v) && !v.length)) return '';
  if (!field) return String(v);
  if (field.type === 'select') return field.options.find((o) => o.id === v)?.name || '';
  if (field.type === 'multi') return v.map((x) => field.options.find((o) => o.id === x)?.name).filter(Boolean).join(', ');
  if (field.type === 'checkbox') return v ? 'Sí' : 'No';
  return String(v);
}

export const today = () => new Date().toISOString().slice(0, 10);
// Una fecha vencida de un ticket abierto se marca en rojo
export const isOverdue = (field, v, category) => field?.type === 'date' && v && OPEN_CATEGORIES.has(category) && v < today();

export function fmtWhen(at) {
  if (!at) return '';
  const d = new Date(at.includes('T') ? at : at.replace(' ', 'T') + 'Z');
  if (Number.isNaN(d.getTime())) return at.slice(0, 16);
  return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' }) + ' ' + d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}

// Personas que aparecen en los campos "Persona" (para sugerir)
export function peopleIn(issues, config) {
  const ids = config.fields.filter((f) => f.type === 'person').map((f) => f.id);
  const set = new Set();
  for (const i of issues || []) for (const id of ids) if (i.values?.[id]) set.add(i.values[id]);
  return [...set];
}
