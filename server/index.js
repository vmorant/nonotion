import express from 'express';
import path from 'path';
import fs from 'fs';
import os from 'os';
import crypto from 'crypto';
import multer from 'multer';
import { nanoid } from 'nanoid';
import { fileURLToPath } from 'url';
import { spawnSync, execFile } from 'child_process';
import { Worker } from 'worker_threads';
import db, { DATA_DIR, FILES_DIR, ftsUpsert, ftsDelete, extractText, logActivity } from './db.js';
import { docToMarkdown, markdownToDoc, appendMarkdown, replaceInDoc, EditError } from './markdown.js';
import { mountMcp, getOrCreateToken } from './mcp.js';
import { setupAuth, purgeExpiredSessions, clientIp, rateLimited } from './auth.js';
import { mountTags, tagsOf, setPageTags, copyTags, pagesWithTags, TAGS_COLUMN, splitTags, lowercaseTags } from './tags.js';
import { workspaceGuard, mountWorkspaces, pageInWs, liveParentInWs, adoptLegacyToken, loginOf, lookupToken, roleIn } from './workspaces.js';
import { movePages, MoveError, describeMove } from './pageMove.js';
import {
  EMPTY_CANVAS,
  CanvasError,
  normalizeCanvas,
  canvasText,
  canvasToMarkdown,
  linkedPageIds,
  pageIdOfFile,
  fileIdOfFile,
} from './canvas.js';
import {
  IdeaError,
  parseIdea,
  normalizeIdea,
  patchIdea,
  ideaText,
  ideaToMarkdown,
  ideaLinkedPageIds,
  ideaTitleFrom,
  ideaDigest,
} from './idea.js';

import {
  mountIssues,
  issueDetail,
  issueHeaderMarkdown,
  issueRelationsMarkdown,
  issueTimelineMarkdown,
  trackerDetail,
  trackerConfigMarkdown,
  trackerTableMarkdown,
  valueLabel,
  calendarIssueDates,
} from './issues.js';

import { mountMinutes, minutesDetail, minutesHeaderMarkdown, minutesItemsMarkdown } from './minutes.js';

// Páginas a las que apunta un contenido, sea documento, canvas o idea
const pageLinks = (content) => (parseIdea(content) ? ideaLinkedPageIds(content) : linkedPageIds(content));

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3000;
const TRASH_RETENTION_DAYS = 30;
const VERSION_THROTTLE_MINUTES = 10;
const MAX_VERSIONS_PER_PAGE = 50;

// Un error inesperado en una petición no debe tumbar el servicio entero
process.on('unhandledRejection', (e) => console.error('Error no capturado:', e));

const app = express();
app.disable('x-powered-by');
// /API/... o /Files/... no deben llegar a las rutas /api/... saltándose el
// control de espacios (que compara la ruta tal cual): rutas sensibles a mayúsculas
app.set('case sensitive routing', true);

// Etiquetas siempre en minúsculas (migra y fusiona las antiguas; idempotente)
lowercaseTags();

// Login con GitHub + tokens de API. Va antes que cualquier ruta.
adoptLegacyToken(getOrCreateToken());
const authCfg = setupAuth(app);
// El cuerpo JSON se lee solo DESPUÉS de autenticar, y nunca en peticiones sin
// sesión ni token (las rutas públicas como /share/ no lo necesitan): antes,
// cualquiera desde internet podía mandar cuerpos comprimidos que se inflaban a
// 100 MB en memoria y tumbar el servidor.
// El MCP es público por ruta pero exige un token válido en la URL.
app.use('/mcp/:token', (req, res, next) => {
  if (lookupToken(req.params.token)) return next();
  if (rateLimited(`badtoken:${clientIp(req)}`, 30, 10 * 60_000)) {
    return res.status(429).json({ jsonrpc: '2.0', error: { code: -32029, message: 'Demasiados intentos' }, id: null });
  }
  res.status(401).json({ jsonrpc: '2.0', error: { code: -32001, message: 'Token MCP inválido' }, id: null });
});
// La página más grande ronda unos cientos de KB: 20 MB deja mucho margen (30 MB
// en el MCP, que puede traer un adjunto en base64)
// Claves __proto__ fuera de todo JSON que entra: un contenido con atributos
// "__proto__" podía convertirse en atributos HTML ejecutables al pintarlo
// (GHSA-cp6q-959q-f8rh, Tiptap 2)
const dropProtoKeys = (key, value) => (key === '__proto__' ? undefined : value);
const jsonBody = express.json({ limit: '20mb', reviver: dropProtoKeys });
const mcpJsonBody = express.json({ limit: '30mb', reviver: dropProtoKeys });
app.use((req, res, next) => {
  if (req.path.startsWith('/mcp/')) return mcpJsonBody(req, res, next);
  if (!req.user && authCfg.mode !== 'off') return next();
  jsonBody(req, res, next);
});
// Espacios: cada petición queda limitada a los espacios de su usuario/token
app.use(workspaceGuard);

app.get('/api/health', (req, res) => res.json({ ok: true }));

// Subida directa (scripts): la app usa la subida por trozos, sin límite práctico
const upload = multer({
  storage: multer.diskStorage({
    destination: FILES_DIR,
    filename: (req, file, cb) => cb(null, nanoid(21)),
  }),
  limits: { fileSize: 2 * 1024 ** 3, files: 1, fields: 20 },
});

// Espacio libre en el disco de datos: una subida no puede llenarlo (se dejan
// 1 GB libres para la base de datos, sus copias y las vistas previas)
const DISK_RESERVE = 1024 ** 3;
function diskFree() {
  try {
    const st = fs.statfsSync(FILES_DIR);
    return st.bavail * st.bsize;
  } catch {
    return Infinity;
  }
}

// ---------- Sincronización en vivo (Server-Sent Events) ----------
// Cada navegador abre /api/events; cuando algo cambia, le avisamos para que se
// actualice sin recargar. El cambio lo puede provocar otra persona o el MCP.

const sseClients = new Set(); // { res, client, ws }

// Solo a los navegadores que están en ese espacio (ws null: aviso para todos, sin datos)
function broadcast(event, originId, ws) {
  const data = `data: ${JSON.stringify(event)}\n\n`;
  for (const c of sseClients) {
    if (ws && c.ws !== ws) continue;
    // Quien ha perdido el acceso (miembro quitado, token revocado) deja de recibir avisos
    if (c.ws && !c.allowed()) {
      sseClients.delete(c);
      try {
        c.res.end();
      } catch {}
      continue;
    }
    if (originId && c.client === originId) continue; // no devolver al autor su propio cambio
    try {
      c.res.write(data);
    } catch {}
  }
}

const notifyTree = (req) => req.ws && broadcast({ type: 'tree' }, req.headers['x-client-id'], req.ws);
const notifyPage = (req, id) => req.ws && broadcast({ type: 'page', id }, req.headers['x-client-id'], req.ws);
const notifyAll = () => broadcast({ type: 'workspaces' }, null, null);

function subtreeIds(rootId) {
  return db
    .prepare(
      `WITH RECURSIVE sub(id) AS (
         SELECT id FROM pages WHERE id = ?
         UNION ALL
         SELECT p.id FROM pages p JOIN sub s ON p.parent_id = s.id
       ) SELECT id FROM sub`
    )
    .all(rootId)
    .map((r) => r.id);
}


function permanentDelete(pageId) {
  // Red de seguridad: si alguna subpágina sigue viva (creada bajo un padre ya en
  // la papelera), se rescata a la raíz antes de borrar; la cascada no la toca
  const live = db
    .prepare(
      `WITH RECURSIVE sub(id) AS (SELECT id FROM pages WHERE parent_id = ? UNION ALL SELECT p.id FROM pages p JOIN sub s ON p.parent_id = s.id)
       SELECT p.id, p.parent_id FROM pages p JOIN sub ON sub.id = p.id WHERE p.trashed_at IS NULL`
    )
    .all(pageId);
  const liveIds = new Set(live.map((r) => r.id));
  for (const r of live) {
    // un ticket rescatado sin su lista pasa a ser una página normal (no se pierde)
    if (!liveIds.has(r.parent_id)) {
      db.prepare(`UPDATE pages SET parent_id = NULL, kind = CASE WHEN kind = 'issue' THEN 'doc' ELSE kind END WHERE id = ?`).run(r.id);
    }
  }
  const subtree = subtreeIds(pageId);
  const placeholders = subtree.map(() => '?').join(',');
  const fileRows = db.prepare(`SELECT id FROM files WHERE page_id IN (${placeholders})`).all(...subtree);
  for (const f of fileRows) {
    try {
      fs.unlinkSync(path.join(FILES_DIR, f.id));
    } catch {}
    clearPreviews(f.id);
  }
  db.prepare('DELETE FROM pages WHERE id = ?').run(pageId); // cascada borra hijos, files y versions
  for (const id of subtree) ftsDelete(id);
  return subtree.length;
}

// ---------- Sincronización en vivo ----------

app.get('/api/events', (req, res) => {
  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders?.();
  res.write('retry: 3000\n\n');
  const bearer = (req.headers.authorization || '').startsWith('Bearer ') ? req.headers.authorization.slice(7).trim() : null;
  const entry = {
    res,
    client: req.query.client || null,
    ws: req.ws,
    allowed: () => (bearer && !lookupToken(bearer) ? false : Boolean(roleIn(req, req.ws))),
  };
  sseClients.add(entry);
  const keepalive = setInterval(() => {
    try {
      res.write(': ping\n\n');
    } catch {}
  }, 25000);
  req.on('close', () => {
    clearInterval(keepalive);
    sseClients.delete(entry);
  });
});

// ---------- Identidad ----------

app.get('/api/me', (req, res) => {
  res.json({
    email: req.headers['cf-access-authenticated-user-email'] || null,
    auth: authCfg.mode,
    user: req.authKind === 'session' ? req.user : null,
  });
});

mountWorkspaces(app, { notifyAll });

// ---------- Páginas ----------

app.get('/api/pages', (req, res) => {
  const rows = db
    .prepare(
      `SELECT id, parent_id, title, icon, position, updated_at, created_at, page_date, kind,
              share_token IS NOT NULL AS shared, full_width, ${TAGS_COLUMN},
              (SELECT created_at FROM favorites f WHERE f.page_id = pages.id AND f.github_login = ?) AS favorite_at,
              (SELECT t.prefix || '-' || i.number FROM issues i JOIN trackers t ON t.page_id = i.tracker_id WHERE i.page_id = pages.id) AS issue_key,
              (SELECT i.status FROM issues i WHERE i.page_id = pages.id) AS issue_status_id
       FROM pages WHERE trashed_at IS NULL AND workspace_id = ? ORDER BY position, created_at`
    )
    .all(loginOf(req) || '', req.ws);
  // Categoría del estado de cada ticket (pendiente, en curso, bloqueado, hecho)
  const cats = new Map();
  for (const t of db.prepare('SELECT page_id, config FROM trackers WHERE workspace_id = ?').all(req.ws)) {
    for (const s of JSON.parse(t.config).statuses) cats.set(`${t.page_id}:${s.id}`, s.category);
  }
  res.json(
    rows.map(({ issue_status_id, ...r }) => ({
      ...r,
      tags: splitTags(r.tags),
      ...(r.kind === 'issue' ? { issue_status: cats.get(`${r.parent_id}:${issue_status_id}`) || 'todo' } : {}),
    }))
  );
});

const validDate = (v) => (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null);

