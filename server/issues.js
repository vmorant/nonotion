// Elementos de seguimiento (issues): bloqueos, problemas, riesgos, tareas,
// decisiones y preguntas de un proyecto, con estado, relaciones y cronología.
//
// Un elemento es una página con kind = 'issue' (descripción con el editor
// normal, etiquetas, papelera, historial, búsqueda, grafo y backlinks) más:
//   - issues: campos para filtrar rápido y un número por espacio (AXA-12)
//   - issue_links: relaciones con tipo hacia páginas u otros elementos
//   - issue_events: la cronología (alta, cambios, comentarios, relaciones)
// Viven fuera del árbol de páginas (vista Seguimiento), como las ideas.
import { nanoid } from 'nanoid';
import db, { ftsUpsert, extractText, logActivity } from './db.js';
import { markdownToDoc } from './markdown.js';
import { setPageTags, splitTags, TAGS_COLUMN } from './tags.js';

export const STATUSES = ['open', 'in_progress', 'blocked', 'resolved', 'closed'];
export const OPEN_STATUSES = new Set(['open', 'in_progress', 'blocked']);
export const STATUS_LABELS = { open: 'Abierto', in_progress: 'En curso', blocked: 'Bloqueado', resolved: 'Resuelto', closed: 'Cerrado' };
export const TYPES = ['blocker', 'problem', 'risk', 'task', 'decision', 'question'];
export const TYPE_LABELS = { blocker: 'Bloqueo', problem: 'Problema', risk: 'Riesgo', task: 'Tarea', decision: 'Decisión', question: 'Pregunta' };
export const TYPE_ICONS = { blocker: '🚧', problem: '🐞', risk: '⚠️', task: '✅', decision: '⚖️', question: '❓' };
export const PRIORITIES = ['low', 'medium', 'high', 'critical'];
export const PRIORITY_LABELS = { low: 'Baja', medium: 'Media', high: 'Alta', critical: 'Crítica' };
// Relaciones vistas desde el elemento que las crea, y su lectura inversa
export const LINK_TYPES = ['blocks', 'relates', 'documents', 'origin'];
export const LINK_LABELS = { blocks: 'Bloquea a', relates: 'Relacionado con', documents: 'Documentado en', origin: 'Viene de' };
export const LINK_INVERSE = { blocks: 'Bloqueado por', relates: 'Relacionado con', documents: 'Documenta', origin: 'Originó' };

export class IssueError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

// ---------- Esquema ----------

