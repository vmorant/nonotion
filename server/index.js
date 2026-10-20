import express from 'express';
import path from 'path';
import fs from 'fs';
import os from 'os';
import multer from 'multer';
import { nanoid } from 'nanoid';
import { fileURLToPath } from 'url';
import { spawnSync, execFile } from 'child_process';
import db, { DATA_DIR, FILES_DIR, ftsUpsert, ftsDelete, extractText, logActivity } from './db.js';
import { docToMarkdown } from './markdown.js';
import { mountMcp, getOrCreateToken } from './mcp.js';
import { setupAuth, purgeExpiredSessions } from './auth.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3000;
const TRASH_RETENTION_DAYS = 30;
const VERSION_THROTTLE_MINUTES = 10;
const MAX_VERSIONS_PER_PAGE = 50;

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '100mb' }));

// Login con GitHub + token de API. Va antes que cualquier ruta.
const authCfg = setupAuth(app, { apiToken: getOrCreateToken() });

app.get('/api/health', (req, res) => res.json({ ok: true }));

const upload = multer({
  storage: multer.diskStorage({
    destination: FILES_DIR,
    filename: (req, file, cb) => cb(null, nanoid(21)),
  }),
});

// ---------- Sincronización en vivo (Server-Sent Events) ----------
// Cada navegador abre /api/events; cuando algo cambia, le avisamos para que se
// actualice sin recargar. El cambio lo puede provocar otra persona o el MCP.

const sseClients = new Set(); // { res, client }

function broadcast(event, originId) {
  const data = `data: ${JSON.stringify(event)}\n\n`;
  for (const c of sseClients) {
    if (originId && c.client === originId) continue; // no devolver al autor su propio cambio
    try {
      c.res.write(data);
    } catch {}
  }
}

const notifyTree = (req) => broadcast({ type: 'tree' }, req?.headers?.['x-client-id']);
const notifyPage = (req, id) => broadcast({ type: 'page', id }, req?.headers?.['x-client-id']);

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

function isDescendant(candidateId, ancestorId) {
  return subtreeIds(ancestorId).includes(candidateId);
}

function permanentDelete(pageId) {
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
  const entry = { res, client: req.query.client || null };
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

// ---------- Páginas ----------

app.get('/api/pages', (req, res) => {
  const rows = db
    .prepare(
      `SELECT id, parent_id, title, icon, position, updated_at, page_date,
              share_token IS NOT NULL AS shared
       FROM pages WHERE trashed_at IS NULL ORDER BY position, created_at`
    )
    .all();
  res.json(rows);
});

const validDate = (v) => (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null);

app.post('/api/pages', (req, res) => {
  const { parent_id = null, title = '', icon = '', content = null, page_date = null } = req.body || {};
  const id = nanoid(12);
  const pos = db
    .prepare('SELECT COALESCE(MAX(position) + 1, 0) AS p FROM pages WHERE parent_id IS ?')
    .get(parent_id).p;
  // content opcional como string: markdown crudo (mismo mecanismo que /api/capture)
  const raw = typeof content === 'string' ? content : '';
  db.prepare(
    'INSERT INTO pages (id, parent_id, title, icon, content, content_text, position, page_date) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
  ).run(id, parent_id, title, icon, raw, raw, pos, validDate(page_date));
  ftsUpsert(id, title, raw);
  notifyTree(req);
  res.json(db.prepare('SELECT * FROM pages WHERE id = ?').get(id));
});

app.get('/api/pages/:id', (req, res) => {
  const page = db.prepare('SELECT * FROM pages WHERE id = ?').get(req.params.id);
  if (!page) return res.status(404).json({ error: 'Página no encontrada' });
  page.files = db
    .prepare('SELECT id, name, mime, size, created_at FROM files WHERE page_id = ? AND deleted_at IS NULL ORDER BY created_at')
    .all(page.id);
  res.json(page);
});

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
  if (typeof b.position === 'number') fields.position = b.position;
  if (b.page_date !== undefined) fields.page_date = validDate(b.page_date);
  if (b.parent_id !== undefined) {
    if (b.parent_id !== null) {
      if (b.parent_id === page.id || isDescendant(b.parent_id, page.id)) {
        return res.status(400).json({ error: 'Movimiento inválido: crearía un ciclo' });
      }
      const parent = db.prepare('SELECT id FROM pages WHERE id = ?').get(b.parent_id);
      if (!parent) return res.status(400).json({ error: 'Padre inexistente' });
    }
    fields.parent_id = b.parent_id;
  }

  if (Object.keys(fields).length === 0) return res.json(page);

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
  if (fields.title !== undefined || fields.icon !== undefined || fields.parent_id !== undefined || fields.page_date !== undefined) {
    notifyTree(req);
  }
  res.json({ ...updated, conflict });
});

