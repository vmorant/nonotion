// Actas de reunión: un tipo propio de página (kind = 'minutes') con fecha,
// asistentes y proyecto, y una BANDEJA DE PROPUESTAS que nada crea hasta que la
// persona aprueba: tareas (tickets de una lista de seguimiento), listas nuevas,
// documentación, ideas y eventos de calendario. Todo lo creado queda enlazado
// con el acta (relación "viene de" o enlace /p/<acta>).
//
// Las propuestas llegan de tres sitios: "Detectar" (reglas locales sobre el
// texto del acta, sin IA), Claude por el MCP (propose_from_minutes) y, en el
// futuro, apps como Meetly por la API.
import db from './db.js';
import { createIssue, createTracker, linkIssue, IssueError, actorOf, trackerConfig, dateRole } from './issues.js';

export const ITEM_TYPES = ['task', 'list', 'doc', 'idea', 'event'];
export const ITEM_LABELS = { task: 'Tarea', list: 'Lista', doc: 'Documentación', idea: 'Idea', event: 'Evento' };
export const MEETING_TEMPLATE = `## 👥 Asistentes

-

## 📋 Agenda

-

## 📝 Notas

## ✅ Acciones

_Escribe cada tarea como casilla (\`[ ]\` + espacio), con @persona y fecha: se propondrán como tareas con seguimiento._

## ⚖️ Decisiones

-

## 💡 Ideas

-
`;

export class MinutesError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

db.exec(`
CREATE TABLE IF NOT EXISTS minutes (
  page_id TEXT PRIMARY KEY REFERENCES pages(id) ON DELETE CASCADE,
  workspace_id TEXT NOT NULL,
  project_id TEXT,
  attendees TEXT NOT NULL DEFAULT '[]',
  source TEXT,
  created_by TEXT
);
CREATE INDEX IF NOT EXISTS idx_minutes_ws ON minutes(workspace_id);
CREATE TABLE IF NOT EXISTS minutes_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  minutes_id TEXT NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  title TEXT NOT NULL,
  details TEXT NOT NULL DEFAULT '',
  payload TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'pending',
  source TEXT,
  result_id TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  decided_at TEXT,
  decided_by TEXT
);
CREATE INDEX IF NOT EXISTS idx_minutes_items ON minutes_items(minutes_id, status);
`);

const str = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const validDate = (v) => (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null);
const fold = (s) => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
const pageRow = db.prepare('SELECT id, title, icon, kind, parent_id, workspace_id, trashed_at, page_date FROM pages WHERE id = ?');
const minutesRow = db.prepare('SELECT * FROM minutes WHERE page_id = ?');

function cleanAttendees(v) {
  const list = Array.isArray(v) ? v : typeof v === 'string' ? v.split(/[,;\n]/) : [];
  return [...new Set(list.map((x) => str(String(x), 80)).filter(Boolean))].slice(0, 60);
}

function validProject(id, ws) {
  if (!id) return null;
  const p = pageRow.get(id);
  if (!p || p.workspace_id !== ws || p.trashed_at || ['idea', 'issue', 'tracker', 'minutes'].includes(p.kind)) {
    throw new MinutesError('El proyecto debe ser una página normal de este espacio');
  }
  return p.id;
}

function cleanItem(raw, i = 0) {
  if (!raw || typeof raw !== 'object') throw new MinutesError(`Propuesta ${i + 1}: no es un objeto`);
  const type = ITEM_TYPES.includes(raw.type) ? raw.type : null;
  if (!type) throw new MinutesError(`Propuesta ${i + 1}: tipo "${raw.type}" no válido (${ITEM_TYPES.join(', ')})`);
  const title = str(raw.title, 300);
  if (!title) throw new MinutesError(`Propuesta ${i + 1}: falta el título`);
  const p = raw.payload && typeof raw.payload === 'object' ? raw.payload : {};
  const payload = {};
  if (p.tracker_id) payload.tracker_id = str(p.tracker_id, 64);
  if (p.tracker_hint) payload.tracker_hint = str(p.tracker_hint, 40);
  if (p.assignee) payload.assignee = str(p.assignee, 80);
  if (p.date) {
    if (!validDate(p.date)) throw new MinutesError(`Propuesta ${i + 1}: la fecha debe ser AAAA-MM-DD`);
    payload.date = p.date;
  }
  if (p.parent_id) payload.parent_id = str(p.parent_id, 64);
  if (p.template) payload.template = str(p.template, 20);
  if (p.fields && typeof p.fields === 'object') payload.fields = p.fields;
  return { type, title, details: str(raw.details, 20000), payload };
}