db.exec(`
CREATE TABLE IF NOT EXISTS issues (
  page_id TEXT PRIMARY KEY REFERENCES pages(id) ON DELETE CASCADE,
  workspace_id TEXT NOT NULL,
  number INTEGER NOT NULL,
  type TEXT NOT NULL DEFAULT 'task',
  status TEXT NOT NULL DEFAULT 'open',
  priority TEXT NOT NULL DEFAULT 'medium',
  assignee TEXT,
  due_date TEXT,
  milestone TEXT,
  closed_at TEXT,
  created_by TEXT,
  UNIQUE (workspace_id, number)
);
CREATE INDEX IF NOT EXISTS idx_issues_ws_status ON issues(workspace_id, status);
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
if (!db.prepare('PRAGMA table_info(workspaces)').all().some((c) => c.name === 'issue_prefix')) {
  db.exec('ALTER TABLE workspaces ADD COLUMN issue_prefix TEXT');
}

// Prefijo de las claves (AXA-12): del nombre del espacio, editable en Ajustes
export function derivePrefix(name) {
  const clean = String(name || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toUpperCase()
    .replace(/[^A-Z0-9 ]+/g, ' ')
    .trim();
  const words = clean.split(/\s+/).filter(Boolean);
  let p = words.length > 1 ? words.map((w) => w[0]).join('').slice(0, 5) : (words[0] || '').slice(0, 5);
  if (!/^[A-Z]/.test(p)) p = 'NN' + p;
  return p.slice(0, 10) || 'NN';
}
export const validPrefix = (p) => typeof p === 'string' && /^[A-Z][A-Z0-9]{0,9}$/.test(p);

export function prefixOf(ws) {
  const row = db.prepare('SELECT name, issue_prefix FROM workspaces WHERE id = ?').get(ws);
  if (!row) return 'NN';
  if (validPrefix(row.issue_prefix)) return row.issue_prefix;
  const p = derivePrefix(row.name);
  db.prepare('UPDATE workspaces SET issue_prefix = ? WHERE id = ?').run(p, ws);
  return p;
}

// La clave entra en el índice de búsqueda (buscar "AXA-12" encuentra el elemento)
export function issueKeyOf(pageId) {
  const r = db
    .prepare('SELECT i.number, i.workspace_id FROM issues i WHERE i.page_id = ?')
    .get(pageId);
  return r ? `${prefixOf(r.workspace_id)}-${r.number}` : null;
}
export function indexIssue(pageId) {
  const p = db.prepare('SELECT title, content_text FROM pages WHERE id = ?').get(pageId);
  if (p) ftsUpsert(pageId, p.title, p.content_text); // ftsUpsert añade la clave
}

// ---------- Validación ----------

const str = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : undefined);
const validDate = (v) => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v);

function cleanFields(b, { partial }) {
  const out = {};
  const pick = (k, list, labels) => {
    if (b[k] === undefined) return;
    if (!list.includes(b[k])) throw new IssueError(`${k} "${b[k]}" no válido (${list.map((x) => `${x} = ${labels[x]}`).join(', ')})`);
    out[k] = b[k];
  };
  pick('type', TYPES, TYPE_LABELS);
  pick('status', STATUSES, STATUS_LABELS);
  pick('priority', PRIORITIES, PRIORITY_LABELS);
  if (b.assignee !== undefined) out.assignee = b.assignee === null ? null : str(b.assignee, 80) || null;
  if (b.milestone !== undefined) out.milestone = b.milestone === null ? null : str(b.milestone, 120) || null;
  if (b.due_date !== undefined) {
    if (b.due_date === null || b.due_date === '') out.due_date = null;
    else if (!validDate(b.due_date)) throw new IssueError('due_date debe ser AAAA-MM-DD');
    else out.due_date = b.due_date;
  }
  if (!partial) {
    out.type ??= 'task';
    out.status ??= 'open';
    out.priority ??= 'medium';
  }
  return out;
}

// Quién hace el cambio, para la cronología
export function actorOf(req) {
  if (req.authKind === 'token') return req.tokenLogin ? `Claude (${req.tokenLogin})` : 'Claude';
  if (req.authKind === 'session') return req.user?.login || 'persona';
  return 'local';
}

const pageRow = db.prepare('SELECT id, title, icon, kind, workspace_id, trashed_at FROM pages WHERE id = ?');
const issueRow = db.prepare('SELECT * FROM issues WHERE page_id = ?');
const addEvent = (pageId, by, kind, data = null, text = null) =>
  db
    .prepare('INSERT INTO issue_events (page_id, by, kind, data, text) VALUES (?, ?, ?, ?, ?)')
    .run(pageId, by, kind, data ? JSON.stringify(data) : null, text);

// Resuelve un destino por id de página o por clave (AXA-12), dentro del espacio
export function resolveTarget(ref, ws) {
  const s = String(ref || '').trim();
  const m = s.match(/^([A-Za-z][A-Za-z0-9]{0,9})-(\d+)$/);
  if (m && m[1].toUpperCase() === prefixOf(ws)) {
    const r = db.prepare('SELECT page_id FROM issues WHERE workspace_id = ? AND number = ?').get(ws, Number(m[2]));
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
  if (!target || target.trashed_at) throw new IssueError(`"${targetRef}" no es una página ni un elemento de este espacio`, 404);
  if (target.id === issueId) throw new IssueError('Un elemento no puede relacionarse consigo mismo');
  if (type === 'blocks' && target.kind !== 'issue') throw new IssueError('"Bloquea a" solo se usa entre elementos de seguimiento');
  // Un bloqueo en ciclo (A bloquea a B y B a A) no tendría salida
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
  return { id: Number(r.lastInsertRowid) || null, target, added: Boolean(r.changes) };
}

// ---------- Lecturas ----------

const linkInfo = (p) => {
  if (!p) return null;
  const i = p.kind === 'issue' ? issueRow.get(p.id) : null;
  return {
    id: p.id,
    title: p.title,
    icon: p.icon,
    kind: p.kind,
    trashed: Boolean(p.trashed_at),
    ...(i ? { key: `${prefixOf(i.workspace_id)}-${i.number}`, status: i.status, type: i.type } : {}),
  };
};

// Páginas cuyo texto menciona una clave (sin confundir AXA-1 con AXA-12)
function mentionsOf(key, ws, exceptId) {
  const re = new RegExp(`(^|[^A-Za-z0-9_-])${key}(?![0-9])`, 'i');
  return db
    .prepare(
      `SELECT id, title, icon, kind FROM pages
       WHERE workspace_id = ? AND trashed_at IS NULL AND id != ? AND instr(upper(content_text), upper(?)) > 0
       ORDER BY updated_at DESC LIMIT 200`
    )
    .all(ws, exceptId, key)
    .filter((p) => re.test(db.prepare('SELECT content_text FROM pages WHERE id = ?').get(p.id).content_text || ''));
}

export function issueDetail(pageId) {
  const i = issueRow.get(pageId);
  if (!i) return null;
  const prefix = prefixOf(i.workspace_id);
  const key = `${prefix}-${i.number}`;
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
  const blockedBy = inc.filter((l) => l.type === 'blocks' && OPEN_STATUSES.has(l.source.status));
  return {
    ...i,
    key,
    prefix,
    links: out,
    incoming: inc,
    blocked_by_open: blockedBy.length,
    mentions: mentionsOf(key, i.workspace_id, pageId).map(linkInfo),
    events,
  };
}

export function listIssues(ws, f = {}) {
  const prefix = prefixOf(ws);
  const rows = db
    .prepare(
      `SELECT p.id, p.title, p.icon, p.created_at, p.updated_at, ${TAGS_COLUMN.replace(/pages\.id/g, 'p.id')},
              i.number, i.type, i.status, i.priority, i.assignee, i.due_date, i.milestone, i.closed_at, i.created_by,
              (SELECT COUNT(*) FROM issue_links l JOIN issues b ON b.page_id = l.issue_id JOIN pages bp ON bp.id = l.issue_id
                 WHERE l.target_id = p.id AND l.type = 'blocks' AND b.status IN ('open','in_progress','blocked') AND bp.trashed_at IS NULL) AS blocked_by_open,
              (SELECT COUNT(*) FROM issue_links l JOIN pages t ON t.id = l.target_id WHERE l.issue_id = p.id AND l.type = 'blocks' AND t.trashed_at IS NULL) AS blocks_count,
              (SELECT COUNT(*) FROM issue_links l JOIN pages t ON t.id = l.target_id WHERE l.issue_id = p.id AND l.type != 'blocks' AND t.trashed_at IS NULL) AS links_count,
              (SELECT COUNT(*) FROM issue_events e WHERE e.page_id = p.id AND e.kind = 'comment') AS comments
       FROM issues i JOIN pages p ON p.id = i.page_id
       WHERE i.workspace_id = ? AND p.trashed_at IS NULL
       ORDER BY i.number DESC`
    )
    .all(ws)
    .map((r) => ({ ...r, key: `${prefix}-${r.number}`, tags: splitTags(r.tags) }));
  const list = (v) => (Array.isArray(v) ? v : String(v || '').split(',')).map((x) => x.trim()).filter(Boolean);
  let out = rows;
  if (f.key) out = out.filter((r) => r.key.toLowerCase() === String(f.key).trim().toLowerCase());
  if (f.status) {
    const s = list(f.status);
    const want = new Set(s.flatMap((x) => (x === 'active' ? [...OPEN_STATUSES] : [x])));
    out = out.filter((r) => want.has(r.status));
  }
  if (f.type) {
    const t = new Set(list(f.type));
    out = out.filter((r) => t.has(r.type));
  }
  if (f.priority) {
    const p = new Set(list(f.priority));
    out = out.filter((r) => p.has(r.priority));
  }
  if (f.assignee) {
    const a = String(f.assignee).toLowerCase();
    out = out.filter((r) => (a === 'none' ? !r.assignee : (r.assignee || '').toLowerCase().includes(a)));
  }
  if (f.tag) {
    const t = list(f.tag).map((x) => x.toLowerCase());
    out = out.filter((r) => t.every((x) => r.tags.includes(x)));
  }
  if (f.blocked === 'true' || f.blocked === true) {
    out = out.filter((r) => OPEN_STATUSES.has(r.status) && (r.status === 'blocked' || r.blocked_by_open > 0 || r.type === 'blocker'));
  }
  if (f.q) {
    const q = String(f.q).toLowerCase();
    out = out.filter((r) => r.key.toLowerCase().includes(q) || (r.title || '').toLowerCase().includes(q) || (r.assignee || '').toLowerCase().includes(q));
  }
  return { prefix, issues: out };
}

// Elementos relacionados con una página cualquiera: los que la enlazan y los
// que su texto menciona por clave
export function issuesForPage(pageId, ws) {
  const linked = db
    .prepare(
      `SELECT l.id AS link_id, l.type, l.issue_id FROM issue_links l JOIN pages p ON p.id = l.issue_id
       WHERE l.target_id = ? AND p.trashed_at IS NULL ORDER BY l.id DESC`
    )
    .all(pageId)
    .map((l) => ({ link_id: l.link_id, type: l.type, issue: linkInfo(pageRow.get(l.issue_id)) }));
  const page = db.prepare('SELECT content_text FROM pages WHERE id = ?').get(pageId);
  const prefix = prefixOf(ws);
  const nums = new Set();
  for (const m of String(page?.content_text || '').matchAll(new RegExp(`(?:^|[^A-Za-z0-9_-])${prefix}-(\\d+)(?![0-9])`, 'gi'))) {
    nums.add(Number(m[1]));
  }
  const mentioned = [...nums]
    .map((n) => db.prepare('SELECT page_id FROM issues WHERE workspace_id = ? AND number = ?').get(ws, n))
    .filter(Boolean)
    .map((r) => linkInfo(pageRow.get(r.page_id)))
    .filter((x) => x && !x.trashed && x.id !== pageId);
  return { linked: linked.filter((l) => l.issue && !l.issue.trashed), mentioned };
}

// Índice de claves para enlazar AXA-12 en el editor
export function issueIndex(ws) {
  const prefix = prefixOf(ws);
  return {
    prefix,
    issues: db
      .prepare(
        `SELECT i.number, i.page_id AS id, i.status, i.type, p.title FROM issues i JOIN pages p ON p.id = i.page_id
         WHERE i.workspace_id = ? AND p.trashed_at IS NULL`
      )
      .all(ws)
      .map((r) => ({ key: `${prefix}-${r.number}`, id: r.id, status: r.status, type: r.type, title: r.title })),
  };
}

// ---------- Escrituras ----------

export async function createIssue(req, b, { onIdeaOutcome } = {}) {
  const ws = req.ws;
  const by = actorOf(req);
  const title = str(b.title, 300);
  if (!title) throw new IssueError('Falta el título');
  const fields = cleanFields(b, { partial: false });
  let content = '';
  let text = '';
  if (typeof b.description === 'string' && b.description.trim()) {
    const doc = await markdownToDoc(b.description);
    content = JSON.stringify(doc);
    text = extractText(doc);
  }
  const links = Array.isArray(b.links) ? b.links : [];
  let idea = null;
  if (b.from_idea_id) {
    idea = pageRow.get(b.from_idea_id);
    if (!idea || idea.workspace_id !== ws || idea.kind !== 'idea' || idea.trashed_at) throw new IssueError('La idea de origen no existe en este espacio', 404);
  }
  const id = nanoid(12);
  const created = db.transaction(() => {
    const number = db.prepare('SELECT COALESCE(MAX(number), 0) + 1 AS n FROM issues WHERE workspace_id = ?').get(ws).n;
    db.prepare(
      `INSERT INTO pages (id, parent_id, title, icon, content, content_text, position, workspace_id, kind)
       VALUES (?, NULL, ?, ?, ?, ?, 0, ?, 'issue')`
    ).run(id, title, str(b.icon, 8) || TYPE_ICONS[fields.type], content, text, ws);
    db.prepare(
      `INSERT INTO issues (page_id, workspace_id, number, type, status, priority, assignee, due_date, milestone, closed_at, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      id,
      ws,
      number,
      fields.type,
      fields.status,
      fields.priority,
      fields.assignee ?? null,
      fields.due_date ?? null,
      fields.milestone ?? null,
      OPEN_STATUSES.has(fields.status) ? null : new Date().toISOString().slice(0, 19).replace('T', ' '),
      by
    );
    addEvent(id, by, 'created', { type: fields.type, status: fields.status, priority: fields.priority });
    for (const l of links) addLink(id, l?.type, l?.target ?? l?.target_id, ws, by);
    if (idea) addLink(id, 'origin', idea.id, ws, by);
    if (Array.isArray(b.tags) && b.tags.length) setPageTags(id, ws, b.tags);
    return number;
  })();
  indexIssue(id);
  logActivity(id);
  if (idea && onIdeaOutcome) onIdeaOutcome(idea.id, { type: 'issue', page_id: id, label: `${prefixOf(ws)}-${created}` });
  return issueDetail(id);
}

