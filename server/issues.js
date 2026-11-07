// Seguimiento: listas (trackers) con tickets, como un Jira ligero o una base de
// datos de Notion.
//
// - Una LISTA es una página del árbol (kind = 'tracker'): "Bloqueantes",
//   "To-do", "Temas"… Cada una tiene su prefijo (BLQ-3), sus estados (con
//   categoría: pendiente, en curso, bloqueado, hecho) y sus propios campos
//   (desplegable, varias opciones, texto, número, fecha, persona, casilla,
//   enlace). Se crean desde plantillas y se configuran sobre la marcha.
// - Un TICKET es una página hija de su lista (kind = 'issue') con descripción
//   (editor normal), valores de los campos, relaciones con tipo hacia páginas
//   u otros tickets y una cronología con autor de cada cambio y comentario.
import crypto from 'crypto';
import { nanoid } from 'nanoid';
import db, { ftsUpsert, extractText, logActivity } from './db.js';
import { markdownToDoc } from './markdown.js';
import { setPageTags, splitTags, TAGS_COLUMN } from './tags.js';

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
export const COLORS = ['gray', 'blue', 'green', 'yellow', 'orange', 'red', 'purple', 'pink', 'teal'];
export const LINK_TYPES = ['blocks', 'relates', 'documents', 'origin'];
export const LINK_LABELS = { blocks: 'Bloquea a', relates: 'Relacionado con', documents: 'Documentado en', origin: 'Viene de' };
export const LINK_INVERSE = { blocks: 'Bloqueado por', relates: 'Relacionado con', documents: 'Documenta', origin: 'Originó' };

export class IssueError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

const rid = () => crypto.randomBytes(4).toString('hex');
const now = () => new Date().toISOString().slice(0, 19).replace('T', ' ');

// ---------- Plantillas ----------

const opt = (name, color) => ({ id: rid(), name, color });
const st = (name, category, color) => ({ id: rid(), name, category, color });
export const TEMPLATES = {
  blockers: {
    label: 'Bloqueos e impedimentos',
    icon: '🚧',
    prefix: 'BLQ',
    build: () => ({
      statuses: [st('Abierto', 'todo', 'blue'), st('En curso', 'doing', 'yellow'), st('Bloqueado', 'blocked', 'red'), st('Resuelto', 'done', 'green')],
      fields: [
        { id: rid(), name: 'Impacto', type: 'select', options: [opt('Alto', 'red'), opt('Medio', 'orange'), opt('Bajo', 'gray')] },
        { id: rid(), name: 'Área', type: 'select', options: [opt('Datos', 'blue'), opt('Infraestructura', 'purple'), opt('Negocio', 'green'), opt('Seguridad', 'red')] },
        { id: rid(), name: 'Responsable', type: 'person' },
        { id: rid(), name: 'Fecha límite', type: 'date' },
      ],
    }),
  },
  todo: {
    label: 'To-do (tareas)',
    icon: '✅',
    prefix: 'TODO',
    build: () => ({
      statuses: [st('Pendiente', 'todo', 'gray'), st('Haciendo', 'doing', 'yellow'), st('Hecho', 'done', 'green')],
      fields: [
        { id: rid(), name: 'Prioridad', type: 'select', options: [opt('Alta', 'red'), opt('Media', 'orange'), opt('Baja', 'gray')] },
        { id: rid(), name: 'Responsable', type: 'person' },
        { id: rid(), name: 'Fecha', type: 'date' },
      ],
    }),
  },
  topics: {
    label: 'Temas y decisiones',
    icon: '🗂️',
    prefix: 'TEM',
    build: () => ({
      statuses: [st('Nuevo', 'todo', 'blue'), st('En discusión', 'doing', 'yellow'), st('Decidido', 'done', 'green'), st('Descartado', 'done', 'gray')],
      fields: [
        { id: rid(), name: 'Tipo', type: 'select', options: [opt('Pregunta', 'blue'), opt('Propuesta', 'purple'), opt('Riesgo', 'red'), opt('Decisión', 'green')] },
        { id: rid(), name: 'Prioridad', type: 'select', options: [opt('Alta', 'red'), opt('Media', 'orange'), opt('Baja', 'gray')] },
        { id: rid(), name: 'Responsable', type: 'person' },
        { id: rid(), name: 'Etiquetas', type: 'multi', options: [] },
      ],
    }),
  },
  blank: {
    label: 'En blanco',
    icon: '📋',
    prefix: null,
    build: () => ({ statuses: [st('Abierto', 'todo', 'blue'), st('En curso', 'doing', 'yellow'), st('Hecho', 'done', 'green')], fields: [] }),
  },
};

// ---------- Esquema ----------

db.exec(`
CREATE TABLE IF NOT EXISTS trackers (
  page_id TEXT PRIMARY KEY REFERENCES pages(id) ON DELETE CASCADE,
  workspace_id TEXT NOT NULL,
  prefix TEXT NOT NULL,
  config TEXT NOT NULL,
  next_number INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS idx_trackers_ws ON trackers(workspace_id);
CREATE TABLE IF NOT EXISTS issues (
  page_id TEXT PRIMARY KEY REFERENCES pages(id) ON DELETE CASCADE,
  tracker_id TEXT NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  workspace_id TEXT NOT NULL,
  number INTEGER NOT NULL,
  status TEXT NOT NULL,
  vals TEXT NOT NULL DEFAULT '{}',
  closed_at TEXT,
  created_by TEXT,
  UNIQUE (tracker_id, number)
);
CREATE INDEX IF NOT EXISTS idx_issues_tracker ON issues(tracker_id);
CREATE INDEX IF NOT EXISTS idx_issues_ws ON issues(workspace_id);
CREATE TABLE IF NOT EXISTS issue_links (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  issue_id TEXT NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  target_id TEXT NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  created_by TEXT,
  UNIQUE (issue_id, target_id, type)
);
CREATE INDEX IF NOT EXISTS idx_issue_links_target ON issue_links(target_id);
CREATE TABLE IF NOT EXISTS issue_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  page_id TEXT NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  at TEXT NOT NULL DEFAULT (datetime('now')),
  by TEXT,
  kind TEXT NOT NULL,
  data TEXT,
  text TEXT
);
CREATE INDEX IF NOT EXISTS idx_issue_events_page ON issue_events(page_id, id);
`);