app.post('/api/pages', (req, res) => {
  const { parent_id = null, title = '', icon = '', content = null, page_date = null } = req.body || {};
  const kind = ['canvas', 'idea'].includes(req.body?.kind) ? req.body.kind : 'doc';
  if (parent_id && !liveParentInWs(parent_id, req.ws)) {
    return res.status(400).json({ error: 'Padre inexistente, en la papelera o que es una idea' });
  }
  if (kind === 'idea' && parent_id) return res.status(400).json({ error: 'Las ideas viven fuera del árbol: no llevan padre' });
  // Canvas: JSON Canvas validado (vacío si no se da); documento: content opcional
  // como string = markdown crudo (mismo mecanismo que /api/capture)
  let raw = typeof content === 'string' ? content : '';
  let text = raw;
  let pageTitle = typeof title === 'string' ? title : '';
  let pageIcon = typeof icon === 'string' ? icon : '';
  if (kind === 'idea') {
    try {
      const c = normalizeIdea(content);
      for (const sd of c.seeds) {
        if (sd.page_id && !pageInWs(sd.page_id, req.ws)) throw new IdeaError(`La página ${sd.page_id} no existe en este espacio`);
        if (sd.file_id && !fileInWs(sd.file_id, req.ws)) throw new IdeaError(`El archivo ${sd.file_id} no existe en este espacio`);
      }
      raw = JSON.stringify(c);
      text = ideaText(c);
      if (!pageTitle.trim()) pageTitle = ideaTitleFrom(c.summary || c.seeds.find((x) => x.text)?.text, 'Idea');
      if (!pageIcon) pageIcon = '💡';
    } catch (e) {
      if (e instanceof IdeaError) return res.status(400).json({ error: e.message });
      throw e;
    }
  }
  if (kind === 'canvas') {
    try {
      const c = content ? normalizeCanvas(content) : EMPTY_CANVAS;
      raw = JSON.stringify(c);
      text = canvasText(c);
    } catch (e) {
      if (e instanceof CanvasError) return res.status(400).json({ error: e.message });
      throw e;
    }
  }
  const id = nanoid(12);
  const pos = db
    .prepare('SELECT COALESCE(MAX(position) + 1, 0) AS p FROM pages WHERE parent_id IS ? AND workspace_id = ?')
    .get(parent_id, req.ws).p;
  db.prepare(
    'INSERT INTO pages (id, parent_id, title, icon, content, content_text, position, page_date, workspace_id, kind) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
  ).run(id, parent_id, pageTitle, pageIcon, raw, text, pos, validDate(page_date), req.ws, kind);
  ftsUpsert(id, pageTitle, text);
  notifyTree(req);
  res.json(db.prepare('SELECT * FROM pages WHERE id = ?').get(id));
});

app.get('/api/pages/:id', (req, res) => {
  const page = db.prepare('SELECT * FROM pages WHERE id = ?').get(req.params.id);
  if (!page) return res.status(404).json({ error: 'Página no encontrada' });
  page.files = db
    .prepare('SELECT id, name, mime, size, created_at FROM files WHERE page_id = ? AND deleted_at IS NULL ORDER BY created_at')
    .all(page.id);
  page.tags = tagsOf(page.id);
  // favorita de quien pregunta (la columna antigua de pages ya no se usa)
  page.favorite_at =
    db.prepare('SELECT created_at FROM favorites WHERE github_login = ? AND page_id = ?').get(loginOf(req) || '', page.id)
      ?.created_at ?? null;
  res.json(page);
});

// Páginas que enlazan a esta (enlaces internos /p/<id>)
app.get('/api/pages/:id/backlinks', (req, res) => {
  if (!/^[A-Za-z0-9_-]+$/.test(req.params.id)) return res.json([]);
  // instr es solo un prefiltro: el enlace real lo decide pageLinks (documentos,
  // canvas e ideas, que guardan los ids sin el prefijo /p/)
  const rows = db
    .prepare(
      `SELECT id, title, icon, kind, content FROM pages
       WHERE trashed_at IS NULL AND workspace_id = ? AND id != ? AND instr(content, ?) > 0
       ORDER BY updated_at DESC LIMIT 400`
    )
    .all(req.ws, req.params.id, req.params.id)
    .filter((p) => pageLinks(p.content).has(req.params.id))
    .slice(0, 100)
    .map(({ content, ...p }) => p);
  res.json(rows);
});

// Grafo del espacio: páginas, enlaces internos entre ellas (también desde
// tarjetas de canvas), etiquetas y adjuntos. El cliente filtra y dibuja.
app.get('/api/graph', (req, res) => {
  const pages = db
    .prepare(
      `SELECT id, parent_id, title, icon, kind, created_at, updated_at, content, ${TAGS_COLUMN}
       FROM pages WHERE trashed_at IS NULL AND workspace_id = ?`
    )
    .all(req.ws);
  const alive = new Set(pages.map((p) => p.id));
  const links = [];
  for (const p of pages) {
    for (const target of pageLinks(p.content)) {
      if (target !== p.id && alive.has(target)) links.push({ source: p.id, target });
    }
  }
  // Relaciones de seguimiento (bloquea, documentado en…) con su tipo
  for (const l of db
    .prepare(`SELECT l.issue_id, l.target_id, l.type FROM issue_links l JOIN pages p ON p.id = l.issue_id WHERE p.workspace_id = ?`)
    .all(req.ws)) {
    if (alive.has(l.issue_id) && alive.has(l.target_id)) links.push({ source: l.issue_id, target: l.target_id, rel: l.type });
  }
  const trackerCfg = new Map(
    db.prepare('SELECT page_id, prefix, config FROM trackers WHERE workspace_id = ?').all(req.ws).map((t) => [t.page_id, { prefix: t.prefix, config: JSON.parse(t.config) }])
  );
  const issueInfo = new Map(
    db
      .prepare(`SELECT page_id, tracker_id, number, status FROM issues WHERE workspace_id = ?`)
      .all(req.ws)
      .map((r) => {
        const t = trackerCfg.get(r.tracker_id);
        const s = t?.config.statuses.find((x) => x.id === r.status) || t?.config.statuses[0];
        return [r.page_id, { key: t ? `${t.prefix}-${r.number}` : null, status: s?.category || 'todo' }];
      })
  );
  const files = db
    .prepare(
      `SELECT f.id, f.name, f.mime, f.page_id, f.created_at FROM files f JOIN pages p ON p.id = f.page_id
       WHERE f.deleted_at IS NULL AND f.workspace_id = ? AND p.trashed_at IS NULL`
    )
    .all(req.ws);
  res.json({
    pages: pages.map(({ content, tags, ...p }) => ({ ...p, tags: splitTags(tags), ...(issueInfo.get(p.id) || {}) })),
    links,
    files,
  });
});

mountTags(app, { notifyTree });

// Una idea que se convierte en elemento de seguimiento lo registra como resultado
function addIdeaOutcome(req, ideaId, outcome) {
  const page = db.prepare('SELECT * FROM pages WHERE id = ?').get(ideaId);
  if (!page || page.kind !== 'idea') return;
  const idea = patchIdea(page.content, { outcomes_add: [outcome] });
  const text = ideaText(idea);
  snapshotVersion(page, { throttled: false });
  db.prepare(`UPDATE pages SET content = ?, content_text = ?, rev = rev + 1, updated_at = datetime('now') WHERE id = ?`).run(
    JSON.stringify(idea),
    text,
    page.id
  );
  ftsUpsert(page.id, page.title, text);
  notifyPage(req, page.id);
}
mountIssues(app, { notifyTree, notifyPage, onIdeaOutcome: addIdeaOutcome });

function snapshotVersion(page, { throttled }) {
  if (throttled) {
    const recent = db
      .prepare(
        `SELECT 1 FROM versions WHERE page_id = ? AND created_at > datetime('now', ?) LIMIT 1`
      )
      .get(page.id, `-${VERSION_THROTTLE_MINUTES} minutes`);
    if (recent) return;
  }
  db.prepare('INSERT INTO versions (page_id, title, content) VALUES (?, ?, ?)').run(
    page.id,
    page.title,
    page.content
  );
  db.prepare(
    `DELETE FROM versions WHERE page_id = ? AND id NOT IN (
       SELECT id FROM versions WHERE page_id = ? ORDER BY id DESC LIMIT ?
     )`
  ).run(page.id, page.id, MAX_VERSIONS_PER_PAGE);
}

app.put('/api/pages/:id', (req, res) => {
  const page = db.prepare('SELECT * FROM pages WHERE id = ?').get(req.params.id);
  if (!page) return res.status(404).json({ error: 'Página no encontrada' });

  const b = req.body || {};
  const fields = {};
  if (typeof b.title === 'string') fields.title = b.title;
  if (typeof b.icon === 'string') fields.icon = b.icon;
  if (b.content !== undefined) fields.content = typeof b.content === 'string' ? b.content : JSON.stringify(b.content);
  if (typeof b.content_text === 'string') fields.content_text = b.content_text;
  // Un canvas solo admite JSON Canvas válido; su texto buscable lo calcula el servidor
  if (page.kind === 'canvas' && fields.content !== undefined) {
    try {
      const c = normalizeCanvas(fields.content);
      fields.content = JSON.stringify(c);
      fields.content_text = canvasText(c);
    } catch (e) {
      if (e instanceof CanvasError) return res.status(400).json({ error: `Esta página es un canvas: ${e.message}` });
      throw e;
    }
  }
  // Una idea solo admite su JSON (la interfaz y el MCP usan /idea para parches)
  if (page.kind === 'idea' && fields.content !== undefined) {
    try {
      const c = normalizeIdea(fields.content);
      fields.content = JSON.stringify(c);
      fields.content_text = ideaText(c);
    } catch (e) {
      if (e instanceof IdeaError) return res.status(400).json({ error: `Esta página es una idea: ${e.message}` });
      throw e;
    }
  }
  if (typeof b.position === 'number') fields.position = b.position;
  if (b.page_date !== undefined) {
    if (b.page_date && !validDate(b.page_date)) return res.status(400).json({ error: 'page_date debe ser AAAA-MM-DD' });
    fields.page_date = validDate(b.page_date);
  }
  // Cambiar de padre pasa por la misma función que el resto de movimientos
  let moved = false;
  if (b.parent_id !== undefined) {
    if (!sendMove(req, res, [{ page_id: page.id, parent_id: b.parent_id }])) return;
    moved = true;
  }

  if (Object.keys(fields).length === 0) {
    return res.json(moved ? db.prepare('SELECT * FROM pages WHERE id = ?').get(page.id) : page);
  }

  // Nada se pierde al sobrescribir el contenido:
  //  - si el cliente partía de una revisión antigua (otro dispositivo o Claude
  //    cambió la página entre medias), guardamos SIEMPRE la versión actual;
  //  - las escrituras sin X-Client-Id (MCP, CLI) también guardan siempre;
  //  - las del editor normal, como mucho una versión cada 10 minutos.
  let conflict = false;
  if (fields.content !== undefined && fields.content !== page.content && page.content) {
    const baseRev = typeof b.base_rev === 'number' ? b.base_rev : null;
    conflict = baseRev !== null && baseRev !== page.rev;
    const external = !req.headers['x-client-id'];
    snapshotVersion(page, { throttled: !conflict && !external });
  }

  const sets = Object.keys(fields).map((k) => `${k} = ?`).join(', ');
  db.prepare(`UPDATE pages SET ${sets}, rev = rev + 1, updated_at = datetime('now') WHERE id = ?`).run(
    ...Object.values(fields),
    page.id
  );

  const updated = db.prepare('SELECT * FROM pages WHERE id = ?').get(page.id);
  if (fields.title !== undefined || fields.content_text !== undefined) {
    ftsUpsert(page.id, updated.title, updated.content_text);
  }
  if (fields.content !== undefined || fields.title !== undefined) {
    logActivity(page.id);
  }
  notifyPage(req, page.id);
  if (fields.title !== undefined || fields.icon !== undefined || fields.page_date !== undefined) {
    notifyTree(req);
  }
  res.json({ ...updated, conflict });
});

// Preferencias de visualización (favorita, ancho completo): no son ediciones,
// así que no cambian la revisión, la fecha de modificación ni el historial
app.post('/api/pages/:id/prefs', (req, res) => {
  const page = db.prepare('SELECT id FROM pages WHERE id = ?').get(req.params.id);
  if (!page) return res.status(404).json({ error: 'Página no encontrada' });
  const b = req.body || {};
  // Favorita: de cada persona
  const login = loginOf(req);
  if (typeof b.favorite === 'boolean' && login) {
    if (b.favorite) db.prepare('INSERT OR IGNORE INTO favorites (github_login, page_id) VALUES (?, ?)').run(login, page.id);
    else db.prepare('DELETE FROM favorites WHERE github_login = ? AND page_id = ?').run(login, page.id);
  }
  if (typeof b.full_width === 'boolean') {
    db.prepare('UPDATE pages SET full_width = ? WHERE id = ?').run(b.full_width ? 1 : 0, page.id);
  }
  notifyTree(req);
  res.json({
    ...db.prepare('SELECT id, full_width FROM pages WHERE id = ?').get(page.id),
    favorite_at: db.prepare('SELECT created_at FROM favorites WHERE github_login = ? AND page_id = ?').get(login || '', page.id)
      ?.created_at ?? null,
  });
});