// Mover en el árbol: nuevo padre + posición exacta entre hermanos
app.post('/api/pages/:id/move', (req, res) => {
  const page = db.prepare('SELECT * FROM pages WHERE id = ?').get(req.params.id);
  if (!page) return res.status(404).json({ error: 'Página no encontrada' });
  const { parent_id = null, index = 0 } = req.body || {};
  if (parent_id !== null) {
    if (parent_id === page.id || isDescendant(parent_id, page.id)) {
      return res.status(400).json({ error: 'Movimiento inválido: crearía un ciclo' });
    }
    if (!db.prepare('SELECT id FROM pages WHERE id = ?').get(parent_id)) {
      return res.status(400).json({ error: 'Padre inexistente' });
    }
  }
  db.transaction(() => {
    const siblings = db
      .prepare(
        `SELECT id FROM pages WHERE parent_id IS ? AND trashed_at IS NULL AND id != ?
         ORDER BY position, created_at`
      )
      .all(parent_id, page.id)
      .map((r) => r.id);
    const at = Math.max(0, Math.min(index, siblings.length));
    siblings.splice(at, 0, page.id);
    const setPos = db.prepare('UPDATE pages SET position = ? WHERE id = ?');
    siblings.forEach((id, i) => setPos.run(i, id));
    db.prepare(`UPDATE pages SET parent_id = ?, updated_at = datetime('now') WHERE id = ?`).run(
      parent_id,
      page.id
    );
  })();
  notifyTree(req);
  res.json({ ok: true });
});