// ---------- Configuración de una lista ----------

const str = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : undefined);
const validColor = (c) => (COLORS.includes(c) ? c : 'gray');
export const validPrefix = (p) => typeof p === 'string' && /^[A-Z][A-Z0-9]{0,9}$/.test(p);

export function derivePrefix(name) {
  const clean = String(name || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toUpperCase()
    .replace(/[^A-Z0-9 ]+/g, ' ')
    .trim();
  const words = clean.split(/\s+/).filter(Boolean);
  let p = words.length > 1 ? words.map((w) => w[0]).join('').slice(0, 5) : (words[0] || '').slice(0, 4);
  if (!/^[A-Z]/.test(p)) p = 'T' + p;
  return p.slice(0, 10) || 'T';
}

function uniquePrefix(ws, wanted, exceptTracker = null) {
  const taken = new Set(
    db
      .prepare('SELECT prefix FROM trackers WHERE workspace_id = ? AND page_id IS NOT ?')
      .all(ws, exceptTracker)
      .map((r) => r.prefix)
  );
  if (!taken.has(wanted)) return wanted;
  for (let n = 2; n < 100; n++) if (!taken.has(`${wanted.slice(0, 8)}${n}`)) return `${wanted.slice(0, 8)}${n}`;
  return `${wanted.slice(0, 4)}${rid().slice(0, 4).toUpperCase()}`;
}

// Valida y limpia la configuración (estados y campos). Conserva los ids.
export function normalizeConfig(input) {
  const c = input && typeof input === 'object' ? input : {};
  const statuses = (Array.isArray(c.statuses) ? c.statuses : [])
    .slice(0, 30)
    .map((s) => ({
      id: str(s?.id, 40) || rid(),
      name: str(s?.name, 60) || 'Sin nombre',
      category: CATEGORIES.includes(s?.category) ? s.category : 'todo',
      color: validColor(s?.color),
    }));
  if (!statuses.length) throw new IssueError('La lista necesita al menos un estado');
  const ids = new Set();
  for (const s of statuses) {
    while (ids.has(s.id)) s.id = rid();
    ids.add(s.id);
  }
  const fields = (Array.isArray(c.fields) ? c.fields : []).slice(0, 40).map((f) => {
    const type = FIELD_TYPES.includes(f?.type) ? f.type : 'text';
    const out = { id: str(f?.id, 40) || rid(), name: str(f?.name, 60) || 'Campo', type };
    if (type === 'select' || type === 'multi') {
      const seen = new Set();
      out.options = (Array.isArray(f.options) ? f.options : []).slice(0, 60).map((o) => {
        let id = str(o?.id, 40) || rid();
        while (seen.has(id)) id = rid();
        seen.add(id);
        return { id, name: str(o?.name, 60) || 'Opción', color: validColor(o?.color) };
      });
    }
    if (f?.hidden) out.hidden = true;
    return out;
  });
  const fids = new Set();
  for (const f of fields) {
    while (fids.has(f.id)) f.id = rid();
    fids.add(f.id);
  }
  const names = new Set();
  for (const f of fields) {
    const k = f.name.toLowerCase();
    if (k === 'estado' || k === 'título' || k === 'titulo') throw new IssueError(`"${f.name}" es un nombre reservado`);
    if (names.has(k)) throw new IssueError(`Hay dos campos llamados "${f.name}"`);
    names.add(k);
  }
  const view = c.view && typeof c.view === 'object' ? c.view : {};
  return {
    statuses,
    fields,
    view: {
      mode: view.mode === 'board' ? 'board' : 'table',
      group_by: typeof view.group_by === 'string' ? view.group_by.slice(0, 40) : 'status',
    },
  };
}

const trackerRow = db.prepare('SELECT * FROM trackers WHERE page_id = ?');
export function trackerConfig(trackerId) {
  const t = trackerRow.get(trackerId);
  return t ? { ...t, config: JSON.parse(t.config) } : null;
}

// ---------- Valores de los campos ----------

const fold = (s) => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').trim().toLowerCase();

export function findField(config, ref) {
  return config.fields.find((f) => f.id === ref) || config.fields.find((f) => fold(f.name) === fold(ref));
}
export function findStatus(config, ref) {
  return config.statuses.find((s) => s.id === ref) || config.statuses.find((s) => fold(s.name) === fold(ref));
}
function findOption(field, ref) {
  return field.options.find((o) => o.id === ref) || field.options.find((o) => fold(o.name) === fold(ref));
}

// Convierte un valor (por id u nombre de opción) al que se guarda. Para
// desplegables, una opción nueva por nombre se crea si create = true.
function cleanValue(field, v, { create, config }) {
  if (v === null || v === undefined || v === '') return null;
  switch (field.type) {
    case 'select': {
      let o = findOption(field, v);
      if (!o && create && typeof v === 'string' && v.trim()) {
        o = { id: rid(), name: v.trim().slice(0, 60), color: COLORS[(field.options.length + 1) % COLORS.length] };
        field.options.push(o);
        config.__changed = true;
      }
      if (!o) throw new IssueError(`"${v}" no es una opción de «${field.name}» (${field.options.map((x) => x.name).join(', ') || 'sin opciones'})`);
      return o.id;
    }
    case 'multi': {
      const list = Array.isArray(v) ? v : String(v).split(',').map((x) => x.trim()).filter(Boolean);
      return [...new Set(list.map((x) => cleanValue({ ...field, type: 'select' }, x, { create, config })))];
    }
    case 'number': {
      const n = Number(v);
      if (!Number.isFinite(n)) throw new IssueError(`«${field.name}» debe ser un número`);
      return n;
    }
    case 'date':
      if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v)) throw new IssueError(`«${field.name}» debe ser una fecha AAAA-MM-DD`);
      return v;
    case 'checkbox':
      return v === true || v === 'true' || v === 1 || v === 'sí' || v === 'si';
    case 'url': {
      const u = String(v).trim();
      if (!/^https?:\/\/\S+$/i.test(u)) throw new IssueError(`«${field.name}» debe ser una web http(s)`);
      return u.slice(0, 2000);
    }
    default:
      return String(v).slice(0, field.type === 'text' ? 5000 : 120);
  }
}