// Mover en el árbol (interfaz y MCP comparten pageMove.js). Cuerpo:
// { parent_id (null = raíz), index? | before_id? | after_id? }; sin posición, al final
const moveFromBody = (pageId, b = {}) => ({
  page_id: pageId,
  parent_id: Object.prototype.hasOwnProperty.call(b, 'parent_id') ? b.parent_id : undefined,
  index: b.index,
  before_id: b.before_id,
  after_id: b.after_id,
});

function sendMove(req, res, moves) {
  try {
    const results = movePages(req.ws, moves);
    if (results.some((r) => !r.noop)) notifyTree(req);
    return results;
  } catch (e) {
    if (e instanceof MoveError) res.status(e.status).json({ error: e.message });
    else {
      console.error('Error al mover páginas:', e);
      res.status(500).json({ error: 'Error interno al mover' });
    }
    return null;
  }
}

app.post('/api/pages/:id/move', (req, res) => {
  const results = sendMove(req, res, [moveFromBody(req.params.id, req.body)]);
  if (results) res.json({ ok: true, ...results[0], message: describeMove(results[0]) });
});

// Varios movimientos atómicos: si uno no es válido, no se aplica ninguno
app.post('/api/move-pages', (req, res) => {
  const list = Array.isArray(req.body?.moves) ? req.body.moves : null;
  if (!list || !list.length) return res.status(400).json({ error: 'Falta la lista "moves"' });
  if (list.length > 500) return res.status(400).json({ error: 'Máximo 500 movimientos por llamada' });
  const results = sendMove(req, res, list.map((m) => moveFromBody(m?.page_id, m)));
  if (results) res.json({ ok: true, results: results.map((r) => ({ ...r, message: describeMove(r) })) });
});