export function updateIssue(req, pageId, b) {
  const by = actorOf(req);
  const cur = issueRow.get(pageId);
  if (!cur) throw new IssueError('Esta página no es un elemento de seguimiento', 404);
  const fields = cleanFields(b || {}, { partial: true });
  const comment = typeof b?.comment === 'string' && b.comment.trim() ? b.comment.trim().slice(0, 20000) : null;
  const title = b?.title !== undefined ? str(b.title, 300) : undefined;
  if (b?.title !== undefined && !title) throw new IssueError('El título no puede quedar vacío');
  const changes = Object.entries(fields).filter(([k, v]) => (cur[k] ?? null) !== (v ?? null));
  db.transaction(() => {
    for (const [k, v] of changes) {
      addEvent(pageId, by, 'change', { field: k, from: cur[k] ?? null, to: v ?? null });
      db.prepare(`UPDATE issues SET ${k} = ? WHERE page_id = ?`).run(v ?? null, pageId);
    }
    const st = fields.status;
    if (st && st !== cur.status) {
      db.prepare('UPDATE issues SET closed_at = ? WHERE page_id = ?').run(
        OPEN_STATUSES.has(st) ? null : new Date().toISOString().slice(0, 19).replace('T', ' '),
        pageId
      );
    }
    if (title !== undefined) {
      const old = db.prepare('SELECT title FROM pages WHERE id = ?').get(pageId).title;
      if (old !== title) {
        addEvent(pageId, by, 'change', { field: 'title', from: old, to: title });
        db.prepare('UPDATE pages SET title = ? WHERE id = ?').run(title, pageId);
      }
    }
    // El icono sigue al tipo si no se había personalizado
    if (fields.type && fields.type !== cur.type) {
      const icon = db.prepare('SELECT icon FROM pages WHERE id = ?').get(pageId).icon;
      if (!icon || icon === TYPE_ICONS[cur.type]) db.prepare('UPDATE pages SET icon = ? WHERE id = ?').run(TYPE_ICONS[fields.type], pageId);
    }
    if (comment) addEvent(pageId, by, 'comment', null, comment);
    if (changes.length || comment || title !== undefined) {
      db.prepare(`UPDATE pages SET updated_at = datetime('now') WHERE id = ?`).run(pageId);
    }
  })();
  if (title !== undefined) indexIssue(pageId);
  if (changes.length || comment) logActivity(pageId);
  return issueDetail(pageId);
}