// Texto legible de un valor (cronología, Markdown, Claude)
export function valueLabel(field, v) {
  if (v === null || v === undefined || v === '' || (Array.isArray(v) && !v.length)) return '—';
  if (!field) return String(v);
  if (field.type === 'select') return field.options.find((o) => o.id === v)?.name || '?';
  if (field.type === 'multi') return v.map((x) => field.options.find((o) => o.id === x)?.name || '?').join(', ');
  if (field.type === 'checkbox') return v ? 'Sí' : 'No';
  return String(v);
}

// ---------- Claves y búsqueda ----------

const issueRow = db.prepare('SELECT i.*, t.prefix FROM issues i JOIN trackers t ON t.page_id = i.tracker_id WHERE i.page_id = ?');
const keyOf = (r) => `${r.prefix}-${r.number}`;
export function indexIssue(pageId) {
  const p = db.prepare('SELECT title, content_text FROM pages WHERE id = ?').get(pageId);
  if (p) ftsUpsert(pageId, p.title, p.content_text); // ftsUpsert antepone la clave
}

// ---------- Cronología y autoría ----------

export function actorOf(req) {
  if (req.authKind === 'token') return req.tokenLogin ? `Claude (${req.tokenLogin})` : 'Claude';
  if (req.authKind === 'session') return req.user?.login || 'persona';
  return 'local';
}
const addEvent = (pageId, by, kind, data = null, text = null) =>
  db
    .prepare('INSERT INTO issue_events (page_id, by, kind, data, text) VALUES (?, ?, ?, ?, ?)')
    .run(pageId, by, kind, data ? JSON.stringify(data) : null, text);

// ---------- Relaciones ----------

const pageRow = db.prepare('SELECT id, title, icon, kind, parent_id, workspace_id, trashed_at FROM pages WHERE id = ?');

export function resolveTarget(ref, ws) {
  const s = String(ref || '').trim();
  const m = s.match(/^([A-Za-z][A-Za-z0-9]{0,9})-(\d+)$/);
  if (m) {
    const r = db
      .prepare('SELECT i.page_id FROM issues i JOIN trackers t ON t.page_id = i.tracker_id WHERE t.workspace_id = ? AND t.prefix = ? AND i.number = ?')
      .get(ws, m[1].toUpperCase(), Number(m[2]));
    if (r) return pageRow.get(r.page_id);
  }
  const p = pageRow.get(s);
  return p && p.workspace_id === ws ? p : null;
}

function addLink(issueId, type, targetRef, ws, by) {
  if (!LINK_TYPES.includes(type)) {
    throw new IssueError(`Tipo de relación "${type}" no válido (${LINK_TYPES.map((t) => `${t} = ${LINK_LABELS[t]}`).join(', ')})`);
  }
  const target = resolveTarget(targetRef, ws);
  if (!target || target.trashed_at) throw new IssueError(`"${targetRef}" no es una página ni un ticket de este espacio`, 404);
  if (target.id === issueId) throw new IssueError('Un ticket no puede relacionarse consigo mismo');
  if (type === 'blocks' && target.kind !== 'issue') throw new IssueError('"Bloquea a" solo se usa entre tickets');
  if (type === 'blocks') {
    const reaches = db
      .prepare(
        `WITH RECURSIVE chain(id) AS (SELECT ? UNION SELECT l.target_id FROM issue_links l JOIN chain c ON l.issue_id = c.id WHERE l.type = 'blocks')
         SELECT 1 FROM chain WHERE id = ?`
      )
      .get(target.id, issueId);
    if (reaches) throw new IssueError('Ese bloqueo crearía un ciclo (ya está bloqueado en sentido contrario)');
  }
  const r = db
    .prepare('INSERT OR IGNORE INTO issue_links (issue_id, target_id, type, created_by) VALUES (?, ?, ?, ?)')
    .run(issueId, target.id, type, by);
  if (r.changes) addEvent(issueId, by, 'link', { type, target_id: target.id, title: target.title });
  return { target, added: Boolean(r.changes) };
}

// ---------- Lecturas ----------

const statusOf = (config, id) => config.statuses.find((s) => s.id === id) || config.statuses[0];

const linkInfo = (p) => {
  if (!p) return null;
  let extra = {};
  if (p.kind === 'issue') {
    const i = issueRow.get(p.id);
    const t = i && trackerConfig(i.tracker_id);
    if (i && t) {
      const s = statusOf(t.config, i.status);
      extra = { key: keyOf(i), status: s.name, category: s.category, color: s.color };
    }
  }
  return { id: p.id, title: p.title, icon: p.icon, kind: p.kind, trashed: Boolean(p.trashed_at), ...extra };
};