// Duplicar página (subárbol completo, con copia física de archivos)
app.post('/api/pages/:id/duplicate', (req, res) => {
  const orig = db.prepare('SELECT * FROM pages WHERE id = ?').get(req.params.id);
  if (!orig) return res.status(404).json({ error: 'Página no encontrada' });
  if (orig.kind === 'issue') return res.status(400).json({ error: 'Un ticket no se duplica: crea uno nuevo y relaciónalo' });
  if (orig.kind === 'tracker') return res.status(400).json({ error: 'Una lista de seguimiento no se duplica: crea una nueva con la misma plantilla' });
  if (orig.kind === 'minutes') return res.status(400).json({ error: 'Un acta no se duplica: crea una nueva' });

  const insertPage = db.prepare(
    `INSERT INTO pages (id, parent_id, title, icon, content, content_text, position, workspace_id, kind)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  const insertFile = db.prepare('INSERT INTO files (id, page_id, name, mime, size, workspace_id) VALUES (?, ?, ?, ?, ?, ?)');

  const clone = (srcId, newParentId, titleOverride, position) => {
    const src = db.prepare('SELECT * FROM pages WHERE id = ?').get(srcId);
    const newId = nanoid(12);
    insertPage.run(
      newId,
      newParentId,
      titleOverride ?? src.title,
      src.icon,
      src.content,
      src.content_text,
      position ?? src.position,
      src.workspace_id,
      src.kind || 'doc'
    );
    let content = src.content;
    const files = db.prepare('SELECT * FROM files WHERE page_id = ? AND deleted_at IS NULL').all(srcId);
    for (const f of files) {
      const newFileId = nanoid(21);
      try {
        fs.copyFileSync(path.join(FILES_DIR, f.id), path.join(FILES_DIR, newFileId));
      } catch {
        continue;
      }
      insertFile.run(newFileId, newId, f.name, f.mime, f.size, src.workspace_id);
      content = content.split(`/files/${f.id}/`).join(`/files/${newFileId}/`);
    }
    if (content !== src.content) {
      db.prepare('UPDATE pages SET content = ? WHERE id = ?').run(content, newId);
    }
    ftsUpsert(newId, titleOverride ?? src.title, src.content_text);
    copyTags(srcId, newId);
    const children = db
      .prepare('SELECT id FROM pages WHERE parent_id = ? AND trashed_at IS NULL ORDER BY position, created_at')
      .all(srcId);
    for (const c of children) clone(c.id, newId, null, null);
    return newId;
  };

  const newId = db.transaction(() =>
    // si el padre está en la papelera, la copia va a la raíz (si no, se borraría con él)
    clone(
      orig.id,
      orig.parent_id && liveParentInWs(orig.parent_id, orig.workspace_id) ? orig.parent_id : null,
      `Copia de ${orig.title || 'Sin título'}`,
      orig.position + 1
    )
  )();
  notifyTree(req);
  res.json(db.prepare('SELECT * FROM pages WHERE id = ?').get(newId));
});

// ---------- Papelera ----------

app.delete('/api/pages/:id', (req, res) => {
  const page = db.prepare('SELECT id FROM pages WHERE id = ?').get(req.params.id);
  if (!page) return res.status(404).json({ error: 'Página no encontrada' });
  const subtree = subtreeIds(page.id);
  const placeholders = subtree.map(() => '?').join(',');
  db.prepare(
    `UPDATE pages SET trashed_at = datetime('now') WHERE id IN (${placeholders}) AND trashed_at IS NULL`
  ).run(...subtree);
  for (const id of subtree) ftsDelete(id);
  notifyTree(req);
  notifyPage(req, page.id);
  res.json({ ok: true, trashed: subtree.length });
});

app.get('/api/trash', (req, res) => {
  const rows = db
    .prepare(
      `SELECT t.id, t.title, t.icon, t.trashed_at,
              (SELECT COUNT(*) FROM pages c WHERE c.parent_id = t.id AND c.trashed_at IS NOT NULL) AS children
       FROM pages t
       LEFT JOIN pages parent ON parent.id = t.parent_id
       WHERE t.trashed_at IS NOT NULL AND t.workspace_id = ?
         AND (t.parent_id IS NULL OR parent.id IS NULL OR parent.trashed_at IS NULL)
       ORDER BY t.trashed_at DESC`
    )
    .all(req.ws);
  res.json(rows);
});

app.post('/api/trash/:id/restore', (req, res) => {
  const page = db.prepare('SELECT * FROM pages WHERE id = ? AND trashed_at IS NOT NULL').get(req.params.id);
  if (!page) return res.status(404).json({ error: 'No está en la papelera' });
  const subtree = subtreeIds(page.id);
  const placeholders = subtree.map(() => '?').join(',');
  db.transaction(() => {
    db.prepare(`UPDATE pages SET trashed_at = NULL WHERE id IN (${placeholders})`).run(...subtree);
    // Si el padre original ya no existe o sigue en la papelera, pasa a la raíz
    if (page.parent_id) {
      const parent = db.prepare('SELECT trashed_at FROM pages WHERE id = ?').get(page.parent_id);
      if (!parent || parent.trashed_at) {
        db.prepare('UPDATE pages SET parent_id = NULL WHERE id = ?').run(page.id);
      }
    }
  })();
  const rows = db.prepare(`SELECT id, title, content_text FROM pages WHERE id IN (${placeholders})`).all(...subtree);
  for (const r of rows) ftsUpsert(r.id, r.title, r.content_text);
  notifyTree(req);
  res.json({ ok: true, restored: subtree.length });
});

// Borrar para siempre y publicar en internet: solo administradores del espacio
// (ni editores ni tokens de API/MCP)
function requireAdmin(req, res) {
  if (roleIn(req, req.ws) === 'admin') return true;
  res.status(403).json({ error: 'Solo los administradores del espacio pueden hacer esto' });
  return false;
}

app.delete('/api/trash/:id', (req, res) => {
  if (!requireAdmin(req, res)) return;
  const page = db.prepare('SELECT id FROM pages WHERE id = ? AND trashed_at IS NOT NULL').get(req.params.id);
  if (!page) return res.status(404).json({ error: 'No está en la papelera' });
  const deleted = permanentDelete(page.id);
  notifyTree(req);
  res.json({ ok: true, deleted });
});

app.delete('/api/trash', (req, res) => {
  if (!requireAdmin(req, res)) return;
  const roots = db
    .prepare(
      `SELECT t.id FROM pages t
       LEFT JOIN pages parent ON parent.id = t.parent_id
       WHERE t.trashed_at IS NOT NULL AND t.workspace_id = ?
         AND (t.parent_id IS NULL OR parent.id IS NULL OR parent.trashed_at IS NULL)`
    )
    .all(req.ws);
  let deleted = 0;
  for (const r of roots) deleted += permanentDelete(r.id);
  const deletedFiles = db.prepare('SELECT id FROM files WHERE deleted_at IS NOT NULL AND workspace_id = ?').all(req.ws);
  for (const f of deletedFiles) purgeFile(f.id);
  notifyTree(req);
  res.json({ ok: true, deleted, files: deletedFiles.length });
});

// ---------- Papelera de adjuntos ----------

function purgeFile(fileId) {
  try {
    fs.unlinkSync(path.join(FILES_DIR, fileId));
  } catch {}
  clearPreviews(fileId);
  db.prepare('DELETE FROM files WHERE id = ?').run(fileId);
}

app.get('/api/trash/files', (req, res) => {
  const rows = db
    .prepare(
      `SELECT f.id, f.name, f.mime, f.size, f.deleted_at, f.page_id, p.title AS page_title, p.icon AS page_icon
       FROM files f LEFT JOIN pages p ON p.id = f.page_id
       WHERE f.deleted_at IS NOT NULL AND f.workspace_id = ? ORDER BY f.deleted_at DESC`
    )
    .all(req.ws);
  res.json(rows);
});

app.post('/api/trash/files/:id/restore', (req, res) => {
  const f = db.prepare('SELECT * FROM files WHERE id = ? AND deleted_at IS NOT NULL').get(req.params.id);
  if (!f) return res.status(404).json({ error: 'No está en la papelera' });
  db.prepare('UPDATE files SET deleted_at = NULL WHERE id = ?').run(f.id);
  if (f.page_id) notifyPage(req, f.page_id);
  res.json({ ok: true });
});

app.delete('/api/trash/files/:id', (req, res) => {
  const f = db.prepare('SELECT * FROM files WHERE id = ? AND deleted_at IS NOT NULL').get(req.params.id);
  if (!f) return res.status(404).json({ error: 'No está en la papelera' });
  purgeFile(f.id);
  res.json({ ok: true });
});

function purgeOldTrash() {
  const roots = db
    .prepare(
      `SELECT t.id FROM pages t
       LEFT JOIN pages parent ON parent.id = t.parent_id
       WHERE t.trashed_at IS NOT NULL AND t.trashed_at < datetime('now', ?)
         AND (t.parent_id IS NULL OR parent.id IS NULL OR parent.trashed_at IS NULL)`
    )
    .all(`-${TRASH_RETENTION_DAYS} days`);
  for (const r of roots) permanentDelete(r.id);
  if (roots.length) console.log(`Papelera: purgadas ${roots.length} páginas con más de ${TRASH_RETENTION_DAYS} días`);
  const oldFiles = db
    .prepare(`SELECT id FROM files WHERE deleted_at IS NOT NULL AND deleted_at < datetime('now', ?)`)
    .all(`-${TRASH_RETENTION_DAYS} days`);
  for (const f of oldFiles) purgeFile(f.id);
  if (oldFiles.length) console.log(`Papelera: purgados ${oldFiles.length} adjuntos con más de ${TRASH_RETENTION_DAYS} días`);
  purgeStaleUploads();
}

// ---------- Historial de versiones ----------

app.get('/api/pages/:id/versions', (req, res) => {
  const rows = db
    .prepare('SELECT id, title, created_at FROM versions WHERE page_id = ? ORDER BY id DESC')
    .all(req.params.id);
  res.json(rows);
});

app.get('/api/versions/:vid', (req, res) => {
  const v = db.prepare('SELECT * FROM versions WHERE id = ?').get(req.params.vid);
  if (!v) return res.status(404).json({ error: 'Versión no encontrada' });
  res.json(v);
});

app.post('/api/pages/:id/restore-version/:vid', (req, res) => {
  const page = db.prepare('SELECT * FROM pages WHERE id = ?').get(req.params.id);
  if (!page) return res.status(404).json({ error: 'Página no encontrada' });
  const v = db.prepare('SELECT * FROM versions WHERE id = ? AND page_id = ?').get(req.params.vid, page.id);
  if (!v) return res.status(404).json({ error: 'Versión no encontrada' });

  snapshotVersion(page, { throttled: false });
  const text = extractText(v.content);
  db.prepare(
    `UPDATE pages SET title = ?, content = ?, content_text = ?, rev = rev + 1, updated_at = datetime('now') WHERE id = ?`
  ).run(v.title, v.content, text, page.id);
  ftsUpsert(page.id, v.title, text);
  logActivity(page.id);
  notifyPage(req, page.id);
  notifyTree(req);
  res.json(db.prepare('SELECT * FROM pages WHERE id = ?').get(page.id));
});

// ---------- Calendario (actividad + páginas con fecha) ----------

app.get('/api/calendar', (req, res) => {
  const from = validDate(req.query.from);
  const to = validDate(req.query.to);
  if (!from || !to) return res.status(400).json({ error: 'Parámetros from/to inválidos (YYYY-MM-DD)' });
  const dated = db
    .prepare(
      `SELECT id, title, icon, kind, page_date AS day FROM pages
       WHERE trashed_at IS NULL AND workspace_id = ? AND page_date BETWEEN ? AND ?`
    )
    .all(req.ws, from, to);
  const created = db
    .prepare(
      `SELECT id, title, icon, date(created_at, 'localtime') AS day FROM pages
       WHERE trashed_at IS NULL AND workspace_id = ? AND date(created_at, 'localtime') BETWEEN ? AND ?`
    )
    .all(req.ws, from, to);
  const edited = db
    .prepare(
      `SELECT p.id, p.title, p.icon, a.day, a.edits FROM activity a
       JOIN pages p ON p.id = a.page_id
       WHERE p.trashed_at IS NULL AND p.workspace_id = ? AND a.day BETWEEN ? AND ?
         AND a.day != date(p.created_at, 'localtime')`
    )
    .all(req.ws, from, to);
  // Fechas de los tickets (límite, inicio, evento, otra) y, si se pide, lo vencido
  const overdueBefore = req.query.overdue ? validDate(req.query.overdue) : null;
  const { items: issues, trackers } = calendarIssueDates(req.ws, from, to, { overdueBefore });
  res.json({ dated, created, edited, issues, trackers });
});

// ---------- Captura desde el PC de IA ----------

function deriveTitle(markdown) {
  const heading = markdown.match(/^#{1,6}\s+(.+)$/m);
  let title = heading ? heading[1] : (markdown.split('\n').find((l) => l.trim()) || '').trim();
  title = title.replace(/[*_`#>\[\]]/g, '').trim();
  return title.length > 80 ? title.slice(0, 77) + '…' : title || 'Captura';
}

// Cada espacio tiene su propio Inbox
function getOrCreateInbox(ws) {
  const inbox = db
    .prepare(`SELECT id FROM pages WHERE parent_id IS NULL AND title = 'Inbox' AND kind = 'doc' AND trashed_at IS NULL AND workspace_id = ?`)
    .get(ws);
  if (inbox) return inbox.id;
  const id = nanoid(12);
  db.prepare(
    `INSERT INTO pages (id, parent_id, title, icon, position, workspace_id) VALUES (?, NULL, 'Inbox', '📥', -1, ?)`
  ).run(id, ws);
  ftsUpsert(id, 'Inbox', '');
  return id;
}

// Crea una página desde Markdown. kind = 'minutes' (acta): sin padre (vive en
// su propia sección). El resto, bajo su padre o en el Inbox.
async function createMarkdownPage(req, { markdown, title, parent_id, page_date, icon, tags, kind = 'doc' }) {
  let parentId = kind === 'minutes' ? null : parent_id || null;
  if (parentId && !liveParentInWs(parentId, req.ws)) throw Object.assign(new Error('Padre inexistente'), { status: 400 });
  if (!parentId && kind !== 'minutes') parentId = getOrCreateInbox(req.ws);

  // Se guarda ya como documento (igual que si se hubiera pegado en el editor)
  let content = markdown;
  let text = markdown;
  try {
    const doc = await markdownToDoc(markdown);
    content = JSON.stringify(doc);
    text = extractText(doc);
  } catch (e) {
    console.error('Captura: no se pudo convertir el Markdown, se guarda tal cual:', e.message);
  }

  const id = nanoid(12);
  const pageTitle = (title || '').trim() || deriveTitle(markdown);
  const pos = db
    .prepare('SELECT COALESCE(MAX(position) + 1, 0) AS p FROM pages WHERE parent_id IS ?')
    .get(parentId).p;
  db.prepare(
    'INSERT INTO pages (id, parent_id, title, icon, content, content_text, position, page_date, workspace_id, kind) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
  ).run(id, parentId, pageTitle, typeof icon === 'string' && icon ? icon : '🤖', content, text, pos, validDate(page_date), req.ws, kind);
  ftsUpsert(id, pageTitle, text);
  const pageTags = Array.isArray(tags) && tags.length ? setPageTags(id, req.ws, tags) : [];
  logActivity(id);
  return { id, title: pageTitle, url: `/p/${id}`, tags: pageTags };
}

app.post('/api/capture', async (req, res) => {
  const { markdown } = req.body || {};
  if (typeof markdown !== 'string' || !markdown.trim()) {
    return res.status(400).json({ error: 'Falta el campo "markdown"' });
  }
  try {
    const r = await createMarkdownPage(req, req.body);
    notifyTree(req);
    res.json(r);
  } catch (e) {
    if (e.status === 400) return res.status(400).json({ error: e.message });
    console.error('captura:', e);
    res.status(500).json({ error: 'No se pudo crear la página' });
  }
});

// Idea nueva (desde un acta): semillas ya preparadas
function createIdeaPage(req, { title, seeds, summary = '' }) {
  const c = normalizeIdea({ type: 'idea', summary, seeds });
  const id = nanoid(12);
  const text = ideaText(c);
  const pageTitle = (title || '').trim() || ideaTitleFrom(summary || seeds?.[0]?.text, 'Idea');
  db.prepare(
    `INSERT INTO pages (id, parent_id, title, icon, content, content_text, position, workspace_id, kind) VALUES (?, NULL, ?, '💡', ?, ?, 0, ?, 'idea')`
  ).run(id, pageTitle, JSON.stringify(c), text, req.ws);
  ftsUpsert(id, pageTitle, text);
  return { id, title: pageTitle };
}

mountMinutes(app, {
  notifyTree,
  notifyPage,
  createMarkdownPage,
  createIdeaPage,
  toMarkdown: async (id) => docToMarkdown(db.prepare('SELECT content FROM pages WHERE id = ?').get(id)?.content || ''),
});

// ---------- Lectura/escritura en Markdown (usada por el MCP) ----------

app.get('/api/pages/:id/markdown', async (req, res) => {
  const page = db.prepare('SELECT * FROM pages WHERE id = ?').get(req.params.id);
  if (!page) return res.status(404).json({ error: 'Página no encontrada' });
  const isCanvas = page.kind === 'canvas';
  const isIdea = page.kind === 'idea';
  const titleOf = (pid) => db.prepare('SELECT title FROM pages WHERE id = ? AND workspace_id = ?').get(pid, page.workspace_id)?.title;
  const fileOf = (fid) => db.prepare('SELECT id, name FROM files WHERE id = ? AND workspace_id = ? AND deleted_at IS NULL').get(fid, page.workspace_id);
  let markdown;
  if (page.kind === 'tracker') {
    const d = trackerDetail(page.id);
    markdown = d ? `${trackerConfigMarkdown(d)}\n\n## Tickets\n\n${d.issues.length ? trackerTableMarkdown(d) : '_(sin tickets)_'}` : '';
  } else {
    markdown = isIdea
      ? ideaToMarkdown(page.content, { titleOf, fileOf })
      : isCanvas
        ? canvasToMarkdown(page.content, titleOf)
        : await docToMarkdown(page.content);
  }
  const files = db
    .prepare('SELECT id, name, mime, size FROM files WHERE page_id = ? AND deleted_at IS NULL ORDER BY created_at')
    .all(page.id);
  res.json({
    id: page.id,
    kind: page.kind,
    canvas: isCanvas ? JSON.parse(page.content || '{}') : undefined,
    idea: isIdea ? normalizeIdea(page.content) : undefined,
    title: page.title,
    icon: page.icon,
    page_date: page.page_date,
    parent_id: page.parent_id,
    updated_at: page.updated_at,
    trashed: !!page.trashed_at,
    tags: tagsOf(page.id),
    markdown,
    files,
  });
});

// Guarda un documento nuevo con versión previa garantizada (escrituras de
// Claude/MCP y scripts: siempre recuperables desde el historial)
function saveDocWithVersion(req, page, doc) {
  snapshotVersion(page, { throttled: Boolean(req.headers['x-client-id']) });
  const content = JSON.stringify(doc);
  const text = extractText(doc);
  db.prepare(
    `UPDATE pages SET content = ?, content_text = ?, rev = rev + 1, updated_at = datetime('now') WHERE id = ?`
  ).run(content, text, page.id);
  ftsUpsert(page.id, page.title, text);
  logActivity(page.id);
  notifyPage(req, page.id);
  return db.prepare('SELECT * FROM pages WHERE id = ?').get(page.id);
}

// Añade Markdown al final sin reescribir lo existente
const CANVAS_MD_ERROR = 'Esta página es un canvas: no admite Markdown. Usa update_canvas para cambiarla.';
const IDEA_MD_ERROR =
  'Esta página es una idea: no admite Markdown. Usa develop_idea / materialize_idea (o la vista Ideas) para cambiarla.';
const TRACKER_MD_ERROR = 'Esta página es una lista de seguimiento: añade tickets con create_issue y cambia campos con update_tracker.';
const notMarkdown = (page) =>
  page.kind === 'canvas' ? CANVAS_MD_ERROR : page.kind === 'idea' ? IDEA_MD_ERROR : page.kind === 'tracker' ? TRACKER_MD_ERROR : null;

app.post('/api/pages/:id/append', async (req, res) => {
  const page = db.prepare('SELECT * FROM pages WHERE id = ?').get(req.params.id);
  if (!page) return res.status(404).json({ error: 'Página no encontrada' });
  if (notMarkdown(page)) return res.status(400).json({ error: notMarkdown(page) });
  const { markdown } = req.body || {};
  if (typeof markdown !== 'string' || !markdown.trim()) {
    return res.status(400).json({ error: 'Falta el campo "markdown"' });
  }
  try {
    const doc = await appendMarkdown(page.content, markdown);
    res.json(saveDocWithVersion(req, page, doc));
  } catch (e) {
    console.error('append:', e);
    res.status(500).json({ error: 'No se pudo añadir el contenido' });
  }
});

// Sustituye un fragmento exacto; solo se regeneran los bloques afectados
app.post('/api/pages/:id/replace', async (req, res) => {
  const page = db.prepare('SELECT * FROM pages WHERE id = ?').get(req.params.id);
  if (!page) return res.status(404).json({ error: 'Página no encontrada' });
  if (notMarkdown(page)) return res.status(400).json({ error: notMarkdown(page) });
  const { find_text, replace_text } = req.body || {};
  if (typeof find_text !== 'string' || typeof replace_text !== 'string') {
    return res.status(400).json({ error: 'Faltan find_text y replace_text' });
  }
  try {
    const doc = await replaceInDoc(page.content, find_text, replace_text);
    res.json(saveDocWithVersion(req, page, doc));
  } catch (e) {
    if (e instanceof EditError) return res.status(e.code === 'not_found' ? 404 : 409).json({ error: e.message, code: e.code });
    console.error('replace:', e);
    res.status(500).json({ error: 'No se pudo editar la página' });
  }
});

// ---------- Archivos ----------

// Si el navegador no manda un tipo útil, lo deducimos de la extensión
const EXT_MIME = {
  '.webm': 'video/webm', '.mp4': 'video/mp4', '.mov': 'video/quicktime', '.mkv': 'video/x-matroska',
  '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.ogg': 'audio/ogg', '.opus': 'audio/opus', '.wav': 'audio/wav',
  '.pdf': 'application/pdf', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.txt': 'text/plain',
  '.md': 'text/markdown', '.csv': 'text/csv', '.json': 'application/json', '.zip': 'application/zip',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.doc': 'application/msword', '.xls': 'application/vnd.ms-excel', '.ppt': 'application/vnd.ms-powerpoint',
};

function inferMime(name, given) {
  // Solo un tipo MIME limpio («tipo/subtipo»): nada de listas ni parámetros raros
  given = typeof given === 'string' ? given.trim().toLowerCase().split(';')[0].trim() : '';
  if (!/^[a-z]+\/[a-z0-9][a-z0-9.+-]*$/.test(given)) given = '';
  if (given && given !== 'application/octet-stream') return given;
  return EXT_MIME[path.extname(name || '').toLowerCase()] || given || 'application/octet-stream';
}

app.post('/api/files', upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Falta el archivo' });
  const pageId = req.body.page_id || null;
  const f = req.file;
  // La página debe ser del espacio de la petición (multer ya guardó el archivo: se borra)
  if (pageId && !pageInWs(pageId, req.ws)) {
    try {
      fs.unlinkSync(path.join(FILES_DIR, f.filename));
    } catch {}
    return res.status(400).json({ error: 'Página inexistente' });
  }
  // multer no decodifica UTF-8 en originalname (llega como latin1)
  const name = Buffer.from(f.originalname, 'latin1').toString('utf8');
  const mime = inferMime(name, f.mimetype);
  db.prepare('INSERT INTO files (id, page_id, name, mime, size, workspace_id) VALUES (?, ?, ?, ?, ?, ?)').run(
    f.filename,
    pageId,
    name,
    mime,
    f.size,
    req.ws
  );
  if (pageId) notifyPage(req, pageId);
  res.json({
    id: f.filename,
    name,
    mime,
    size: f.size,
    url: `/files/${f.filename}/${encodeURIComponent(name)}`,
  });
});

// ---------- Subida por trozos (reanudable) ----------
// Cloudflare corta cualquier petición de más de 100 MB, así que el navegador
// sube los archivos en trozos de 8 MB. Cada trozo se escribe en la posición
// exacta (offset): si la red se cae, el cliente pregunta cuánto llegó y sigue
// desde ahí sin repetir ni perder nada.

const UPLOADS_DIR = path.join(DATA_DIR, 'uploads');
fs.mkdirSync(UPLOADS_DIR, { recursive: true });
const CHUNK_SIZE = 8 * 1024 * 1024;
const UPLOAD_RETENTION_DAYS = 7;
const uploadPartPath = (id) => path.join(UPLOADS_DIR, `${id}.part`);
const isUploadId = (id) => /^[A-Za-z0-9_-]{21}$/.test(id);

function partSize(id) {
  try {
    return fs.statSync(uploadPartPath(id)).size;
  } catch {
    return null;
  }
}

function purgeStaleUploads() {
  const stale = db
    .prepare(`SELECT id FROM uploads WHERE created_at < datetime('now', ?)`)
    .all(`-${UPLOAD_RETENTION_DAYS} days`);
  for (const u of stale) {
    try {
      fs.unlinkSync(uploadPartPath(u.id));
    } catch {}
    db.prepare('DELETE FROM uploads WHERE id = ?').run(u.id);
  }
}

app.post('/api/uploads', (req, res) => {
  const { name, size, mime, page_id } = req.body || {};
  if (typeof name !== 'string' || !name.trim()) return res.status(400).json({ error: 'Falta el nombre' });
  if (!Number.isSafeInteger(size) || size < 0) return res.status(400).json({ error: 'Tamaño inválido' });
  if (size + DISK_RESERVE > diskFree()) {
    return res.status(507).json({ error: 'No queda espacio en el disco del servidor para este archivo' });
  }
  if (page_id && !pageInWs(page_id, req.ws)) {
    return res.status(400).json({ error: 'Página inexistente' });
  }
  const id = nanoid(21);
  fs.writeFileSync(uploadPartPath(id), '');
  db.prepare('INSERT INTO uploads (id, page_id, name, mime, size, workspace_id) VALUES (?, ?, ?, ?, ?, ?)').run(
    id,
    page_id || null,
    name,
    inferMime(name, mime),
    size,
    req.ws
  );
  res.json({ id, chunk_size: CHUNK_SIZE, received: 0 });
});

app.get('/api/uploads/:id', (req, res) => {
  const u = isUploadId(req.params.id) && db.prepare('SELECT * FROM uploads WHERE id = ?').get(req.params.id);
  const received = u ? partSize(u.id) : null;
  if (!u || received === null) return res.status(404).json({ error: 'Subida no encontrada' });
  res.json({ id: u.id, size: u.size, received });
});

app.put(
  '/api/uploads/:id',
  express.raw({ type: () => true, limit: CHUNK_SIZE * 2 }),
  (req, res) => {
    const u = isUploadId(req.params.id) && db.prepare('SELECT * FROM uploads WHERE id = ?').get(req.params.id);
    const received = u ? partSize(u.id) : null;
    if (!u || received === null) return res.status(404).json({ error: 'Subida no encontrada' });
    const offset = Number(req.query.offset);
    const chunk = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    // El trozo no encaja donde estamos: el cliente se resincroniza con "received"
    if (offset !== received) return res.status(409).json({ error: 'Offset desincronizado', received });
    if (received + chunk.length > u.size) return res.status(400).json({ error: 'El trozo excede el tamaño declarado' });
    const fd = fs.openSync(uploadPartPath(u.id), 'a');
    try {
      fs.writeSync(fd, chunk);
      fs.fsyncSync(fd); // el trozo confirmado ya está en disco
    } finally {
      fs.closeSync(fd);
    }
    res.json({ received: received + chunk.length });
  }
);

app.post('/api/uploads/:id/complete', (req, res) => {
  const u = isUploadId(req.params.id) && db.prepare('SELECT * FROM uploads WHERE id = ?').get(req.params.id);
  const received = u ? partSize(u.id) : null;
  if (!u || received === null) return res.status(404).json({ error: 'Subida no encontrada' });
  if (received !== u.size) return res.status(409).json({ error: 'Faltan datos por subir', received });
  if (u.page_id && !pageInWs(u.page_id, u.workspace_id)) {
    return res.status(400).json({ error: 'La página ya no existe' });
  }
  const fileId = nanoid(21);
  fs.renameSync(uploadPartPath(u.id), path.join(FILES_DIR, fileId)); // mismo disco: operación atómica
  db.transaction(() => {
    db.prepare('INSERT INTO files (id, page_id, name, mime, size, workspace_id) VALUES (?, ?, ?, ?, ?, ?)').run(
      fileId,
      u.page_id,
      u.name,
      u.mime,
      u.size,
      u.workspace_id
    );
    db.prepare('DELETE FROM uploads WHERE id = ?').run(u.id);
  })();
  if (u.page_id) notifyPage(req, u.page_id);
  res.json({
    id: fileId,
    name: u.name,
    mime: u.mime,
    size: u.size,
    url: `/files/${fileId}/${encodeURIComponent(u.name)}`,
  });
});

app.delete('/api/uploads/:id', (req, res) => {
  if (isUploadId(req.params.id)) {
    try {
      fs.unlinkSync(uploadPartPath(req.params.id));
    } catch {}
    db.prepare('DELETE FROM uploads WHERE id = ?').run(req.params.id);
  }
  res.json({ ok: true });
});

const INLINE_MIME = /^(image|video|audio|text)\/|^application\/pdf$/;
// Tipos que el navegador ejecutaría (HTML, SVG con scripts, XML…): se sirven
// como texto o con CSP sandbox para que un adjunto subido no pueda ejecutar
// código con la sesión de quien lo abre
const ACTIVE_MIME = /^(text\/(html|xml|javascript|ecmascript|x-[a-z-]+)|application\/(xhtml\+xml|xml|javascript))\b/i;
const FILE_CSP = "sandbox; default-src 'none'; img-src 'self' data: blob:; media-src 'self' blob:; style-src 'unsafe-inline'"; 

// ---------- Vista previa de documentos de oficina (LibreOffice → PDF) ----------

const hasSoffice = spawnSync('soffice', ['--version'], { stdio: 'ignore' }).status === 0;
console.log(
  hasSoffice
    ? 'LibreOffice detectado: vista previa de Word/Excel/PowerPoint activada'
    : 'LibreOffice no encontrado: sin vista previa de documentos de oficina (apt install libreoffice-writer libreoffice-calc libreoffice-impress)'
);
const hasPoppler = spawnSync('pdftotext', ['-v'], { stdio: 'ignore' }).status === 0;
console.log(
  hasPoppler
    ? 'poppler detectado: extracción de texto y páginas de PDF activada'
    : 'poppler no encontrado: sin lectura de contenido de PDF/Office (apt install poppler-utils)'
);
const PREVIEWS_DIR = path.join(DATA_DIR, 'previews');
fs.mkdirSync(PREVIEWS_DIR, { recursive: true });

// ---------- OCR de capturas (semillas de ideas) ----------
// tesseract es opcional: sin él, las capturas se guardan igual (Claude las ve
// con read_attachment) pero su texto no entra en el buscador.
const hasTesseract = spawnSync('tesseract', ['--version'], { stdio: 'ignore' }).status === 0;
let ocrLangs = 'eng';
if (hasTesseract) {
  const out = spawnSync('tesseract', ['--list-langs'], { encoding: 'utf8' });
  const langs = `${out.stdout || ''}${out.stderr || ''}`
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => /^[a-z_]{3,}$/.test(l) && l !== 'osd');
  const wanted = ['spa', 'eng', 'cat'].filter((l) => langs.includes(l));
  ocrLangs = wanted.length ? wanted.join('+') : langs[0] || 'eng';
}
console.log(
  hasTesseract
    ? `tesseract detectado: OCR de capturas en ideas activado (${ocrLangs})`
    : 'tesseract no encontrado: las capturas de ideas no serán buscables por su texto (apt install tesseract-ocr tesseract-ocr-spa)'
);