// Duplicar página (subárbol completo, con copia física de archivos)
app.post('/api/pages/:id/duplicate', (req, res) => {
  const orig = db.prepare('SELECT * FROM pages WHERE id = ?').get(req.params.id);
  if (!orig) return res.status(404).json({ error: 'Página no encontrada' });

  const insertPage = db.prepare(
    `INSERT INTO pages (id, parent_id, title, icon, content, content_text, position)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  );
  const insertFile = db.prepare('INSERT INTO files (id, page_id, name, mime, size) VALUES (?, ?, ?, ?, ?)');

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
      position ?? src.position
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
      insertFile.run(newFileId, newId, f.name, f.mime, f.size);
      content = content.split(`/files/${f.id}/`).join(`/files/${newFileId}/`);
    }
    if (content !== src.content) {
      db.prepare('UPDATE pages SET content = ? WHERE id = ?').run(content, newId);
    }
    ftsUpsert(newId, titleOverride ?? src.title, src.content_text);
    const children = db
      .prepare('SELECT id FROM pages WHERE parent_id = ? AND trashed_at IS NULL ORDER BY position, created_at')
      .all(srcId);
    for (const c of children) clone(c.id, newId, null, null);
    return newId;
  };

  const newId = db.transaction(() =>
    clone(orig.id, orig.parent_id, `Copia de ${orig.title || 'Sin título'}`, orig.position + 1)
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
       WHERE t.trashed_at IS NOT NULL
         AND (t.parent_id IS NULL OR parent.id IS NULL OR parent.trashed_at IS NULL)
       ORDER BY t.trashed_at DESC`
    )
    .all();
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

app.delete('/api/trash/:id', (req, res) => {
  const page = db.prepare('SELECT id FROM pages WHERE id = ? AND trashed_at IS NOT NULL').get(req.params.id);
  if (!page) return res.status(404).json({ error: 'No está en la papelera' });
  const deleted = permanentDelete(page.id);
  notifyTree(req);
  res.json({ ok: true, deleted });
});

app.delete('/api/trash', (req, res) => {
  const roots = db
    .prepare(
      `SELECT t.id FROM pages t
       LEFT JOIN pages parent ON parent.id = t.parent_id
       WHERE t.trashed_at IS NOT NULL AND (t.parent_id IS NULL OR parent.id IS NULL OR parent.trashed_at IS NULL)`
    )
    .all();
  let deleted = 0;
  for (const r of roots) deleted += permanentDelete(r.id);
  const deletedFiles = db.prepare('SELECT id FROM files WHERE deleted_at IS NOT NULL').all();
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
       WHERE f.deleted_at IS NOT NULL ORDER BY f.deleted_at DESC`
    )
    .all();
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
      `SELECT id, title, icon, page_date AS day FROM pages
       WHERE trashed_at IS NULL AND page_date BETWEEN ? AND ?`
    )
    .all(from, to);
  const created = db
    .prepare(
      `SELECT id, title, icon, date(created_at, 'localtime') AS day FROM pages
       WHERE trashed_at IS NULL AND date(created_at, 'localtime') BETWEEN ? AND ?`
    )
    .all(from, to);
  const edited = db
    .prepare(
      `SELECT p.id, p.title, p.icon, a.day, a.edits FROM activity a
       JOIN pages p ON p.id = a.page_id
       WHERE p.trashed_at IS NULL AND a.day BETWEEN ? AND ?
         AND a.day != date(p.created_at, 'localtime')`
    )
    .all(from, to);
  res.json({ dated, created, edited });
});

// ---------- Captura desde el PC de IA ----------

function deriveTitle(markdown) {
  const heading = markdown.match(/^#{1,6}\s+(.+)$/m);
  let title = heading ? heading[1] : (markdown.split('\n').find((l) => l.trim()) || '').trim();
  title = title.replace(/[*_`#>\[\]]/g, '').trim();
  return title.length > 80 ? title.slice(0, 77) + '…' : title || 'Captura';
}

function getOrCreateInbox() {
  const inbox = db
    .prepare(`SELECT id FROM pages WHERE parent_id IS NULL AND title = 'Inbox' AND trashed_at IS NULL`)
    .get();
  if (inbox) return inbox.id;
  const id = nanoid(12);
  db.prepare(`INSERT INTO pages (id, parent_id, title, icon, position) VALUES (?, NULL, 'Inbox', '📥', -1)`).run(id);
  ftsUpsert(id, 'Inbox', '');
  return id;
}

app.post('/api/capture', (req, res) => {
  const { markdown, title, parent_id, page_date, icon } = req.body || {};
  if (typeof markdown !== 'string' || !markdown.trim()) {
    return res.status(400).json({ error: 'Falta el campo "markdown"' });
  }
  let parentId = parent_id || null;
  if (parentId && !db.prepare('SELECT id FROM pages WHERE id = ?').get(parentId)) {
    return res.status(400).json({ error: 'Padre inexistente' });
  }
  if (!parentId) parentId = getOrCreateInbox();

  const id = nanoid(12);
  const pageTitle = (title || '').trim() || deriveTitle(markdown);
  const pos = db
    .prepare('SELECT COALESCE(MAX(position) + 1, 0) AS p FROM pages WHERE parent_id IS ?')
    .get(parentId).p;
  // Se guarda el markdown crudo: el editor lo convierte a bloques al abrirlo
  db.prepare(
    'INSERT INTO pages (id, parent_id, title, icon, content, content_text, position, page_date) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
  ).run(id, parentId, pageTitle, typeof icon === 'string' && icon ? icon : '🤖', markdown, markdown, pos, validDate(page_date));
  ftsUpsert(id, pageTitle, markdown);
  notifyTree(req);
  res.json({ id, title: pageTitle, url: `/p/${id}` });
});

// ---------- Lectura/escritura en Markdown (usada por el MCP) ----------

app.get('/api/pages/:id/markdown', async (req, res) => {
  const page = db.prepare('SELECT * FROM pages WHERE id = ?').get(req.params.id);
  if (!page) return res.status(404).json({ error: 'Página no encontrada' });
  const markdown = await docToMarkdown(page.content);
  const files = db
    .prepare('SELECT id, name, mime, size FROM files WHERE page_id = ? AND deleted_at IS NULL ORDER BY created_at')
    .all(page.id);
  res.json({
    id: page.id,
    title: page.title,
    icon: page.icon,
    page_date: page.page_date,
    parent_id: page.parent_id,
    updated_at: page.updated_at,
    trashed: !!page.trashed_at,
    markdown,
    files,
  });
});

app.post('/api/pages/:id/append', async (req, res) => {
  const page = db.prepare('SELECT * FROM pages WHERE id = ?').get(req.params.id);
  if (!page) return res.status(404).json({ error: 'Página no encontrada' });
  const { markdown } = req.body || {};
  if (typeof markdown !== 'string' || !markdown.trim()) {
    return res.status(400).json({ error: 'Falta el campo "markdown"' });
  }
  if (page.content) snapshotVersion(page, { throttled: true });
  const current = await docToMarkdown(page.content);
  const combined = current ? `${current.replace(/\s+$/, '')}\n\n${markdown}` : markdown;
  db.prepare(
    `UPDATE pages SET content = ?, content_text = ?, rev = rev + 1, updated_at = datetime('now') WHERE id = ?`
  ).run(combined, combined, page.id);
  ftsUpsert(page.id, page.title, combined);
  logActivity(page.id);
  notifyPage(req, page.id);
  res.json(db.prepare('SELECT * FROM pages WHERE id = ?').get(page.id));
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
  if (given && given !== 'application/octet-stream') return given;
  return EXT_MIME[path.extname(name || '').toLowerCase()] || given || 'application/octet-stream';
}

app.post('/api/files', upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Falta el archivo' });
  const pageId = req.body.page_id || null;
  const f = req.file;
  // multer no decodifica UTF-8 en originalname (llega como latin1)
  const name = Buffer.from(f.originalname, 'latin1').toString('utf8');
  const mime = inferMime(name, f.mimetype);
  db.prepare('INSERT INTO files (id, page_id, name, mime, size) VALUES (?, ?, ?, ?, ?)').run(
    f.filename,
    pageId,
    name,
    mime,
    f.size
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
  if (page_id && !db.prepare('SELECT id FROM pages WHERE id = ?').get(page_id)) {
    return res.status(400).json({ error: 'Página inexistente' });
  }
  const id = nanoid(21);
  fs.writeFileSync(uploadPartPath(id), '');
  db.prepare('INSERT INTO uploads (id, page_id, name, mime, size) VALUES (?, ?, ?, ?, ?)').run(
    id,
    page_id || null,
    name,
    inferMime(name, mime),
    size
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
  if (u.page_id && !db.prepare('SELECT id FROM pages WHERE id = ?').get(u.page_id)) {
    return res.status(400).json({ error: 'La página ya no existe' });
  }
  const fileId = nanoid(21);
  fs.renameSync(uploadPartPath(u.id), path.join(FILES_DIR, fileId)); // mismo disco: operación atómica
  db.transaction(() => {
    db.prepare('INSERT INTO files (id, page_id, name, mime, size) VALUES (?, ?, ?, ?, ?)').run(
      fileId,
      u.page_id,
      u.name,
      u.mime,
      u.size
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
    execFile(
      'soffice',
      [
        '--headless', '--norestore',
        `-env:UserInstallation=file://${tmp}/profile`,
        '--convert-to', 'pdf', '--outdir', tmp, src,
      ],
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

app.get('/files/:id/:name?', (req, res) => {
  const f = db.prepare('SELECT * FROM files WHERE id = ? AND deleted_at IS NULL').get(req.params.id);
  if (!f) return res.status(404).send('No encontrado');
  const filePath = path.join(FILES_DIR, f.id);
  if (!fs.existsSync(filePath)) return res.status(404).send('No encontrado');
  const encoded = encodeURIComponent(f.name);
  if (f.mime && INLINE_MIME.test(f.mime)) {
    res.sendFile(filePath, {
      headers: {
        'Content-Type': f.mime,
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

app.get('/api/search', (req, res) => {
  const q = String(req.query.q || '').trim();
  if (!q) return res.json([]);
  const ftsQuery = q
    .split(/\s+/)
    .map((t) => '"' + t.replace(/"/g, '""') + '"*')
    .join(' ');
  try {
    const rows = db
      .prepare(
        `SELECT p.id, p.title, p.icon,
                snippet(pages_fts, 2, '<mark>', '</mark>', '…', 14) AS snippet
         FROM pages_fts
         JOIN pages p ON p.id = pages_fts.page_id
         WHERE pages_fts MATCH ? AND p.trashed_at IS NULL
         ORDER BY rank
         LIMIT 20`
      )
      .all(ftsQuery);
    res.json(rows);
  } catch {
    res.json([]);
  }
});

// ---------- Compartir (enlaces públicos) ----------

app.post('/api/pages/:id/share', (req, res) => {
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
    .prepare('SELECT id, title, icon, content, updated_at FROM pages WHERE share_token = ? AND trashed_at IS NULL')
    .get(req.params.token);
  if (!page) return res.status(404).json({ error: 'Enlace no válido' });
  page.files = db
    .prepare('SELECT id, name, mime, size FROM files WHERE page_id = ? AND deleted_at IS NULL ORDER BY created_at')
    .all(page.id);
  res.json(page);
});

// ---------- Export ZIP completo (Markdown + archivos) ----------

function sanitizeName(name) {
  const clean = (name || 'Sin título').replace(/[\/\\:*?"<>|\x00-\x1f]/g, ' ').replace(/\s+/g, ' ').trim();
  return (clean || 'Sin título').slice(0, 120);
}

app.get('/api/export', async (req, res) => {
  const archiver = (await import('archiver')).default;
  const pages = db
    .prepare('SELECT * FROM pages WHERE trashed_at IS NULL ORDER BY position, created_at')
    .all();
  const childrenMap = new Map();
  for (const p of pages) {
    const key = p.parent_id || null;
    if (!childrenMap.has(key)) childrenMap.set(key, []);
    childrenMap.get(key).push(p);
  }
  const allFiles = db.prepare('SELECT * FROM files WHERE deleted_at IS NULL').all();
  const fileById = new Map(allFiles.map((f) => [f.id, f]));
  const fileEntryName = (f) => `files/${f.id}-${sanitizeName(f.name)}`;

  const archive = archiver('zip', { zlib: { level: 6 } });
  const stamp = new Date().toISOString().slice(0, 10);
  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', `attachment; filename="nonotion-export-${stamp}.zip"`);
  archive.on('error', (err) => {
    console.error('Error en export:', err);
    res.destroy(err);
  });
  archive.pipe(res);

  const usedFiles = new Set();

  const addPages = async (parentId, dir, depth) => {
    const kids = childrenMap.get(parentId) || [];
    const usedNames = new Set();
    for (const page of kids) {
      let base = sanitizeName(page.title);
      let candidate = base;
      let n = 2;
      while (usedNames.has(candidate.toLowerCase())) candidate = `${base} (${n++})`;
      usedNames.add(candidate.toLowerCase());

      let md = await docToMarkdown(page.content);
      // Reescribe los enlaces /files/<id>/... a rutas relativas dentro del ZIP
      md = md.replace(/\/files\/([A-Za-z0-9_-]{21})\/[^\s)>"']*/g, (match, fid) => {
        const f = fileById.get(fid);
        if (!f) return match;
        usedFiles.add(fid);
        return '../'.repeat(depth) + fileEntryName(f);
      });
      const heading = md.trimStart().startsWith('# ')
        ? ''
        : `# ${page.icon ? page.icon + ' ' : ''}${page.title || 'Sin título'}\n\n`;
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
  app.use(express.static(dist));
  app.get(/^(?!\/api\/|\/files\/).*/, (req, res) => {
    res.sendFile(path.join(dist, 'index.html'));
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
  const s = db
    .prepare(
      `SELECT (SELECT COUNT(*) || ':' || COALESCE(SUM(rev), 0) || ':' || COALESCE(MAX(updated_at), '') FROM pages) AS p,
              (SELECT COUNT(*) || ':' || COALESCE(SUM(deleted_at IS NOT NULL), 0) FROM files) AS f,
              (SELECT COALESCE(MAX(id), 0) FROM versions) AS v`
    )
    .get();
  return `${s.p}|${s.f}|${s.v}`;
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

app.listen(PORT, () => {
  console.log(`NoNotion escuchando en http://localhost:${PORT}`);
});