// Prefijos de las listas del espacio (para menciones AXA-12, BLQ-3…)
function prefixesOf(ws) {
  return db.prepare('SELECT prefix FROM trackers t JOIN pages p ON p.id = t.page_id WHERE t.workspace_id = ? AND p.trashed_at IS NULL').all(ws).map((r) => r.prefix);
}
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function mentionsOf(key, ws, exceptId) {
  const re = new RegExp(`(^|[^A-Za-z0-9_-])${escapeRe(key)}(?![0-9])`, 'i');
  return db
    .prepare(
      `SELECT id, title, icon, kind, content_text FROM pages
       WHERE workspace_id = ? AND trashed_at IS NULL AND id != ? AND instr(upper(content_text), upper(?)) > 0
       ORDER BY updated_at DESC LIMIT 200`
    )
    .all(ws, exceptId, key)
    .filter((p) => re.test(p.content_text || ''))
    .map(({ content_text, ...p }) => p);
}

// Un ticket en forma de fila (tabla, tablero, listados)
function rowOf(r, t) {
  const s = statusOf(t.config, r.status);
  return {
    id: r.id,
    key: `${t.prefix}-${r.number}`,
    number: r.number,
    tracker_id: t.page_id,
    title: r.title,
    icon: r.icon,
    status: s.id,
    status_name: s.name,
    category: s.category,
    color: s.color,
    values: JSON.parse(r.vals || '{}'),
    tags: splitTags(r.tags),
    created_at: r.created_at,
    updated_at: r.updated_at,
    closed_at: r.closed_at,
    blocked_by_open: r.blocked_by_open || 0,
    links_count: r.links_count || 0,
    comments: r.comments || 0,
  };
}

const TICKET_SELECT = `SELECT p.id, p.title, p.icon, p.created_at, p.updated_at, ${TAGS_COLUMN.replace(/pages\.id/g, 'p.id')},
       i.number, i.status, i.vals, i.closed_at, i.tracker_id,
       (SELECT COUNT(*) FROM issue_links l JOIN issues b ON b.page_id = l.issue_id JOIN pages bp ON bp.id = l.issue_id
          WHERE l.target_id = p.id AND l.type = 'blocks' AND bp.trashed_at IS NULL AND b.closed_at IS NULL) AS blocked_by_open,
       (SELECT COUNT(*) FROM issue_links l JOIN pages x ON x.id = l.target_id WHERE l.issue_id = p.id AND x.trashed_at IS NULL) AS links_count,
       (SELECT COUNT(*) FROM issue_events e WHERE e.page_id = p.id AND e.kind = 'comment') AS comments
     FROM issues i JOIN pages p ON p.id = i.page_id`;

export function trackerDetail(trackerId) {
  const t = trackerConfig(trackerId);
  if (!t) return null;
  const rows = db.prepare(`${TICKET_SELECT} WHERE i.tracker_id = ? AND p.trashed_at IS NULL ORDER BY i.number DESC`).all(trackerId);
  return { id: trackerId, prefix: t.prefix, config: t.config, issues: rows.map((r) => rowOf(r, t)) };
}

export function listTrackers(ws) {
  return db
    .prepare(
      `SELECT t.page_id, t.prefix, t.config, p.title, p.icon, p.parent_id FROM trackers t JOIN pages p ON p.id = t.page_id
       WHERE t.workspace_id = ? AND p.trashed_at IS NULL ORDER BY p.title`
    )
    .all(ws)
    .map((t) => {
      const config = JSON.parse(t.config);
      const counts = Object.fromEntries(CATEGORIES.map((c) => [c, 0]));
      for (const r of db.prepare(`SELECT i.status FROM issues i JOIN pages p ON p.id = i.page_id WHERE i.tracker_id = ? AND p.trashed_at IS NULL`).all(t.page_id)) {
        counts[statusOf(config, r.status).category]++;
      }
      return { id: t.page_id, title: t.title, icon: t.icon, parent_id: t.parent_id, prefix: t.prefix, config, counts };
    });
}

// Tickets de todas las listas (o de una), con filtros
export function listIssues(ws, f = {}) {
  const trackers = new Map(
    db
      .prepare('SELECT t.* FROM trackers t JOIN pages p ON p.id = t.page_id WHERE t.workspace_id = ? AND p.trashed_at IS NULL')
      .all(ws)
      .map((t) => [t.page_id, { ...t, config: JSON.parse(t.config) }])
  );
  let tracker = null;
  if (f.tracker) {
    const ref = String(f.tracker);
    tracker = [...trackers.values()].find((t) => t.page_id === ref || t.prefix === ref.toUpperCase()) ||
      [...trackers.values()].find((t) => fold(db.prepare('SELECT title FROM pages WHERE id = ?').get(t.page_id)?.title) === fold(ref));
    if (!tracker) throw new IssueError(`No hay ninguna lista "${f.tracker}" en este espacio`, 404);
  }
  let rows = db
    .prepare(`${TICKET_SELECT} WHERE i.workspace_id = ? AND p.trashed_at IS NULL ORDER BY i.tracker_id, i.number DESC`)
    .all(ws)
    .filter((r) => trackers.has(r.tracker_id) && (!tracker || r.tracker_id === tracker.page_id))
    .map((r) => {
      const t = trackers.get(r.tracker_id);
      return { ...rowOf(r, t), tracker_title: db.prepare('SELECT title FROM pages WHERE id = ?').get(t.page_id)?.title, prefix: t.prefix };
    });
  const list = (v) => (Array.isArray(v) ? v : String(v || '').split(',')).map((x) => x.trim()).filter(Boolean);
  if (f.key) rows = rows.filter((r) => r.key.toLowerCase() === String(f.key).trim().toLowerCase());
  if (f.category) {
    const c = list(f.category);
    const want = new Set(c.flatMap((x) => (x === 'active' || x === 'open' ? [...OPEN_CATEGORIES] : [x])));
    rows = rows.filter((r) => want.has(r.category));
  }
  if (f.status) {
    const names = list(f.status).map(fold);
    rows = rows.filter((r) => names.includes(fold(r.status_name)) || names.includes(r.status));
  }
  if (f.blocked === 'true' || f.blocked === true) {
    rows = rows.filter((r) => OPEN_CATEGORIES.has(r.category) && (r.category === 'blocked' || r.blocked_by_open > 0));
  }
  // Filtros por campo: { "Responsable": "vmorant", "Impacto": "Alto" }
  const fieldFilters = f.fields && typeof f.fields === 'object' ? f.fields : {};
  for (const [name, want] of Object.entries(fieldFilters)) {
    rows = rows.filter((r) => {
      const t = trackers.get(r.tracker_id);
      const field = findField(t.config, name);
      if (!field) return false;
      const v = r.values[field.id];
      const label = fold(valueLabel(field, v));
      return want === null || want === '' ? v == null || v === '' : label.includes(fold(want));
    });
  }
  if (f.q) {
    const q = fold(f.q);
    rows = rows.filter((r) => fold(r.key).includes(q) || fold(r.title).includes(q));
  }
  return { issues: rows };
}