function ocrImage(filePath) {
  if (!hasTesseract) return Promise.resolve('');
  return new Promise((resolve) => {
    execFile('tesseract', [filePath, 'stdout', '-l', ocrLangs], { timeout: 60000, maxBuffer: 8 * 1024 * 1024 }, (err, stdout) =>
      resolve(err ? '' : String(stdout).replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim())
    );
  });
}

function fileInWs(fileId, ws) {
  return !!db.prepare('SELECT 1 FROM files WHERE id = ? AND workspace_id = ? AND deleted_at IS NULL').get(fileId, ws);
}

// ---------- Ideas (desarrollo de ideas fuera del árbol) ----------

const ideaRow = (r) => ({
  id: r.id,
  title: r.title,
  icon: r.icon,
  created_at: r.created_at,
  updated_at: r.updated_at,
  tags: splitTags(r.tags),
  ...ideaDigest(r.content),
});

app.get('/api/ideas', (req, res) => {
  const rows = db
    .prepare(
      `SELECT id, title, icon, content, created_at, updated_at, ${TAGS_COLUMN}
       FROM pages WHERE kind = 'idea' AND trashed_at IS NULL AND workspace_id = ? ORDER BY updated_at DESC`
    )
    .all(req.ws);
  res.json(rows.map(ideaRow));
});

