import express from 'express';
import path from 'path';
import fs from 'fs';
import multer from 'multer';
import { nanoid } from 'nanoid';
import { fileURLToPath } from 'url';
import db, { FILES_DIR, ftsUpsert, ftsDelete, extractText, logActivity } from './db.js';
import { docToMarkdown } from './markdown.js';
import { mountMcp } from './mcp.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3000;
const TRASH_RETENTION_DAYS = 30;
const VERSION_THROTTLE_MINUTES = 10;
const MAX_VERSIONS_PER_PAGE = 50;

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '100mb' }));

const upload = multer({
  storage: multer.diskStorage({
    destination: FILES_DIR,
    filename: (req, file, cb) => cb(null, nanoid(21)),
  }),
});

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
  }
  db.prepare('DELETE FROM pages WHERE id = ?').run(pageId); // cascada borra hijos, files y versions
  for (const id of subtree) ftsDelete(id);
  return subtree.length;
}

// ---------- Identidad (Cloudflare Access) ----------

app.get('/api/me', (req, res) => {
  res.json({ email: req.headers['cf-access-authenticated-user-email'] || null });
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
  res.json(db.prepare('SELECT * FROM pages WHERE id = ?').get(id));
});

app.get('/api/pages/:id', (req, res) => {
  const page = db.prepare('SELECT * FROM pages WHERE id = ?').get(req.params.id);
  if (!page) return res.status(404).json({ error: 'Página no encontrada' });
  page.files = db
    .prepare('SELECT id, name, mime, size, created_at FROM files WHERE page_id = ? ORDER BY created_at')
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

  if (fields.content !== undefined && fields.content !== page.content && page.content) {
    snapshotVersion(page, { throttled: true });
  }

  const sets = Object.keys(fields).map((k) => `${k} = ?`).join(', ');
  db.prepare(`UPDATE pages SET ${sets}, updated_at = datetime('now') WHERE id = ?`).run(
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
  res.json(updated);
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
    const files = db.prepare('SELECT * FROM files WHERE page_id = ?').all(srcId);
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
  res.json({ ok: true, restored: subtree.length });
});

app.delete('/api/trash/:id', (req, res) => {
  const page = db.prepare('SELECT id FROM pages WHERE id = ? AND trashed_at IS NOT NULL').get(req.params.id);
  if (!page) return res.status(404).json({ error: 'No está en la papelera' });
  const deleted = permanentDelete(page.id);
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
  res.json({ ok: true, deleted });
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
    `UPDATE pages SET title = ?, content = ?, content_text = ?, updated_at = datetime('now') WHERE id = ?`
  ).run(v.title, v.content, text, page.id);
  ftsUpsert(page.id, v.title, text);
  logActivity(page.id);
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
  res.json({ id, title: pageTitle, url: `/p/${id}` });
});

// ---------- Lectura/escritura en Markdown (usada por el MCP) ----------

app.get('/api/pages/:id/markdown', async (req, res) => {
  const page = db.prepare('SELECT * FROM pages WHERE id = ?').get(req.params.id);
  if (!page) return res.status(404).json({ error: 'Página no encontrada' });
  const markdown = await docToMarkdown(page.content);
  const files = db
    .prepare('SELECT id, name, mime, size FROM files WHERE page_id = ? ORDER BY created_at')
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
    `UPDATE pages SET content = ?, content_text = ?, updated_at = datetime('now') WHERE id = ?`
  ).run(combined, combined, page.id);
  ftsUpsert(page.id, page.title, combined);
  logActivity(page.id);
  res.json(db.prepare('SELECT * FROM pages WHERE id = ?').get(page.id));
});

// ---------- Archivos ----------

app.post('/api/files', upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Falta el archivo' });
  const pageId = req.body.page_id || null;
  const f = req.file;
  // multer no decodifica UTF-8 en originalname (llega como latin1)
  const name = Buffer.from(f.originalname, 'latin1').toString('utf8');
  db.prepare('INSERT INTO files (id, page_id, name, mime, size) VALUES (?, ?, ?, ?, ?)').run(
    f.filename,
    pageId,
    name,
    f.mimetype,
    f.size
  );
  res.json({
    id: f.filename,
    name,
    mime: f.mimetype,
    size: f.size,
    url: `/files/${f.filename}/${encodeURIComponent(name)}`,
  });
});

const INLINE_MIME = /^(image|video|audio|text)\/|^application\/pdf$/;

app.get('/files/:id/:name?', (req, res) => {
  const f = db.prepare('SELECT * FROM files WHERE id = ?').get(req.params.id);
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

app.delete('/api/files/:id', (req, res) => {
  const f = db.prepare('SELECT * FROM files WHERE id = ?').get(req.params.id);
  if (!f) return res.status(404).json({ error: 'No encontrado' });
  try {
    fs.unlinkSync(path.join(FILES_DIR, f.id));
  } catch {}
  db.prepare('DELETE FROM files WHERE id = ?').run(f.id);
  res.json({ ok: true });
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
  res.json({ token });
});

app.delete('/api/pages/:id/share', (req, res) => {
  db.prepare('UPDATE pages SET share_token = NULL WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

app.get('/api/share/:token', (req, res) => {
  const page = db
    .prepare('SELECT id, title, icon, content, updated_at FROM pages WHERE share_token = ? AND trashed_at IS NULL')
    .get(req.params.token);
  if (!page) return res.status(404).json({ error: 'Enlace no válido' });
  page.files = db
    .prepare('SELECT id, name, mime, size FROM files WHERE page_id = ? ORDER BY created_at')
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
  const allFiles = db.prepare('SELECT * FROM files').all();
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

purgeOldTrash();
setInterval(purgeOldTrash, 24 * 60 * 60 * 1000).unref();

app.listen(PORT, () => {
  console.log(`NoNotion escuchando en http://localhost:${PORT}`);
});