export function issueDetail(pageId) {
  const i = issueRow.get(pageId);
  if (!i) return null;
  const t = trackerConfig(i.tracker_id);
  const tracker = pageRow.get(i.tracker_id);
  const key = keyOf(i);
  const out = db
    .prepare('SELECT id, target_id, type, created_at, created_by FROM issue_links WHERE issue_id = ? ORDER BY id')
    .all(pageId)
    .map((l) => ({ ...l, target: linkInfo(pageRow.get(l.target_id)) }))
    .filter((l) => l.target && !l.target.trashed);
  const inc = db
    .prepare('SELECT id, issue_id, type, created_at, created_by FROM issue_links WHERE target_id = ? ORDER BY id')
    .all(pageId)
    .map((l) => ({ ...l, source: linkInfo(pageRow.get(l.issue_id)) }))
    .filter((l) => l.source && !l.source.trashed);
  const events = db
    .prepare('SELECT id, at, by, kind, data, text FROM issue_events WHERE page_id = ? ORDER BY id')
    .all(pageId)
    .map((e) => ({ ...e, data: e.data ? JSON.parse(e.data) : null }));
  const s = statusOf(t.config, i.status);
  return {
    page_id: pageId,
    key,
    number: i.number,
    tracker: { id: i.tracker_id, title: tracker?.title, icon: tracker?.icon, prefix: t.prefix, config: t.config },
    status: s.id,
    status_name: s.name,
    category: s.category,
    color: s.color,
    values: JSON.parse(i.vals || '{}'),
    closed_at: i.closed_at,
    created_by: i.created_by,
    links: out,
    incoming: inc,
    blocked_by_open: inc.filter((l) => l.type === 'blocks' && OPEN_CATEGORIES.has(l.source.category)).length,
    mentions: mentionsOf(key, i.workspace_id, pageId).map(linkInfo),
    events,
  };
}

// Tickets que relacionan o menciona una página cualquiera
export function issuesForPage(pageId, ws) {
  const linked = db
    .prepare(
      `SELECT l.id AS link_id, l.type, l.issue_id FROM issue_links l JOIN pages p ON p.id = l.issue_id
       WHERE l.target_id = ? AND p.trashed_at IS NULL ORDER BY l.id DESC`
    )
    .all(pageId)
    .map((l) => ({ link_id: l.link_id, type: l.type, issue: linkInfo(pageRow.get(l.issue_id)) }))
    .filter((l) => l.issue && !l.issue.trashed);
  const prefixes = prefixesOf(ws);
  const mentioned = [];
  if (prefixes.length) {
    const text = db.prepare('SELECT content_text FROM pages WHERE id = ?').get(pageId)?.content_text || '';
    const re = new RegExp(`(?:^|[^A-Za-z0-9_-])(${prefixes.map(escapeRe).join('|')})-(\\d+)(?![0-9])`, 'gi');
    const seen = new Set();
    for (const m of text.matchAll(re)) {
      const k = `${m[1].toUpperCase()}-${m[2]}`;
      if (seen.has(k)) continue;
      seen.add(k);
      const p = resolveTarget(k, ws);
      if (p && p.kind === 'issue' && !p.trashed_at && p.id !== pageId) mentioned.push(linkInfo(p));
    }
  }
  return { linked, mentioned };
}

// ---------- Escrituras ----------

export function createTracker(req, b) {
  const ws = req.ws;
  const tpl = TEMPLATES[b.template] || TEMPLATES.blank;
  const title = str(b.title, 200) || tpl.label;
  const config = normalizeConfig(b.config || tpl.build());
  let prefix = str(b.prefix, 10)?.toUpperCase();
  if (prefix && !validPrefix(prefix)) throw new IssueError('Prefijo: letras y números, empezando por letra (máx. 10)');
  prefix = uniquePrefix(ws, prefix || tpl.prefix || derivePrefix(title));
  const parent = b.parent_id || null;
  if (parent) {
    const p = pageRow.get(parent);
    if (!p || p.workspace_id !== ws || p.trashed_at || ['idea', 'issue', 'tracker'].includes(p.kind)) {
      throw new IssueError('La lista solo puede ir dentro de una página normal del espacio');
    }
  }
  const id = nanoid(12);
  db.transaction(() => {
    const pos = db.prepare('SELECT COALESCE(MAX(position) + 1, 0) AS p FROM pages WHERE parent_id IS ? AND workspace_id = ?').get(parent, ws).p;
    db.prepare(
      `INSERT INTO pages (id, parent_id, title, icon, content, content_text, position, workspace_id, kind) VALUES (?, ?, ?, ?, '', '', ?, ?, 'tracker')`
    ).run(id, parent, title, str(b.icon, 8) || tpl.icon, pos, ws);
    db.prepare('INSERT INTO trackers (page_id, workspace_id, prefix, config) VALUES (?, ?, ?, ?)').run(id, ws, prefix, JSON.stringify(config));
  })();
  ftsUpsert(id, title, '');
  return trackerDetail(id);
}