// Parche de una idea: estado, resumen, y altas/bajas/ediciones de semillas,
// pasos y resultados. Cada escritura deja la versión anterior en el historial.
app.post('/api/pages/:id/idea', async (req, res) => {
  const page0 = db.prepare('SELECT * FROM pages WHERE id = ?').get(req.params.id);
  if (!page0) return res.status(404).json({ error: 'Página no encontrada' });
  if (page0.kind !== 'idea') return res.status(400).json({ error: 'Esta página no es una idea' });
  const b = req.body || {};
  for (const k of ['seeds_add', 'steps_add', 'outcomes_add', 'steps_update', 'outcomes_update', 'seeds_update']) {
    if (b[k] !== undefined && !Array.isArray(b[k])) return res.status(400).json({ error: `"${k}" debe ser una lista` });
  }
  try {
    // Referencias a archivos y páginas: del mismo espacio. Las capturas pasan
    // por OCR antes de tocar la base de datos (es lento y asíncrono).
    for (const sd of b.seeds_add || []) {
      if (!sd || typeof sd !== 'object') continue;
      if (sd.file_id) {
        const f = db.prepare('SELECT * FROM files WHERE id = ? AND deleted_at IS NULL').get(sd.file_id);
        if (!f || f.workspace_id !== req.ws) throw new IdeaError(`El archivo ${sd.file_id} no existe en este espacio`);
        if (!sd.name) sd.name = f.name;
        if ((f.mime || '').startsWith('image/') && f.mime !== 'image/svg+xml') {
          if (sd.kind === 'file') sd.kind = 'image';
          if (sd.kind === 'image' && !sd.ocr) sd.ocr = await ocrImage(path.join(FILES_DIR, f.id));
        } else if (sd.kind === 'image') sd.kind = 'file';
      }
      if (sd.page_id && !pageInWs(sd.page_id, req.ws)) throw new IdeaError(`La página ${sd.page_id} no existe en este espacio`);
    }
    for (const o of b.outcomes_add || []) {
      if (!o || typeof o !== 'object') continue;
      if (o.page_id) {
        const target = db.prepare('SELECT kind FROM pages WHERE id = ? AND workspace_id = ? AND trashed_at IS NULL').get(o.page_id, req.ws);
        if (!target) throw new IdeaError(`La página ${o.page_id} no existe en este espacio`);
        if (o.page_id === page0.id) throw new IdeaError('Una idea no puede ser su propio resultado');
        if (target.kind === 'canvas' && o.type === 'page') o.type = 'canvas';
        if (target.kind === 'issue' && o.type === 'page') o.type = 'issue';
      }
      if (o.file_id && !fileInWs(o.file_id, req.ws)) throw new IdeaError(`El archivo ${o.file_id} no existe en este espacio`);
    }
    // Se relee la página: el OCR puede haber tardado y alguien (o Claude) haberla cambiado
    const page = db.prepare('SELECT * FROM pages WHERE id = ?').get(page0.id);
    if (!page) return res.status(404).json({ error: 'La idea ya no existe' });
    const idea = patchIdea(page.content, b);
    const content = JSON.stringify(idea);
    const fields = { content, content_text: ideaText(idea) };
    if (typeof b.title === 'string' && b.title.trim()) fields.title = b.title.trim().slice(0, 300);
    if (typeof b.icon === 'string' && b.icon) fields.icon = b.icon.slice(0, 8);
    // Cada paso, semilla o resultado es una acción discreta: siempre deja versión.
    // Solo teclear el enunciado desde la interfaz se agrupa (una cada 10 min).
    const onlySummary = Object.keys(b).every((k) => k === 'summary');
    if (content !== page.content && page.content) snapshotVersion(page, { throttled: Boolean(req.headers['x-client-id']) && onlySummary });
    const sets = Object.keys(fields).map((k) => `${k} = ?`).join(', ');
    db.prepare(`UPDATE pages SET ${sets}, rev = rev + 1, updated_at = datetime('now') WHERE id = ?`).run(...Object.values(fields), page.id);
    const updated = db.prepare('SELECT * FROM pages WHERE id = ?').get(page.id);
    ftsUpsert(page.id, updated.title, updated.content_text);
    logActivity(page.id);
    notifyPage(req, page.id);
    notifyTree(req); // la vista Ideas y el árbol (título, icono) se refrescan por el mismo aviso
    res.json({ ...updated, idea });
  } catch (e) {
    if (e instanceof IdeaError) return res.status(400).json({ error: e.message });
    // Express 4 no captura los errores de rutas async: sin esto, la petición no responde nunca
    console.error('idea:', e);
    if (!res.headersSent) res.status(500).json({ error: 'No se pudo actualizar la idea' });
  }
});

const OFFICE_EXT = new Set([
  '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx', '.odt', '.ods', '.odp', '.rtf',
]);
const previewPath = (fileId) => path.join(PREVIEWS_DIR, `${fileId}.pdf`);
const previewsInFlight = new Map();
const TEXT_EXTRACT_LIMIT = 600 * 1024; // ~150K tokens de texto extraído
const MAX_RENDER_PAGES = 10;

// Borra todos los artefactos de preview de un archivo (PDF convertido + páginas)
function clearPreviews(fileId) {
  try {
    for (const name of fs.readdirSync(PREVIEWS_DIR)) {
      if (name.startsWith(`${fileId}.`)) {
        try {
          fs.unlinkSync(path.join(PREVIEWS_DIR, name));
        } catch {}
      }
    }
  } catch {}
}

// Devuelve la ruta a un PDF para este archivo: el original si ya es PDF, o la
// conversión cacheada de LibreOffice si es un documento de oficina. null si no aplica.
async function ensurePdf(f) {
  const ext = path.extname(f.name).toLowerCase();
  if (ext === '.pdf' || f.mime === 'application/pdf') return path.join(FILES_DIR, f.id);
  if (!OFFICE_EXT.has(ext)) return null;
  if (!hasSoffice) throw new Error('LibreOffice no está instalado (apt install libreoffice-writer libreoffice-calc libreoffice-impress)');
  if (!fs.existsSync(previewPath(f.id))) {
    if (!previewsInFlight.has(f.id)) {
      previewsInFlight.set(f.id, convertToPdf(f).finally(() => previewsInFlight.delete(f.id)));
    }
    await previewsInFlight.get(f.id);
  }
  return previewPath(f.id);
}

function pdfToText(pdfPath) {
  return new Promise((resolve, reject) => {
    execFile(
      'pdftotext',
      ['-layout', '-enc', 'UTF-8', pdfPath, '-'],
      { maxBuffer: 64 * 1024 * 1024, timeout: 120000 },
      (err, stdout) => (err ? reject(err) : resolve(stdout))
    );
  });
}

// Renderiza una página (1-based) a PNG cacheado y devuelve su ruta
function renderPdfPage(pdfPath, page, fileId) {
  const out = path.join(PREVIEWS_DIR, `${fileId}.p${page}.png`);
  if (fs.existsSync(out)) return Promise.resolve(out);
  const prefix = out.replace(/\.png$/, '');
  return new Promise((resolve, reject) => {
    execFile(
      'pdftoppm',
      ['-png', '-singlefile', '-f', String(page), '-l', String(page), '-scale-to', '1600', pdfPath, prefix],
      { timeout: 120000 },
      (err) => (err || !fs.existsSync(out) ? reject(new Error(err?.message || 'No se pudo renderizar la página')) : resolve(out))
    );
  });
}

// ¿Podemos ejecutar programas sin red? (unshare -rn: espacio de usuario y de red propios)
const NO_NET_CMD = (() => {
  try {
    const r = spawnSync('unshare', ['-rn', 'true'], { timeout: 5000 });
    if (r.status === 0) return ['unshare', '-rn'];
  } catch {}
  console.warn('Aviso: «unshare -rn» no funciona aquí; las vistas previas de documentos de oficina quedan desactivadas');
  return null;
})();

function convertToPdf(f) {
  return new Promise((resolve, reject) => {
    // Los archivos se guardan sin extensión: copia temporal con la extensión
    // real para que LibreOffice detecte el formato, y perfil aislado para
    // poder convertir en paralelo sin choques de perfil de usuario.
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nonotion-prev-'));
    const ext = path.extname(f.name).toLowerCase();
    const src = path.join(tmp, `doc${ext}`);
    const cleanup = () => fs.rmSync(tmp, { recursive: true, force: true });
    try {
      fs.copyFileSync(path.join(FILES_DIR, f.id), src);
    } catch (e) {
      cleanup();
      return reject(new Error('Archivo no encontrado en disco'));
    }
    // Sin red: un documento puede enlazar imágenes remotas que LibreOffice
    // descargaría al convertir, y así hacer que el servidor pida cosas a otras
    // máquinas de la red local (SSRF). unshare -rn lo ejecuta en un espacio de
    // red vacío (solo un loopback propio).
    const sofficeArgs = [
      '--headless', '--norestore',
      `-env:UserInstallation=file://${tmp}/profile`,
      '--convert-to', 'pdf', '--outdir', tmp, src,
    ];
    if (!NO_NET_CMD) {
      cleanup();
      return reject(new Error('Vista previa desactivada: no se puede aislar LibreOffice de la red (falta unshare)'));
    }
    execFile(
      NO_NET_CMD[0],
      [...NO_NET_CMD.slice(1), 'soffice', ...sofficeArgs],
      { timeout: 120000 },
      (err) => {
        const out = path.join(tmp, 'doc.pdf');
        if (!err && fs.existsSync(out)) {
          try {
            fs.copyFileSync(out, previewPath(f.id));
            cleanup();
            return resolve();
          } catch (e) {
            err = e;
          }
        }
        cleanup();
        reject(new Error(err?.message || 'LibreOffice no generó el PDF'));
      }
    );
  });
}

// ---------- Hojas de cálculo (visor de Excel y lectura para Claude) ----------

const SHEET_EXT = new Set(['.xlsx', '.xlsm', '.xls', '.ods', '.csv', '.tsv']);
const SHEET_TIMEOUT_MS = 90000;
const sheetsInFlight = new Map();
const isSheet = (f) => SHEET_EXT.has(path.extname(f.name).toLowerCase());

// Lee la hoja en un worker (cacheado en previews/<id>.sheets.json)
function readSheets(f) {
  const cache = path.join(PREVIEWS_DIR, `${f.id}.sheets.json`);
  if (fs.existsSync(cache)) {
    try {
      return Promise.resolve(JSON.parse(fs.readFileSync(cache, 'utf8')));
    } catch {}
  }
  if (sheetsInFlight.has(f.id)) return sheetsInFlight.get(f.id);
  // Como mucho dos hojas leyéndose a la vez (cada una puede ocupar cientos de MB)
  const job = sheetSlot().then((release) => readSheetsNow(f, cache).finally(release));
  sheetsInFlight.set(f.id, job);
  job.finally(() => sheetsInFlight.delete(f.id)).catch(() => {});
  return job;
}

let sheetsRunning = 0;
const sheetsQueue = [];
function sheetSlot() {
  return new Promise((resolve) => {
    const take = () => {
      sheetsRunning++;
      resolve(() => {
        sheetsRunning--;
        sheetsQueue.shift()?.();
      });
    };
    if (sheetsRunning < 2) take();
    else sheetsQueue.push(take);
  });
}

function readSheetsNow(f, cache) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./sheets-worker.js', import.meta.url), {
      workerData: {
        filePath: path.join(FILES_DIR, f.id),
        ext: path.extname(f.name).toLowerCase(),
        textLimit: TEXT_EXTRACT_LIMIT,
      },
      resourceLimits: { maxOldGenerationSizeMb: 512 },
    });
    const timer = setTimeout(() => {
      worker.terminate();
      reject(new Error('La hoja de cálculo tarda demasiado en leerse'));
    }, SHEET_TIMEOUT_MS);
    worker.once('message', (msg) => {
      clearTimeout(timer);
      worker.terminate();
      if (!msg.ok) return reject(new Error(msg.error));
      delete msg.ok;
      try {
        fs.writeFileSync(cache, JSON.stringify(msg));
      } catch {}
      resolve(msg);
    });
    worker.once('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
  });
}

app.get('/files/:id/sheets', async (req, res) => {
  const f = db.prepare('SELECT * FROM files WHERE id = ? AND deleted_at IS NULL').get(req.params.id);
  if (!f) return res.status(404).json({ error: 'No encontrado' });
  if (!isSheet(f)) return res.status(400).json({ error: 'Este archivo no es una hoja de cálculo' });
  try {
    const data = await readSheets(f);
    res.json({ id: f.id, name: f.name, sheets: data.sheets });
  } catch (e) {
    res.status(500).json({ error: `No se pudo leer la hoja de cálculo: ${e.message}` });
  }
});

app.get('/files/:id/preview', async (req, res) => {
  const f = db.prepare('SELECT * FROM files WHERE id = ? AND deleted_at IS NULL').get(req.params.id);
  if (!f) return res.status(404).json({ error: 'No encontrado' });
  if (!OFFICE_EXT.has(path.extname(f.name).toLowerCase())) {
    return res.status(400).json({ error: 'Este tipo de archivo no necesita conversión' });
  }
  if (!hasSoffice) {
    return res.status(501).json({
      error:
        'LibreOffice no está instalado en el servidor. Instálalo con: apt install libreoffice-writer libreoffice-calc libreoffice-impress',
    });
  }
  try {
    await ensurePdf(f);
  } catch (e) {
    return res.status(500).json({ error: `No se pudo convertir el documento: ${e.message}` });
  }
  res.sendFile(previewPath(f.id), {
    headers: {
      'Content-Type': 'application/pdf',
      'Content-Disposition': `inline; filename*=UTF-8''${encodeURIComponent(f.name)}.pdf`,
    },
  });
});

