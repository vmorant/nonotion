import express from 'express';
import path from 'path';
import fs from 'fs';
import multer from 'multer';
import { nanoid } from 'nanoid';
import { fileURLToPath } from 'url';
import db, { FILES_DIR, ftsUpsert, ftsDelete } from './db.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3000;

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '100mb' }));

const upload = multer({
  storage: multer.diskStorage({
    destination: FILES_DIR,
    filename: (req, file, cb) => cb(null, nanoid(21)),
  }),
});

// ---------- Identidad (Cloudflare Access) ----------

app.get('/api/me', (req, res) => {
  res.json({ email: req.headers['cf-access-authenticated-user-email'] || null });
});

// ---------- Páginas ----------

app.get('/api/pages', (req, res) => {
  const rows = db
    .prepare(
      `SELECT id, parent_id, title, icon, position, updated_at,
              share_token IS NOT NULL AS shared
       FROM pages ORDER BY position, created_at`
    )
    .all();
  res.json(rows);
});

app.post('/api/pages', (req, res) => {
  const { parent_id = null, title = '' } = req.body || {};
  const id = nanoid(12);
  const pos = db
    .prepare('SELECT COALESCE(MAX(position) + 1, 0) AS p FROM pages WHERE parent_id IS ?')
    .get(parent_id).p;
  db.prepare('INSERT INTO pages (id, parent_id, title, position) VALUES (?, ?, ?, ?)').run(
    id,
    parent_id,
    title,
    pos
  );
  ftsUpsert(id, title, '');
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

function isDescendant(candidateId, ancestorId) {
  const rows = db
    .prepare(
      `WITH RECURSIVE sub(id) AS (
         SELECT id FROM pages WHERE id = ?
         UNION ALL
         SELECT p.id FROM pages p JOIN sub s ON p.parent_id = s.id
       ) SELECT id FROM sub`
    )
    .all(ancestorId);
  return rows.some((r) => r.id === candidateId);
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

  const sets = Object.keys(fields).map((k) => `${k} = ?`).join(', ');
  db.prepare(`UPDATE pages SET ${sets}, updated_at = datetime('now') WHERE id = ?`).run(
    ...Object.values(fields),
    page.id
  );

  const updated = db.prepare('SELECT * FROM pages WHERE id = ?').get(page.id);
  if (fields.title !== undefined || fields.content_text !== undefined) {
    ftsUpsert(page.id, updated.title, updated.content_text);
  }
  res.json(updated);
});

app.delete('/api/pages/:id', (req, res) => {
  const page = db.prepare('SELECT id FROM pages WHERE id = ?').get(req.params.id);
  if (!page) return res.status(404).json({ error: 'Página no encontrada' });

  const subtree = db
    .prepare(
      `WITH RECURSIVE sub(id) AS (
         SELECT id FROM pages WHERE id = ?
         UNION ALL
         SELECT p.id FROM pages p JOIN sub s ON p.parent_id = s.id
       ) SELECT id FROM sub`
    )
    .all(page.id)
    .map((r) => r.id);

  const placeholders = subtree.map(() => '?').join(',');
  const fileRows = db.prepare(`SELECT id FROM files WHERE page_id IN (${placeholders})`).all(...subtree);
  for (const f of fileRows) {
    try {
      fs.unlinkSync(path.join(FILES_DIR, f.id));
    } catch {}
  }
  db.prepare('DELETE FROM pages WHERE id = ?').run(page.id); // cascada borra hijos y filas de files
  for (const id of subtree) ftsDelete(id);
  res.json({ ok: true, deleted: subtree.length });
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
         WHERE pages_fts MATCH ?
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
    .prepare('SELECT id, title, icon, content, updated_at FROM pages WHERE share_token = ?')
    .get(req.params.token);
  if (!page) return res.status(404).json({ error: 'Enlace no válido' });
  page.files = db
    .prepare('SELECT id, name, mime, size FROM files WHERE page_id = ? ORDER BY created_at')
    .all(page.id);
  res.json(page);
});

// ---------- Frontend estático (producción) ----------

const dist = path.join(__dirname, '..', 'client', 'dist');
if (fs.existsSync(dist)) {
  app.use(express.static(dist));
  app.get(/^(?!\/api\/|\/files\/).*/, (req, res) => {
    res.sendFile(path.join(dist, 'index.html'));
  });
}

app.listen(PORT, () => {
  console.log(`NoNotion escuchando en http://localhost:${PORT}`);
});