// Cambiar la configuración: estados, campos, opciones, vista y prefijo
export function updateTracker(req, trackerId, b) {
  const t = trackerConfig(trackerId);
  if (!t) throw new IssueError('Esta página no es una lista de seguimiento', 404);
  let config = t.config;
  if (b.config) {
    const next = normalizeConfig({ ...config, ...b.config });
    // Un estado en uso no se puede borrar sin decir a dónde van sus tickets
    const gone = config.statuses.filter((s) => !next.statuses.some((n) => n.id === s.id));
    for (const s of gone) {
      const n = db.prepare('SELECT COUNT(*) AS n FROM issues WHERE tracker_id = ? AND status = ?').get(trackerId, s.id).n;
      if (n) {
        const to = b.move_status?.[s.id] && next.statuses.find((x) => x.id === b.move_status[s.id]);
        if (!to) throw new IssueError(`Hay ${n} ticket(s) en «${s.name}»: indica a qué estado pasan antes de quitarlo`);
        db.prepare('UPDATE issues SET status = ? WHERE tracker_id = ? AND status = ?').run(to.id, trackerId, s.id);
      }
    }
    config = next;
  }
  let prefix = t.prefix;
  if (b.prefix !== undefined) {
    const p = String(b.prefix || '').trim().toUpperCase();
    if (!validPrefix(p)) throw new IssueError('Prefijo: letras y números, empezando por letra (máx. 10)');
    if (p !== t.prefix && uniquePrefix(t.workspace_id, p, trackerId) !== p) throw new IssueError(`El prefijo ${p} ya lo usa otra lista`);
    prefix = p;
  }
  db.prepare('UPDATE trackers SET config = ?, prefix = ? WHERE page_id = ?').run(JSON.stringify(config), prefix, trackerId);
  // categoría "hecho" ↔ fecha de cierre
  for (const r of db.prepare('SELECT page_id, status, closed_at FROM issues WHERE tracker_id = ?').all(trackerId)) {
    const done = statusOf(config, r.status).category === 'done';
    if (done && !r.closed_at) db.prepare('UPDATE issues SET closed_at = ? WHERE page_id = ?').run(now(), r.page_id);
    if (!done && r.closed_at) db.prepare('UPDATE issues SET closed_at = NULL WHERE page_id = ?').run(r.page_id);
  }
  if (prefix !== t.prefix) for (const r of db.prepare('SELECT page_id FROM issues WHERE tracker_id = ?').all(trackerId)) indexIssue(r.page_id);
  db.prepare(`UPDATE pages SET updated_at = datetime('now') WHERE id = ?`).run(trackerId);
  return trackerDetail(trackerId);
}

// Valores de campos de entrada (por id o nombre) → guardados
function applyValues(t, current, input, { create }) {
  const vals = { ...current };
  const changes = [];
  for (const [ref, v] of Object.entries(input || {})) {
    const field = findField(t.config, ref);
    if (!field) throw new IssueError(`La lista no tiene ningún campo «${ref}» (${t.config.fields.map((f) => f.name).join(', ') || 'sin campos'})`);
    const next = cleanValue(field, v, { create, config: t.config });
    const prev = vals[field.id] ?? null;
    if (JSON.stringify(prev) === JSON.stringify(next)) continue;
    changes.push({ field, from: prev, to: next });
    if (next === null || (Array.isArray(next) && !next.length)) delete vals[field.id];
    else vals[field.id] = next;
  }
  return { vals, changes };
}