// ---------- Detección local de propuestas (sin IA) ----------

const MONTH_DAY = /\b(\d{1,2})[/.-](\d{1,2})(?:[/.-](\d{2,4}))?\b/;
function findDate(text, baseYear) {
  const iso = text.match(/\b(\d{4})-(\d{2})-(\d{2})\b/);
  if (iso) return iso[0];
  const m = text.match(MONTH_DAY);
  if (!m) return null;
  const d = Number(m[1]);
  const mo = Number(m[2]);
  let y = m[3] ? Number(m[3]) : baseYear;
  if (y < 100) y += 2000;
  if (d < 1 || d > 31 || mo < 1 || mo > 12) return null;
  return `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}
function findAssignee(text) {
  const at = text.match(/@([\p{L}\p{N}._-]+)/u);
  if (at) return at[1];
  const paren = text.match(/\(([^()]{2,40})\)\s*$/);
  if (paren && !/\d/.test(paren[1])) return paren[1].trim();
  const dash = text.match(/\s[—–-]\s*([\p{Lu}][\p{L}]+(?:\s[\p{Lu}][\p{L}]+)?)\s*$/u);
  return dash ? dash[1] : null;
}
const cleanTitle = (t) =>
  t
    .replace(/@[\p{L}\p{N}._-]+/gu, '')
    .replace(/\(([^()]{2,40})\)\s*$/, '')
    .replace(/\b(para el |antes del? |el )?\d{4}-\d{2}-\d{2}\b/g, '')
    .replace(/\b(para el |antes del? |el )?\d{1,2}[/.-]\d{1,2}(?:[/.-]\d{2,4})?\b/g, '')
    .replace(/\s[—–-]\s*$/, '')
    .replace(/[*_`]/g, '')
    .replace(/\s{2,}/g, ' ')
    .trim()
    .replace(/[,;:.]+$/, '');