export function linkIssue(req, pageId, type, target) {
  if (!issueRow.get(pageId)) throw new IssueError('Esta página no es un elemento de seguimiento', 404);
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

// ---------- Markdown (read_page de Claude, compartir, exportar) ----------

const fmtDate = (s) => (s ? s.slice(0, 16).replace('T', ' ') : '');

export function issueHeaderMarkdown(d) {
  const lines = [
    `**${d.key}** · ${TYPE_LABELS[d.type]} · estado: **${STATUS_LABELS[d.status]}** · prioridad: ${PRIORITY_LABELS[d.priority]}` +
      (d.assignee ? ` · responsable: ${d.assignee}` : '') +
      (d.due_date ? ` · fecha límite: ${d.due_date}` : '') +
      (d.milestone ? ` · hito: ${d.milestone}` : ''),
  ];
  if (d.blocked_by_open) lines.push(`⛔ Bloqueado por ${d.blocked_by_open} elemento(s) abiertos`);
  return lines.join('\n');
}

export function issueRelationsMarkdown(d) {
  const name = (t) => `${t.key ? `${t.key} ` : ''}«${t.title || 'Sin título'}»${t.status ? ` [${STATUS_LABELS[t.status]}]` : ''} (/p/${t.id})`;
  const lines = [];
  for (const l of d.links) lines.push(`- ${LINK_LABELS[l.type]}: ${name(l.target)} (relación ${l.id})`);
  for (const l of d.incoming) lines.push(`- ${LINK_INVERSE[l.type]}: ${name(l.source)} (relación ${l.id})`);
  for (const m of d.mentions) lines.push(`- Mencionado en: ${name(m)}`);
  return lines.length ? lines.join('\n') : '_(sin relaciones)_';
}

export function issueTimelineMarkdown(d) {
  const val = (f, v) =>
    v == null ? '—' : f === 'status' ? STATUS_LABELS[v] : f === 'type' ? TYPE_LABELS[v] : f === 'priority' ? PRIORITY_LABELS[v] : v;
  const fieldName = { status: 'estado', type: 'tipo', priority: 'prioridad', assignee: 'responsable', due_date: 'fecha límite', milestone: 'hito', title: 'título' };
  return d.events
    .map((e) => {
      const head = `- ${fmtDate(e.at)} · ${e.by || '?'}: `;
      if (e.kind === 'created') return head + 'creó el elemento';
      if (e.kind === 'change') return head + `${fieldName[e.data.field] || e.data.field}: ${val(e.data.field, e.data.from)} → ${val(e.data.field, e.data.to)}`;
      if (e.kind === 'link') return head + `${LINK_LABELS[e.data.type]} «${e.data.title || e.data.target_id}»`;
      if (e.kind === 'unlink') return head + `quitó «${LINK_LABELS[e.data.type]}» «${e.data.title || e.data.target_id}»`;
      if (e.kind === 'comment') return head + 'comentó:\n' + e.text.split('\n').map((l) => '    ' + l).join('\n');
      return head + e.kind;
    })
    .join('\n');
}

// ---------- Rutas ----------

export function mountIssues(app, { notifyTree, notifyPage, onIdeaOutcome }) {
  const send = (res, fn) => {
    try {
      res.json(fn());
    } catch (e) {
      if (e instanceof IssueError) return res.status(e.status).json({ error: e.message });
      console.error('issues:', e);
      res.status(500).json({ error: 'Error en el seguimiento' });
    }
  };

  app.get('/api/issues', (req, res) => send(res, () => listIssues(req.ws, req.query)));
  app.get('/api/issues-index', (req, res) => send(res, () => issueIndex(req.ws)));

  app.post('/api/issues', async (req, res) => {
    try {
      const d = await createIssue(req, req.body || {}, { onIdeaOutcome: (ideaId, o) => onIdeaOutcome(req, ideaId, o) });
      notifyTree(req);
      res.json(d);
    } catch (e) {
      if (e instanceof IssueError) return res.status(e.status).json({ error: e.message });
      console.error('issues:', e);
      if (!res.headersSent) res.status(500).json({ error: 'No se pudo crear el elemento' });
    }
  });

  app.get('/api/pages/:id/issue', (req, res) =>
    send(res, () => {
      const d = issueDetail(req.params.id);
      if (!d) throw new IssueError('Esta página no es un elemento de seguimiento', 404);
      return d;
    })
  );

  app.patch('/api/pages/:id/issue', (req, res) =>
    send(res, () => {
      const d = updateIssue(req, req.params.id, req.body || {});
      notifyPage(req, req.params.id);
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

  // Elementos relacionados con cualquier página (panel bajo el documento)
  app.get('/api/pages/:id/issues', (req, res) => send(res, () => issuesForPage(req.params.id, req.ws)));
}