// Texto extraído de un PDF o documento de oficina (usado por el MCP read_attachment)
app.get('/files/:id/text', async (req, res) => {
  const f = db.prepare('SELECT * FROM files WHERE id = ? AND deleted_at IS NULL').get(req.params.id);
  if (!f) return res.status(404).json({ error: 'No encontrado' });
  // Hojas de cálculo: todas las hojas en CSV (mucho más fiel que pasar por PDF)
  if (isSheet(f)) {
    try {
      const data = await readSheets(f);
      return res.json({ id: f.id, name: f.name, chars: data.chars, truncated: data.truncated, scanned: false, text: data.text });
    } catch (e) {
      if (!hasSoffice || !hasPoppler) return res.status(500).json({ error: e.message });
      // si falla la lectura directa se intenta la vía PDF
    }
  }
  if (!hasPoppler) {
    return res.status(501).json({ error: 'poppler no está instalado (apt install poppler-utils)' });
  }
  let pdfPath;
  try {
    pdfPath = await ensurePdf(f);
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
  if (!pdfPath) return res.status(400).json({ error: 'Este archivo no es PDF ni documento de oficina' });
  try {
    let text = await pdfToText(pdfPath);
    const total = text.length;
    const truncated = total > TEXT_EXTRACT_LIMIT;
    if (truncated) text = text.slice(0, TEXT_EXTRACT_LIMIT);
    res.json({ id: f.id, name: f.name, chars: total, truncated, scanned: text.trim().length < 16, text });
  } catch (e) {
    return res.status(500).json({ error: `No se pudo extraer el texto: ${e.message}` });
  }
});

// Una página del documento renderizada a PNG (para PDFs escaneados o con diagramas)
app.get('/files/:id/page/:page', async (req, res) => {
  const f = db.prepare('SELECT * FROM files WHERE id = ? AND deleted_at IS NULL').get(req.params.id);
  if (!f) return res.status(404).json({ error: 'No encontrado' });
  if (!hasPoppler) return res.status(501).json({ error: 'poppler no está instalado (apt install poppler-utils)' });
  const page = parseInt(req.params.page, 10);
  if (!Number.isInteger(page) || page < 1) return res.status(400).json({ error: 'Número de página inválido' });
  let pdfPath;
  try {
    pdfPath = await ensurePdf(f);
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
  if (!pdfPath) return res.status(400).json({ error: 'Este archivo no es PDF ni documento de oficina' });
  try {
    const png = await renderPdfPage(pdfPath, page, f.id);
    res.sendFile(png, { headers: { 'Content-Type': 'image/png' } });
  } catch (e) {
    return res.status(500).json({ error: `No se pudo renderizar la página ${page}: ${e.message}` });
  }
});

// Vista renderizada de un HTML adjunto (informes, gráficos que genera Claude).
// Se sirve con CSP "sandbox" SIN allow-same-origin: el documento corre en un
// origen opaco, así que sus scripts funcionan (gráficos, CDN) pero no pueden
// leer la sesión ni llamar a la API de NoNotion. Vale igual dentro del visor
// (iframe) que abierto en una pestaña nueva.
// Sin allow-forms, allow-downloads ni allow-popups-to-escape-sandbox: un HTML
// subido no puede hacerse pasar por un formulario de login de nuestro dominio,
// ni lanzar descargas, ni abrir ventanas fuera del aislamiento.
const HTML_VIEW_CSP =
  "sandbox allow-scripts allow-popups allow-modals; default-src * data: blob: 'unsafe-inline' 'unsafe-eval'; form-action 'none'";
const isHtmlFile = (f) => /^(text\/html|application\/xhtml\+xml)\b/i.test(f.mime || '') || /\.x?html?$/i.test(f.name || '');
app.get('/files/:id/view', (req, res, next) => {
  const f = db.prepare('SELECT * FROM files WHERE id = ? AND deleted_at IS NULL').get(req.params.id);
  if (!f || !isHtmlFile(f)) return next(); // un archivo llamado "view" que no es HTML: ruta normal
  const filePath = path.join(FILES_DIR, f.id);
  if (!fs.existsSync(filePath)) return res.status(404).send('No encontrado');
  res.sendFile(filePath, {
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Security-Policy': HTML_VIEW_CSP,
      'Content-Disposition': `inline; filename*=UTF-8''${encodeURIComponent(f.name)}`,
      'Cache-Control': 'private, no-cache',
    },
  });
});

app.get('/files/:id/:name?', (req, res) => {
  const f = db.prepare('SELECT * FROM files WHERE id = ? AND deleted_at IS NULL').get(req.params.id);
  if (!f) return res.status(404).send('No encontrado');
  const filePath = path.join(FILES_DIR, f.id);
  if (!fs.existsSync(filePath)) return res.status(404).send('No encontrado');
  const encoded = encodeURIComponent(f.name);
  const mime = (f.mime || '').toLowerCase();
  // El PDF necesita el visor del navegador (incompatible con sandbox); el resto
  // va siempre con CSP sandbox: aunque se abra directamente, no ejecuta scripts
  if (mime !== 'application/pdf') res.setHeader('Content-Security-Policy', FILE_CSP);
  if (mime && INLINE_MIME.test(mime)) {
    res.sendFile(filePath, {
      headers: {
        'Content-Type': ACTIVE_MIME.test(mime) ? 'text/plain; charset=utf-8' : f.mime,
        'Content-Disposition': `inline; filename*=UTF-8''${encoded}`,
      },
    });
  } else {
    res.download(filePath, f.name);
  }
});

// Borrar un adjunto lo manda a la papelera (recuperable 30 días); el archivo
// sigue en disco hasta que se purga.
app.delete('/api/files/:id', (req, res) => {
  const f = db.prepare('SELECT * FROM files WHERE id = ? AND deleted_at IS NULL').get(req.params.id);
  if (!f) return res.status(404).json({ error: 'No encontrado' });
  db.prepare(`UPDATE files SET deleted_at = datetime('now') WHERE id = ?`).run(f.id);
  if (f.page_id) notifyPage(req, f.page_id);
  res.json({ ok: true, trashed: true });
});

// ---------- Búsqueda ----------

// Búsqueda full-text. "#etiqueta" en la consulta (o ?tags=a,b) filtra por
// etiquetas; solo etiquetas, sin texto, lista las páginas que las tienen.
app.get('/api/search', (req, res) => {
  let q = String(req.query.q || '').trim();
  const tagList = String(req.query.tags || '').split(',').filter(Boolean);
  q = q.replace(/(^|\s)#([^\s#]+)/g, (m, sp, t) => {
    tagList.push(t);
    return ' ';
  }).trim();
  if (!q && !tagList.length) return res.json([]);
  const tagged = tagList.length ? new Set(pagesWithTags(req.ws, tagList, 'all') || []) : null;
  const withTags = (rows) => rows.map((r) => ({ ...r, tags: tagsOf(r.id) }));
  if (!q) {
    const ids = [...tagged].slice(0, 50);
    if (!ids.length) return res.json([]);
    const rows = db
      .prepare(
        `SELECT id, title, icon, kind, NULL AS snippet FROM pages
         WHERE workspace_id = ? AND id IN (${ids.map(() => '?').join(', ')}) ORDER BY updated_at DESC`
      )
      .all(req.ws, ...ids);
    return res.json(withTags(rows));
  }
  const ftsQuery = q
    .split(/\s+/)
    .map((t) => '"' + t.replace(/"/g, '""') + '"*')
    .join(' ');
  try {
    let rows = db
      .prepare(
        `SELECT p.id, p.title, p.icon, p.kind,
                snippet(pages_fts, 2, char(2), char(3), '…', 14) AS snippet
         FROM pages_fts
         JOIN pages p ON p.id = pages_fts.page_id
         WHERE pages_fts MATCH ? AND p.trashed_at IS NULL AND p.workspace_id = ?
         ORDER BY rank
         LIMIT ?`
      )
      .all(ftsQuery, req.ws, tagged ? 500 : 20);
    if (tagged) rows = rows.filter((r) => tagged.has(r.id)).slice(0, 20);
    // El fragmento es texto de la página: se escapa y solo <mark> queda como HTML
    for (const r of rows) {
      r.snippet = (r.snippet || '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/\u0002/g, '<mark>')
        .replace(/\u0003/g, '</mark>');
    }
    res.json(withTags(rows));
  } catch {
    res.json([]);
  }
});

// ---------- Compartir (enlaces públicos) ----------

app.post('/api/pages/:id/share', (req, res) => {
  if (!requireAdmin(req, res)) return;
  const page = db.prepare('SELECT * FROM pages WHERE id = ?').get(req.params.id);
  if (!page) return res.status(404).json({ error: 'Página no encontrada' });
  const token = page.share_token || nanoid(24);
  db.prepare('UPDATE pages SET share_token = ? WHERE id = ?').run(token, page.id);
  notifyTree(req);
  res.json({ token });
});

app.delete('/api/pages/:id/share', (req, res) => {
  db.prepare('UPDATE pages SET share_token = NULL WHERE id = ?').run(req.params.id);
  notifyTree(req);
  res.json({ ok: true });
});

app.get('/api/share/:token', (req, res) => {
  const page = db
    .prepare('SELECT id, title, icon, content, kind, updated_at FROM pages WHERE share_token = ? AND trashed_at IS NULL')
    .get(req.params.token);
  if (!page) return res.status(404).json({ error: 'Enlace no válido' });
  page.files = db
    .prepare('SELECT id, name, mime, size FROM files WHERE page_id = ? AND deleted_at IS NULL ORDER BY created_at')
    .all(page.id);
  // Ticket: estado y campos (sin relaciones: podrían nombrar páginas privadas)
  if (page.kind === 'issue') {
    const d = issueDetail(page.id);
    if (d) {
      page.issue = {
        key: d.key,
        status: d.status_name,
        category: d.category,
        color: d.color,
        fields: d.tracker.config.fields
          .filter((f) => !f.hidden && d.values[f.id] != null)
          .map((f) => ({ name: f.name, value: valueLabel(f, d.values[f.id]) })),
      };
    }
  }
  // Lista: sus tickets en solo lectura
  if (page.kind === 'tracker') {
    const d = trackerDetail(page.id);
    if (d) page.tracker = { prefix: d.prefix, config: d.config, issues: d.issues.map(({ tags, ...i }) => i) };
  }
  res.json(page);
});

// ---------- Export ZIP completo (Markdown + archivos) ----------

function sanitizeName(name) {
  let clean = (name || 'Sin título').replace(/[\/\\:*?"<>|\x00-\x1f]/g, ' ').replace(/\s+/g, ' ').trim();
  // «.», «..» o nombres que acaban en punto: dentro de un ZIP son rutas
  // relativas (a/../../x) que algunos descompresores siguen fuera de la carpeta
  clean = clean.replace(/^\.+/, (d) => '_'.repeat(d.length)).replace(/\.+$/, '').trim();
  return (clean || 'Sin título').slice(0, 120);
}

app.get('/api/export', async (req, res) => {
  const archiver = (await import('archiver')).default;
  const pages = db
    .prepare('SELECT * FROM pages WHERE trashed_at IS NULL AND workspace_id = ? ORDER BY position, created_at')
    .all(req.ws);
  const childrenMap = new Map();
  for (const p of pages) {
    const key = p.parent_id || null;
    if (!childrenMap.has(key)) childrenMap.set(key, []);
    childrenMap.get(key).push(p);
  }
  const allFiles = db.prepare('SELECT * FROM files WHERE deleted_at IS NULL AND workspace_id = ?').all(req.ws);
  const fileById = new Map(allFiles.map((f) => [f.id, f]));
  const fileEntryName = (f) => `files/${f.id}-${sanitizeName(f.name)}`;

  const archive = archiver('zip', { zlib: { level: 6 } });
  const stamp = new Date().toISOString().slice(0, 10);
  res.setHeader('Content-Type', 'application/zip');
  const wsName = db.prepare('SELECT name FROM workspaces WHERE id = ?').get(req.ws)?.name || 'export';
  const slug = wsName.normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'export';
  res.setHeader('Content-Disposition', `attachment; filename="nonotion-${slug}-${stamp}.zip"`);
  archive.on('error', (err) => {
    console.error('Error en export:', err);
    res.destroy(err);
  });
  archive.pipe(res);

  const usedFiles = new Set();
  const pathOfPage = new Map(); // id → ruta dentro del ZIP (para los canvas)
  const canvases = []; // se escriben al final, cuando ya se conocen todas las rutas

  const addPages = async (parentId, dir, depth) => {
    const kids = (childrenMap.get(parentId) || []).filter((p) => !['idea', 'issue', 'minutes'].includes(p.kind));
    const usedNames = new Set();
    for (const page of kids) {
      let base = sanitizeName(page.title);
      let candidate = base;
      let n = 2;
      while (usedNames.has(candidate.toLowerCase())) candidate = `${base} (${n++})`;
      usedNames.add(candidate.toLowerCase());

      if (page.kind === 'canvas') {
        pathOfPage.set(page.id, `${dir}${candidate}.canvas`);
        canvases.push(page);
        if ((childrenMap.get(page.id) || []).length > 0) await addPages(page.id, `${dir}${candidate}/`, depth + 1);
        continue;
      }
      pathOfPage.set(page.id, `${dir}${candidate}.md`);

      // Lista de seguimiento: su tabla y una carpeta con un .md por ticket
      if (page.kind === 'tracker') {
        const d = trackerDetail(page.id);
        if (d) {
          archive.append(
            `# ${page.icon ? page.icon + ' ' : ''}${page.title || 'Sin título'}\n\n${trackerConfigMarkdown(d)}\n\n## Tickets\n\n${d.issues.length ? trackerTableMarkdown(d) : '_(sin tickets)_'}\n`,
            { name: `${dir}${candidate}.md` }
          );
          const used = new Set();
          for (const it of d.issues) {
            const tp = pages.find((p) => p.id === it.id);
            const det = issueDetail(it.id);
            if (!tp || !det) continue;
            let name = sanitizeName(`${it.key} ${tp.title || ''}`);
            while (used.has(name.toLowerCase())) name += '_';
            used.add(name.toLowerCase());
            pathOfPage.set(tp.id, `${dir}${candidate}/${name}.md`);
            let body = await docToMarkdown(tp.content);
            body = body.replace(/\/files\/([A-Za-z0-9_-]{21})\/[^\s)>"']*/g, (match, fid) => {
              const f = fileById.get(fid);
              if (!f) return match;
              usedFiles.add(fid);
              return '../'.repeat(depth + 1) + fileEntryName(f);
            });
            for (const f of allFiles.filter((x) => x.page_id === tp.id)) usedFiles.add(f.id);
            archive.append(
              `# ${it.key} ${tp.title || 'Sin título'}\n\n${issueHeaderMarkdown(det)}\n\n## Descripción\n\n${body.trim() || '_(sin descripción)_'}\n\n` +
                `## Relaciones\n\n${issueRelationsMarkdown(det)}\n\n## Cronología\n\n${issueTimelineMarkdown(det)}\n`,
              { name: `${dir}${candidate}/${name}.md` }
            );
          }
        }
        continue;
      }

      let md = await docToMarkdown(page.content);
      // Reescribe los enlaces /files/<id>/... a rutas relativas dentro del ZIP
      md = md.replace(/\/files\/([A-Za-z0-9_-]{21})\/[^\s)>"']*/g, (match, fid) => {
        const f = fileById.get(fid);
        if (!f) return match;
        usedFiles.add(fid);
        return '../'.repeat(depth) + fileEntryName(f);
      });
      const pageTags = tagsOf(page.id);
      const heading =
        (md.trimStart().startsWith('# ') ? '' : `# ${page.icon ? page.icon + ' ' : ''}${page.title || 'Sin título'}\n\n`) +
        (pageTags.length ? `Etiquetas: ${pageTags.map((t) => '#' + t.replace(/\s+/g, '_')).join(' ')}\n\n` : '');
      const pageFiles = allFiles.filter((f) => f.page_id === page.id);
      let appendix = '';
      if (pageFiles.length) {
        appendix =
          '\n\n## Archivos adjuntos\n\n' +
          pageFiles
            .map((f) => {
              usedFiles.add(f.id);
              return `- [${f.name}](${'../'.repeat(depth)}${fileEntryName(f)})`;
            })
            .join('\n') +
          '\n';
      }
      archive.append(heading + md + appendix, { name: `${dir}${candidate}.md` });
      if ((childrenMap.get(page.id) || []).length > 0) {
        await addPages(page.id, `${dir}${candidate}/`, depth + 1);
      }
    }
  };

  await addPages(null, '', 0);

  // Ideas: fuera del árbol, en su propia carpeta, como resumen en Markdown
  const ideaNames = new Set();
  for (const page of pages.filter((p) => p.kind === 'idea')) {
    let base = sanitizeName(page.title);
    let candidate = base;
    let n = 2;
    while (ideaNames.has(candidate.toLowerCase())) candidate = `${base} (${n++})`;
    ideaNames.add(candidate.toLowerCase());
    const titleOf = (pid) => pages.find((p) => p.id === pid)?.title || null;
    const fileOf = (fid) => fileById.get(fid) || null;
    let md = `# ${page.icon ? page.icon + ' ' : ''}${page.title || 'Sin título'}\n\n` + ideaToMarkdown(page.content, { titleOf, fileOf });
    const pageFiles = allFiles.filter((f) => f.page_id === page.id);
    if (pageFiles.length) {
      md += '\n\n## Archivos adjuntos\n\n' + pageFiles.map((f) => {
        usedFiles.add(f.id);
        return `- [${f.name}](../${fileEntryName(f)})`;
      }).join('\n') + '\n';
    }
    archive.append(md, { name: `Ideas/${candidate}.md` });
  }

  // Actas: su texto, cabecera (fecha, proyecto, asistentes) y propuestas
  const minutesNames = new Set();
  for (const page of pages.filter((p) => p.kind === 'minutes')) {
    const d = minutesDetail(page.id);
    if (!d) continue;
    let name = sanitizeName(`${d.date || ''} ${page.title || ''}`.trim());
    while (minutesNames.has(name.toLowerCase())) name += '_';
    minutesNames.add(name.toLowerCase());
    const body = await docToMarkdown(page.content);
    archive.append(`# ${page.icon ? page.icon + ' ' : ''}${page.title}\n\n${minutesHeaderMarkdown(d)}\n\n${body}\n\n## Propuestas\n\n${minutesItemsMarkdown(d)}\n`, {
      name: `Actas/${name}.md`,
    });
  }

  // Canvas en formato JSON Canvas (.canvas), como Obsidian: las páginas y los
  // adjuntos se referencian por su ruta dentro del ZIP (el "vault")
  for (const page of canvases) {
    let c;
    try {
      c = normalizeCanvas(page.content);
    } catch {
      // nunca se exporta vacío: se guarda el contenido original sin tocar
      archive.append(page.content || '', { name: pathOfPage.get(page.id) });
      continue;
    }
    const toVault = (ref) => {
      const pid = pageIdOfFile(ref);
      if (pid) return pathOfPage.get(pid) || ref;
      const fid = fileIdOfFile(ref);
      const f = fid && fileById.get(fid);
      if (f) {
        usedFiles.add(fid);
        return fileEntryName(f);
      }
      return ref;
    };
    for (const n of c.nodes) {
      if (n.type === 'file') n.file = toVault(n.file);
      if (n.type === 'group' && n.background) n.background = toVault(n.background);
    }
    archive.append(JSON.stringify(c, null, '\t'), { name: pathOfPage.get(page.id) });
  }

  for (const fid of usedFiles) {
    const f = fileById.get(fid);
    const p = path.join(FILES_DIR, f.id);
    if (fs.existsSync(p)) archive.file(p, { name: fileEntryName(f) });
  }

  await archive.finalize();
});

// ---------- MCP remoto (Claude lee y escribe en NoNotion) ----------

mountMcp(app, PORT);

// ---------- Frontend estático (producción) ----------

const dist = path.join(__dirname, '..', 'client', 'dist');
if (fs.existsSync(dist)) {
  // CSP de la app: solo se ejecutan nuestros propios scripts (y el pequeño
  // script del tema de index.html, por su hash). Si algún día se colara HTML en
  // una página, no podría ejecutar código ni mandar datos fuera.
  const indexHtml = fs.readFileSync(path.join(dist, 'index.html'), 'utf8');
  const inlineHashes = [...indexHtml.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)].map(
    (m) => `'sha256-${crypto.createHash('sha256').update(m[1]).digest('base64')}'`
  );
  const APP_CSP = [
    "default-src 'self'",
    `script-src 'self' ${inlineHashes.join(' ')}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob: https: http:",
    "media-src 'self' data: blob: https:",
    "font-src 'self' data:",
    "connect-src 'self'",
    "frame-src 'self' https: http:",
    "worker-src 'self' blob:",
    "object-src 'self'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'self'",
  ].join('; ');
  const setAppCsp = (res) => res.setHeader('Content-Security-Policy', APP_CSP);
  app.use(express.static(dist, { setHeaders: (res, file) => file.endsWith('.html') && setAppCsp(res) }));
  app.get(/^(?!\/api\/|\/files\/).*/, (req, res) => {
    setAppCsp(res);
    res.type('html').send(indexHtml);
  });
}

// ---------- Copias de seguridad de la base de datos ----------
// Cada hora (si hubo cambios) se hace una copia consistente de SQLite con la
// API de backup (válida aunque haya escrituras en curso). Se guardan las
// últimas 48 horarias + una diaria de los últimos 30 días. Los archivos
// adjuntos no se modifican nunca (solo se añaden), así que basta con copiarlos.
// El host Proxmox sincroniza esta carpeta y files/ fuera del disco (router).

const DB_BACKUP_DIR = path.join(DATA_DIR, 'backups', 'db');
fs.mkdirSync(DB_BACKUP_DIR, { recursive: true });
const KEEP_HOURLY = 48;
const KEEP_DAILY = 30;
let lastBackupSignature = null;

function dbSignature() {
  // total_changes cuenta TODAS las escrituras de este proceso (etiquetas,
  // favoritas, miembros, tokens, papelera…), no solo las de contenido
  const changes = db.prepare('SELECT total_changes() AS n').get().n;
  const s = db
    .prepare(
      `SELECT (SELECT COUNT(*) || ':' || COALESCE(SUM(rev), 0) || ':' || COALESCE(MAX(updated_at), '') FROM pages) AS p,
              (SELECT COUNT(*) || ':' || COALESCE(SUM(deleted_at IS NOT NULL), 0) FROM files) AS f,
              (SELECT COALESCE(MAX(id), 0) FROM versions) AS v`
    )
    .get();
  return `${s.p}|${s.f}|${s.v}|${changes}`;
}

async function backupDatabase() {
  const signature = dbSignature();
  if (signature === lastBackupSignature) return; // nada nuevo desde la última copia
  const stamp = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 16); // 2026-10-20-07-28
  const dest = path.join(DB_BACKUP_DIR, `nonotion-${stamp}.db`);
  const tmp = `${dest}.tmp`;
  try {
    await db.backup(tmp);
    fs.renameSync(tmp, dest);
    lastBackupSignature = signature;
  } catch (e) {
    console.error('Copia de seguridad de la BD fallida:', e.message);
    try {
      fs.unlinkSync(tmp);
    } catch {}
    return;
  }
  const all = fs.readdirSync(DB_BACKUP_DIR).filter((f) => /^nonotion-[\d-]+\.db$/.test(f)).sort();
  const keep = new Set(all.slice(-KEEP_HOURLY));
  const firstOfDay = new Map();
  for (const f of all) {
    const day = f.slice(9, 19);
    if (!firstOfDay.has(day)) firstOfDay.set(day, f);
  }
  for (const f of [...firstOfDay.values()].slice(-KEEP_DAILY)) keep.add(f);
  for (const f of all) {
    if (!keep.has(f)) {
      try {
        fs.unlinkSync(path.join(DB_BACKUP_DIR, f));
      } catch {}
    }
  }
}

purgeOldTrash();
setInterval(purgeOldTrash, 24 * 60 * 60 * 1000).unref();
setInterval(purgeExpiredSessions, 6 * 60 * 60 * 1000).unref();
setTimeout(backupDatabase, 60 * 1000).unref();
setInterval(backupDatabase, 60 * 60 * 1000).unref();

// HOST permite escuchar solo en una interfaz (p. ej. 127.0.0.1 si cloudflared
// corre en la misma máquina). Por defecto, todas: cloudflared suele estar en
// otro contenedor; entonces limita el puerto con el cortafuegos.
const HOST = process.env.HOST || undefined;
app.listen(PORT, HOST, () => {
  console.log(`NoNotion escuchando en http://${HOST || 'localhost'}:${PORT}`);
});