export function detectProposals(markdown, { date = null, title = '' } = {}) {
  const baseYear = Number((date || new Date().toISOString()).slice(0, 4));
  const out = [];
  const decisions = [];
  let section = '';
  for (const raw of String(markdown || '').split('\n')) {
    const line = raw.trim();
    const h = line.match(/^#{1,6}\s+(.*)$/);
    if (h) {
      section = fold(h[1]);
      continue;
    }
    const next = line.match(/pr[oó]xima reuni[oó]n\s*[:\-–]\s*(.+)$/i);
    if (next) {
      const d = findDate(next[1], baseYear);
      if (d) out.push({ type: 'event', title: `Próxima reunión${title ? `: ${title}` : ''}`, details: next[1].trim(), payload: { date: d } });
      continue;
    }
    const task = line.match(/^[-*]\s+\[ \]\s+(.+)$/);
    if (task) {
      const text = task[1].trim();
      if (!cleanTitle(text)) continue;
      const blocker = /riesgo|bloque|impedimento/.test(section);
      out.push({
        type: 'task',
        title: cleanTitle(text),
        details: text,
        payload: {
          ...(findAssignee(text) ? { assignee: findAssignee(text) } : {}),
          ...(findDate(text, baseYear) ? { date: findDate(text, baseYear) } : {}),
          tracker_hint: blocker ? 'blockers' : 'todo',
        },
      });
      continue;
    }
    const bullet = line.match(/^[-*]\s+(?!\[[ xX]\])(.+)$/);
    if (!bullet || !cleanTitle(bullet[1])) continue;
    const text = bullet[1].trim();
    if (/idea/.test(section)) out.push({ type: 'idea', title: cleanTitle(text), details: text, payload: {} });
    else if (/decisi|acuerdo/.test(section)) decisions.push(text);
    else if (/riesgo|bloque|impedimento/.test(section)) out.push({ type: 'task', title: cleanTitle(text), details: text, payload: { tracker_hint: 'blockers' } });
    else if (/documenta/.test(section)) out.push({ type: 'doc', title: cleanTitle(text), details: text, payload: {} });
    else if (/evento|fechas|calendario|hitos/.test(section)) {
      const d = findDate(text, baseYear);
      if (d) out.push({ type: 'event', title: cleanTitle(text), details: text, payload: { date: d } });
    }
  }
  if (decisions.length) {
    out.push({
      type: 'doc',
      title: `Decisiones${title ? ` · ${title}` : ''}`,
      details: decisions.map((d) => `- ${d}`).join('\n'),
      payload: {},
    });
  }
  return out;
}

// ---------- Lecturas ----------

const pageInfo = (p) => (p ? { id: p.id, title: p.title, icon: p.icon, kind: p.kind, trashed: Boolean(p.trashed_at) } : null);

function itemOut(r) {
  return { ...r, payload: JSON.parse(r.payload || '{}'), result: r.result_id ? pageInfo(pageRow.get(r.result_id)) : null };
}

export function minutesDetail(pageId) {
  const m = minutesRow.get(pageId);
  if (!m) return null;
  const p = pageRow.get(pageId);
  const project = m.project_id ? pageRow.get(m.project_id) : null;
  return {
    page_id: pageId,
    title: p.title,
    date: p.page_date,
    attendees: JSON.parse(m.attendees || '[]'),
    project: project && !project.trashed_at ? pageInfo(project) : null,
    source: m.source,
    created_by: m.created_by,
    items: db.prepare('SELECT * FROM minutes_items WHERE minutes_id = ? ORDER BY id').all(pageId).map(itemOut),
  };
}

export function listMinutes(ws) {
  return db
    .prepare(
      `SELECT p.id, p.title, p.icon, p.page_date AS date, p.updated_at, m.project_id, m.attendees, m.source,
              (SELECT COUNT(*) FROM minutes_items i WHERE i.minutes_id = p.id AND i.status = 'pending') AS pending,
              (SELECT COUNT(*) FROM minutes_items i WHERE i.minutes_id = p.id AND i.status = 'created') AS created
       FROM minutes m JOIN pages p ON p.id = m.page_id
       WHERE m.workspace_id = ? AND p.trashed_at IS NULL
       ORDER BY COALESCE(p.page_date, date(p.created_at)) DESC, p.created_at DESC`
    )
    .all(ws)
    .map((r) => {
      const project = r.project_id ? pageRow.get(r.project_id) : null;
      return { ...r, attendees: JSON.parse(r.attendees || '[]'), project: project && !project.trashed_at ? pageInfo(project) : null };
    });
}

// ---------- Escrituras ----------

function addItems(minutesId, items, source) {
  const ins = db.prepare('INSERT INTO minutes_items (minutes_id, type, title, details, payload, source) VALUES (?, ?, ?, ?, ?, ?)');
  const existing = new Set(
    db.prepare(`SELECT type, title FROM minutes_items WHERE minutes_id = ?`).all(minutesId).map((r) => `${r.type}:${fold(r.title)}`)
  );
  let added = 0;
  for (const it of items) {
    const k = `${it.type}:${fold(it.title)}`;
    if (existing.has(k)) continue; // la misma propuesta no se repite
    existing.add(k);
    ins.run(minutesId, it.type, it.title, it.details || '', JSON.stringify(it.payload || {}), source);
    added++;
  }
  return added;
}

export async function createMinutes(req, b, { createMarkdownPage }) {
  const ws = req.ws;
  const date = b.date ? validDate(b.date) : new Date().toISOString().slice(0, 10);
  if (!date) throw new MinutesError('La fecha debe ser AAAA-MM-DD');
  const project = validProject(b.project_id, ws);
  const proposals = (Array.isArray(b.proposals) ? b.proposals : []).map(cleanItem);
  const title = str(b.title, 200) || `Reunión ${date}`;
  const markdown = typeof b.markdown === 'string' && b.markdown.trim() ? b.markdown : MEETING_TEMPLATE;
  const page = await createMarkdownPage(req, { title, markdown, page_date: date, icon: str(b.icon, 8) || '📝', kind: 'minutes', tags: b.tags });
  db.prepare('INSERT INTO minutes (page_id, workspace_id, project_id, attendees, source, created_by) VALUES (?, ?, ?, ?, ?, ?)').run(
    page.id,
    ws,
    project,
    JSON.stringify(cleanAttendees(b.attendees)),
    str(b.source, 40) || (req.authKind === 'token' ? 'api' : 'manual'),
    actorOf(req)
  );
  if (proposals.length) addItems(page.id, proposals, req.authKind === 'token' ? 'claude' : 'manual');
  return minutesDetail(page.id);
}

export function updateMinutes(req, pageId, b) {
  const m = minutesRow.get(pageId);
  if (!m) throw new MinutesError('Esta página no es un acta', 404);
  if (b.date !== undefined) {
    const d = validDate(b.date);
    if (!d) throw new MinutesError('La fecha debe ser AAAA-MM-DD');
    db.prepare(`UPDATE pages SET page_date = ?, updated_at = datetime('now') WHERE id = ?`).run(d, pageId);
  }
  if (b.project_id !== undefined) db.prepare('UPDATE minutes SET project_id = ? WHERE page_id = ?').run(b.project_id ? validProject(b.project_id, req.ws) : null, pageId);
  if (b.attendees !== undefined) db.prepare('UPDATE minutes SET attendees = ? WHERE page_id = ?').run(JSON.stringify(cleanAttendees(b.attendees)), pageId);
  return minutesDetail(pageId);
}

export function proposeItems(req, pageId, list, source) {
  if (!minutesRow.get(pageId)) throw new MinutesError('Esta página no es un acta', 404);
  const items = (Array.isArray(list) ? list : []).map(cleanItem);
  if (!items.length) throw new MinutesError('No hay propuestas');
  return addItems(pageId, items, source || (req.authKind === 'token' ? 'claude' : 'manual'));
}

export function editItem(pageId, itemId, b) {
  const it = db.prepare('SELECT * FROM minutes_items WHERE id = ? AND minutes_id = ?').get(itemId, pageId);
  if (!it) throw new MinutesError('Propuesta no encontrada', 404);
  if (it.status !== 'pending') throw new MinutesError('Solo se editan propuestas pendientes');
  const cur = itemOut(it);
  const next = cleanItem({ type: b.type ?? cur.type, title: b.title ?? cur.title, details: b.details ?? cur.details, payload: { ...cur.payload, ...(b.payload || {}) } });
  db.prepare('UPDATE minutes_items SET type = ?, title = ?, details = ?, payload = ? WHERE id = ?').run(next.type, next.title, next.details, JSON.stringify(next.payload), itemId);
  return itemOut(db.prepare('SELECT * FROM minutes_items WHERE id = ?').get(itemId));
}

export function rejectItem(req, pageId, itemId) {
  const r = db
    .prepare(`UPDATE minutes_items SET status = 'rejected', decided_at = datetime('now'), decided_by = ? WHERE id = ? AND minutes_id = ? AND status = 'pending'`)
    .run(actorOf(req), itemId, pageId);
  if (!r.changes) throw new MinutesError('Propuesta no encontrada o ya decidida', 404);
}

// Vuelve a dejar pendiente una propuesta descartada
export function reopenItem(pageId, itemId) {
  const r = db.prepare(`UPDATE minutes_items SET status = 'pending', decided_at = NULL, decided_by = NULL WHERE id = ? AND minutes_id = ? AND status = 'rejected'`).run(itemId, pageId);
  if (!r.changes) throw new MinutesError('Solo se recuperan propuestas descartadas', 404);
}

// Busca la lista de seguimiento más adecuada para una tarea
function suggestTracker(ws, hint) {
  const ts = db
    .prepare(`SELECT t.page_id, t.prefix, p.title FROM trackers t JOIN pages p ON p.id = t.page_id WHERE t.workspace_id = ? AND p.trashed_at IS NULL`)
    .all(ws);
  const re = hint === 'blockers' ? /bloq|blq|riesgo|imped/ : /to-?do|tarea|accion|pendiente/;
  return ts.find((t) => re.test(fold(`${t.title} ${t.prefix}`)))?.page_id || null;
}

// Aprobar: crea lo propuesto (con los cambios que se indiquen) y lo enlaza al acta
export async function approveItem(req, pageId, itemId, overrides, { createMarkdownPage, createIdeaPage }) {
  const it = db.prepare('SELECT * FROM minutes_items WHERE id = ? AND minutes_id = ?').get(itemId, pageId);
  if (!it) throw new MinutesError('Propuesta no encontrada', 404);
  if (it.status === 'created') throw new MinutesError('Esta propuesta ya se creó');
  const cur = itemOut(it);
  const o = overrides || {};
  const item = cleanItem({ type: o.type ?? cur.type, title: o.title ?? cur.title, details: o.details ?? cur.details, payload: { ...cur.payload, ...(o.payload || {}) } });
  const acta = pageRow.get(pageId);
  const m = minutesRow.get(pageId);
  const ref = `[📝 ${acta.title || 'Acta'}](/p/${pageId})`;
  const parent = (() => {
    try {
      return validProject(item.payload.parent_id || m.project_id, req.ws);
    } catch {
      return null;
    }
  })();
  let resultId;
  try {
    if (item.type === 'task') {
      const trackerId = item.payload.tracker_id || suggestTracker(req.ws, item.payload.tracker_hint);
      if (!trackerId) throw new MinutesError('Elige en qué lista de seguimiento va la tarea (no hay ninguna adecuada)');
      const t = trackerConfig(trackerId);
      if (!t || t.workspace_id !== req.ws) throw new MinutesError('La lista elegida no existe en este espacio', 404);
      const values = { ...(item.payload.fields || {}) };
      const person = t.config.fields.find((f) => f.type === 'person');
      if (item.payload.assignee && person && values[person.name] === undefined) values[person.id] = item.payload.assignee;
      const dateField =
        t.config.fields.find((f) => f.type === 'date' && dateRole(f) === 'deadline') || t.config.fields.find((f) => f.type === 'date');
      if (item.payload.date && dateField) values[dateField.id] = item.payload.date;
      const d = await createIssue(req, {
        tracker_id: trackerId,
        title: item.title,
        description: `${item.details && item.details !== item.title ? `${item.details}\n\n` : ''}Sale del acta ${ref}.`,
        values,
        create_options: true,
        links: [{ type: 'origin', target: pageId }],
      });
      resultId = d.page_id;
    } else if (item.type === 'list') {
      const d = createTracker(req, { title: item.title, template: item.payload.template || 'todo', parent_id: parent || undefined });
      linkIssue(req, d.id, 'origin', pageId);
      resultId = d.id;
    } else if (item.type === 'doc') {
      const p = await createMarkdownPage(req, {
        title: item.title,
        markdown: `> Sale del acta ${ref}\n\n${item.details || ''}`,
        parent_id: parent,
        icon: '📄',
      });
      resultId = p.id;
    } else if (item.type === 'idea') {
      resultId = createIdeaPage(req, { title: item.title, seeds: [{ kind: 'page', page_id: pageId, text: item.details || item.title }] }).id;
    } else if (item.type === 'event') {
      if (!item.payload.date) throw new MinutesError('Indica la fecha del evento');
      const p = await createMarkdownPage(req, {
        title: item.title,
        markdown: `${item.details ? `${item.details}\n\n` : ''}Relacionado con el acta ${ref}.`,
        parent_id: parent,
        page_date: item.payload.date,
        icon: '📅',
      });
      resultId = p.id;
    }
  } catch (e) {
    if (e instanceof IssueError) throw new MinutesError(e.message, e.status);
    throw e;
  }
  db.prepare(
    `UPDATE minutes_items SET type = ?, title = ?, details = ?, payload = ?, status = 'created', result_id = ?, decided_at = datetime('now'), decided_by = ? WHERE id = ?`
  ).run(item.type, item.title, item.details, JSON.stringify(item.payload), resultId, actorOf(req), itemId);
  return itemOut(db.prepare('SELECT * FROM minutes_items WHERE id = ?').get(itemId));
}

// ---------- Markdown (Claude y export) ----------

export function minutesHeaderMarkdown(d) {
  return [
    `Acta de reunión · fecha: ${d.date || '—'}${d.project ? ` · proyecto: «${d.project.title}» (/p/${d.project.id})` : ''}`,
    d.attendees.length ? `Asistentes: ${d.attendees.join(', ')}` : null,
  ]
    .filter(Boolean)
    .join('\n');
}

export function minutesItemsMarkdown(d) {
  if (!d.items.length) return '_(sin propuestas)_';
  const st = { pending: '⏳ pendiente de aprobar', created: '✅ creada', rejected: '✗ descartada' };
  return d.items
    .map((i) => {
      const extra = [i.payload.assignee && `responsable ${i.payload.assignee}`, i.payload.date && `fecha ${i.payload.date}`].filter(Boolean).join(', ');
      return `- [${i.id}] ${ITEM_LABELS[i.type]}: ${i.title}${extra ? ` (${extra})` : ''} — ${st[i.status]}${i.result ? ` → «${i.result.title}» (/p/${i.result.id})` : ''}`;
    })
    .join('\n');
}

// ---------- Rutas ----------

export function mountMinutes(app, deps) {
  const { notifyTree, notifyPage, toMarkdown } = deps;
  const wrap = (fn) => async (req, res) => {
    try {
      res.json(await fn(req));
    } catch (e) {
      if (e instanceof MinutesError) return res.status(e.status).json({ error: e.message });
      console.error('actas:', e);
      if (!res.headersSent) res.status(500).json({ error: 'Error en las actas' });
    }
  };
  const changed = (req, id) => {
    notifyPage(req, id);
    notifyTree(req);
  };

  app.get('/api/minutes', wrap((req) => ({ minutes: listMinutes(req.ws) })));
  app.post(
    '/api/minutes',
    wrap(async (req) => {
      const d = await createMinutes(req, req.body || {}, deps);
      notifyTree(req);
      return d;
    })
  );
  app.get(
    '/api/pages/:id/minutes',
    wrap((req) => {
      const d = minutesDetail(req.params.id);
      if (!d) throw new MinutesError('Esta página no es un acta', 404);
      return d;
    })
  );
  app.patch(
    '/api/pages/:id/minutes',
    wrap((req) => {
      const d = updateMinutes(req, req.params.id, req.body || {});
      changed(req, req.params.id);
      return d;
    })
  );
  app.post(
    '/api/pages/:id/minutes/items',
    wrap((req) => {
      const added = proposeItems(req, req.params.id, req.body?.proposals, req.body?.source);
      changed(req, req.params.id);
      return { added, ...minutesDetail(req.params.id) };
    })
  );
  app.post(
    '/api/pages/:id/minutes/detect',
    wrap(async (req) => {
      const d = minutesDetail(req.params.id);
      if (!d) throw new MinutesError('Esta página no es un acta', 404);
      const md = await toMarkdown(req.params.id);
      const found = detectProposals(md, { date: d.date, title: d.title });
      const added = found.length ? addItems(req.params.id, found.map(cleanItem), 'auto') : 0;
      if (added) changed(req, req.params.id);
      return { found: found.length, added, ...minutesDetail(req.params.id) };
    })
  );
  app.patch(
    '/api/pages/:id/minutes/items/:itemId',
    wrap((req) => {
      const it = editItem(req.params.id, Number(req.params.itemId), req.body || {});
      changed(req, req.params.id);
      return it;
    })
  );
  app.post(
    '/api/pages/:id/minutes/items/:itemId/approve',
    wrap(async (req) => {
      const it = await approveItem(req, req.params.id, Number(req.params.itemId), req.body || {}, deps);
      changed(req, req.params.id);
      return it;
    })
  );
  app.post(
    '/api/pages/:id/minutes/items/:itemId/reject',
    wrap((req) => {
      rejectItem(req, req.params.id, Number(req.params.itemId));
      changed(req, req.params.id);
      return { ok: true };
    })
  );
  app.post(
    '/api/pages/:id/minutes/items/:itemId/reopen',
    wrap((req) => {
      reopenItem(req.params.id, Number(req.params.itemId));
      changed(req, req.params.id);
      return { ok: true };
    })
  );
}