export async function createIssue(req, b, { onIdeaOutcome } = {}) {
  const ws = req.ws;
  const by = actorOf(req);
  const title = str(b.title, 300);
  if (!title) throw new IssueError('Falta el título');
  let trackerId = b.tracker_id || b.tracker;
  if (trackerId && !trackerRow.get(trackerId)) {
    const found = listTrackers(ws).find((x) => x.prefix === String(trackerId).toUpperCase() || fold(x.title) === fold(trackerId));
    trackerId = found?.id;
  }
  const t = trackerId && trackerConfig(trackerId);
  const tp = trackerId && pageRow.get(trackerId);
  if (!t || t.workspace_id !== ws || !tp || tp.trashed_at) throw new IssueError('Indica una lista de seguimiento de este espacio (tracker)', 404);
  const status = b.status ? findStatus(t.config, b.status) : t.config.statuses[0];
  if (!status) throw new IssueError(`"${b.status}" no es un estado de la lista (${t.config.statuses.map((s) => s.name).join(', ')})`);
  const { vals } = applyValues(t, {}, b.values || b.fields, { create: Boolean(b.create_options) });
  let content = '';
  let text = '';
  if (typeof b.description === 'string' && b.description.trim()) {
    const doc = await markdownToDoc(b.description);
    content = JSON.stringify(doc);
    text = extractText(doc);
  }
  let idea = null;
  if (b.from_idea_id) {
    idea = pageRow.get(b.from_idea_id);
    if (!idea || idea.workspace_id !== ws || idea.kind !== 'idea' || idea.trashed_at) throw new IssueError('La idea de origen no existe en este espacio', 404);
  }
  const id = nanoid(12);
  const number = db.transaction(() => {
    const n = db.prepare('SELECT next_number FROM trackers WHERE page_id = ?').get(trackerId).next_number;
    db.prepare('UPDATE trackers SET next_number = ? WHERE page_id = ?').run(n + 1, trackerId);
    if (t.config.__changed) {
      delete t.config.__changed;
      db.prepare('UPDATE trackers SET config = ? WHERE page_id = ?').run(JSON.stringify(t.config), trackerId);
    }
    const pos = db.prepare('SELECT COALESCE(MAX(position) + 1, 0) AS p FROM pages WHERE parent_id = ?').get(trackerId).p;
    db.prepare(
      `INSERT INTO pages (id, parent_id, title, icon, content, content_text, position, workspace_id, kind) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'issue')`
    ).run(id, trackerId, title, str(b.icon, 8) || '🎫', content, text, pos, ws);
    db.prepare(
      `INSERT INTO issues (page_id, tracker_id, workspace_id, number, status, vals, closed_at, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(id, trackerId, ws, n, status.id, JSON.stringify(vals), status.category === 'done' ? now() : null, by);
    addEvent(id, by, 'created', { status: status.name });
    for (const l of Array.isArray(b.links) ? b.links : []) addLink(id, l?.type, l?.target ?? l?.target_id, ws, by);
    if (idea) addLink(id, 'origin', idea.id, ws, by);
    if (Array.isArray(b.tags) && b.tags.length) setPageTags(id, ws, b.tags);
    return n;
  })();
  indexIssue(id);
  logActivity(id);
  if (idea && onIdeaOutcome) onIdeaOutcome(idea.id, { type: 'issue', page_id: id, label: `${t.prefix}-${number}` });
  return issueDetail(id);
}

export function updateIssue(req, pageId, b) {
  const by = actorOf(req);
  const cur = issueRow.get(pageId);
  if (!cur) throw new IssueError('Esta página no es un ticket de seguimiento', 404);
  const t = trackerConfig(cur.tracker_id);
  let status = null;
  if (b?.status !== undefined) {
    status = findStatus(t.config, b.status);
    if (!status) throw new IssueError(`"${b.status}" no es un estado de la lista (${t.config.statuses.map((s) => s.name).join(', ')})`);
  }
  const { vals, changes } = applyValues(t, JSON.parse(cur.vals || '{}'), b?.values || b?.fields, { create: Boolean(b?.create_options) });
  const comment = typeof b?.comment === 'string' && b.comment.trim() ? b.comment.trim().slice(0, 20000) : null;
  const title = b?.title !== undefined ? str(b.title, 300) : undefined;
  if (b?.title !== undefined && !title) throw new IssueError('El título no puede quedar vacío');
  db.transaction(() => {
    if (t.config.__changed) {
      delete t.config.__changed;
      db.prepare('UPDATE trackers SET config = ? WHERE page_id = ?').run(JSON.stringify(t.config), cur.tracker_id);
    }
    if (status && status.id !== cur.status) {
      const prev = statusOf(t.config, cur.status);
      addEvent(pageId, by, 'change', { field: 'status', name: 'Estado', from: prev.name, to: status.name });
      db.prepare('UPDATE issues SET status = ?, closed_at = ? WHERE page_id = ?').run(status.id, status.category === 'done' ? cur.closed_at || now() : null, pageId);
    }
    for (const c of changes) {
      addEvent(pageId, by, 'change', { field: c.field.id, name: c.field.name, from: valueLabel(c.field, c.from), to: valueLabel(c.field, c.to) });
    }
    if (changes.length) db.prepare('UPDATE issues SET vals = ? WHERE page_id = ?').run(JSON.stringify(vals), pageId);
    if (title !== undefined) {
      const old = db.prepare('SELECT title FROM pages WHERE id = ?').get(pageId).title;
      if (old !== title) {
        addEvent(pageId, by, 'change', { field: 'title', name: 'Título', from: old, to: title });
        db.prepare('UPDATE pages SET title = ? WHERE id = ?').run(title, pageId);
      }
    }
    if (comment) addEvent(pageId, by, 'comment', null, comment);
    db.prepare(`UPDATE pages SET updated_at = datetime('now') WHERE id = ?`).run(pageId);
  })();
  if (title !== undefined) indexIssue(pageId);
  logActivity(pageId);
  return issueDetail(pageId);
}

export function linkIssue(req, pageId, type, target) {
  if (!issueRow.get(pageId)) throw new IssueError('Esta página no es un ticket de seguimiento', 404);
  const by = actorOf(req);
  const r = db.transaction(() => addLink(pageId, type, target, req.ws, by))();
  db.prepare(`UPDATE pages SET updated_at = datetime('now') WHERE id = ?`).run(pageId);
  return r;
}

export function unlinkIssue(req, pageId, linkId) {
  const l = db.prepare('SELECT * FROM issue_links WHERE id = ? AND (issue_id = ? OR target_id = ?)').get(linkId, pageId, pageId);
  if (!l) throw new IssueError('Relación no encontrada', 404);
  const by = actorOf(req);
  db.transaction(() => {
    db.prepare('DELETE FROM issue_links WHERE id = ?').run(l.id);
    addEvent(l.issue_id, by, 'unlink', { type: l.type, target_id: l.target_id, title: pageRow.get(l.target_id)?.title });
    db.prepare(`UPDATE pages SET updated_at = datetime('now') WHERE id = ?`).run(l.issue_id);
  })();
  return l;
}

// ---------- Markdown (Claude, compartir, exportar) ----------

const fmtDate = (s) => (s ? s.slice(0, 16).replace('T', ' ') : '');

export function issueHeaderMarkdown(d) {
  const parts = [`**${d.key}** · lista «${d.tracker.title}» · estado: **${d.status_name}** (${CATEGORY_LABELS[d.category]})`];
  for (const f of d.tracker.config.fields) {
    const v = d.values[f.id];
    if (v !== undefined && v !== null && v !== '' && !(Array.isArray(v) && !v.length)) parts.push(`${f.name}: ${valueLabel(f, v)}`);
  }
  let out = parts.join(' · ');
  if (d.blocked_by_open) out += `\n⛔ Bloqueado por ${d.blocked_by_open} ticket(s) abiertos`;
  return out;
}

export function issueRelationsMarkdown(d) {
  const name = (t) => `${t.key ? `${t.key} ` : ''}«${t.title || 'Sin título'}»${t.status ? ` [${t.status}]` : ''} (/p/${t.id})`;
  const lines = [];
  for (const l of d.links) lines.push(`- ${LINK_LABELS[l.type]}: ${name(l.target)}`);
  for (const l of d.incoming) lines.push(`- ${LINK_INVERSE[l.type]}: ${name(l.source)}`);
  for (const m of d.mentions) lines.push(`- Mencionado en: ${name(m)}`);
  return lines.length ? lines.join('\n') : '_(sin relaciones)_';
}

export function issueTimelineMarkdown(d) {
  return d.events
    .map((e) => {
      const head = `- ${fmtDate(e.at)} · ${e.by || '?'}: `;
      if (e.kind === 'created') return head + 'creó el ticket';
      if (e.kind === 'change') return head + `${e.data.name || e.data.field}: ${e.data.from ?? '—'} → ${e.data.to ?? '—'}`;
      if (e.kind === 'link') return head + `${LINK_LABELS[e.data.type]} «${e.data.title || e.data.target_id}»`;
      if (e.kind === 'unlink') return head + `quitó «${LINK_LABELS[e.data.type]}» «${e.data.title || e.data.target_id}»`;
      if (e.kind === 'comment') return head + 'comentó:\n' + e.text.split('\n').map((l) => '    ' + l).join('\n');
      return head + e.kind;
    })
    .join('\n');
}

const cell = (s) => String(s ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ');

export function trackerConfigMarkdown(d) {
  const lines = [`Prefijo: ${d.prefix} · ${d.issues.length} ticket(s)`, '', '## Estados', ''];
  for (const s of d.config.statuses) lines.push(`- ${s.name} (${CATEGORY_LABELS[s.category]})`);
  lines.push('', '## Campos', '');
  if (!d.config.fields.length) lines.push('_(solo título y estado)_');
  for (const f of d.config.fields) {
    lines.push(`- ${f.name} (${FIELD_TYPE_LABELS[f.type]})${f.options ? `: ${f.options.map((o) => o.name).join(', ') || 'sin opciones'}` : ''}`);
  }
  return lines.join('\n');
}

// Tabla Markdown con todos los tickets de una lista
export function trackerTableMarkdown(d) {
  const fields = d.config.fields.filter((f) => !f.hidden);
  const head = ['Clave', 'Título', 'Estado', ...fields.map((f) => f.name)];
  const rows = d.issues.map((i) => [i.key, i.title, i.status_name, ...fields.map((f) => valueLabel(f, i.values[f.id]))]);
  return [
    `| ${head.map(cell).join(' | ')} |`,
    `| ${head.map(() => '---').join(' | ')} |`,
    ...rows.map((r) => `| ${r.map(cell).join(' | ')} |`),
  ].join('\n');
}

// ---------- Rutas ----------

export function mountIssues(app, { notifyTree, notifyPage, onIdeaOutcome }) {
  const send = (res, fn) => {
    try {
      res.json(fn());
    } catch (e) {
      if (e instanceof IssueError) return res.status(e.status).json({ error: e.message });
      console.error('seguimiento:', e);
      res.status(500).json({ error: 'Error en el seguimiento' });
    }
  };

  app.get('/api/trackers', (req, res) =>
    send(res, () => ({ trackers: listTrackers(req.ws), templates: Object.entries(TEMPLATES).map(([id, t]) => ({ id, label: t.label, icon: t.icon })) }))
  );
  app.post('/api/trackers', (req, res) =>
    send(res, () => {
      const d = createTracker(req, req.body || {});
      notifyTree(req);
      return d;
    })
  );
  app.get('/api/pages/:id/tracker', (req, res) =>
    send(res, () => {
      const d = trackerDetail(req.params.id);
      if (!d) throw new IssueError('Esta página no es una lista de seguimiento', 404);
      return d;
    })
  );
  app.patch('/api/pages/:id/tracker', (req, res) =>
    send(res, () => {
      const d = updateTracker(req, req.params.id, req.body || {});
      notifyPage(req, req.params.id);
      notifyTree(req);
      return d;
    })
  );

  app.get('/api/issues', (req, res) =>
    send(res, () => {
      const q = { ...req.query };
      if (typeof q.fields === 'string') {
        try {
          q.fields = JSON.parse(q.fields);
        } catch {
          throw new IssueError('fields debe ser JSON');
        }
      }
      return listIssues(req.ws, q);
    })
  );

  app.post('/api/issues', async (req, res) => {
    try {
      const d = await createIssue(req, req.body || {}, { onIdeaOutcome: (ideaId, o) => onIdeaOutcome(req, ideaId, o) });
      notifyTree(req);
      notifyPage(req, d.tracker.id);
      res.json(d);
    } catch (e) {
      if (e instanceof IssueError) return res.status(e.status).json({ error: e.message });
      console.error('seguimiento:', e);
      if (!res.headersSent) res.status(500).json({ error: 'No se pudo crear el ticket' });
    }
  });

  app.get('/api/pages/:id/issue', (req, res) =>
    send(res, () => {
      const d = issueDetail(req.params.id);
      if (!d) throw new IssueError('Esta página no es un ticket de seguimiento', 404);
      return d;
    })
  );
  app.patch('/api/pages/:id/issue', (req, res) =>
    send(res, () => {
      const d = updateIssue(req, req.params.id, req.body || {});
      notifyPage(req, req.params.id);
      notifyPage(req, d.tracker.id);
      notifyTree(req);
      return d;
    })
  );
  app.post('/api/pages/:id/issue/links', (req, res) =>
    send(res, () => {
      const { type, target } = req.body || {};
      const r = linkIssue(req, req.params.id, type, target ?? req.body?.target_id);
      notifyPage(req, req.params.id);
      notifyPage(req, r.target.id);
      notifyTree(req);
      return issueDetail(req.params.id);
    })
  );
  app.delete('/api/pages/:id/issue/links/:linkId', (req, res) =>
    send(res, () => {
      const l = unlinkIssue(req, req.params.id, Number(req.params.linkId));
      notifyPage(req, l.issue_id);
      notifyPage(req, l.target_id);
      notifyTree(req);
      return { ok: true };
    })
  );
  app.get('/api/pages/:id/issues', (req, res) => send(res, () => issuesForPage(req.params.id, req.ws)));
}
