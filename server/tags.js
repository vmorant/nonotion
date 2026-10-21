// Etiquetas de páginas: clasificar y filtrar. No son contenido, así que
// asignarlas no cambia la revisión de la página ni crea versiones.
import db from './db.js';

export const TAG_COLORS = ['gray', 'red', 'orange', 'yellow', 'green', 'teal', 'blue', 'purple', 'pink'];
const MAX_TAG_LENGTH = 40;
const SEP = '\u001f';

// "#Cliente AXA " → "Cliente AXA"; null si no queda nada válido
export function normalizeTag(raw) {
  if (typeof raw !== 'string') return null;
  const t = raw.replace(/^#+/, '').replace(/[,\u001f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, MAX_TAG_LENGTH);
  return t || null;
}

// Color estable a partir del nombre, para que una etiqueta nueva no sea siempre gris
function colorFor(name) {
  let h = 0;
  for (const ch of name.toLowerCase()) h = (h * 31 + ch.codePointAt(0)) >>> 0;
  return TAG_COLORS[1 + (h % (TAG_COLORS.length - 1))];
}

const insertTag = db.prepare('INSERT OR IGNORE INTO tags (name, color) VALUES (?, ?)');
const selectTag = db.prepare('SELECT name, color FROM tags WHERE name = ?');

// Devuelve el nombre canónico (el de la primera vez que se creó)
function ensureTag(name) {
  insertTag.run(name, colorFor(name));
  return selectTag.get(name).name;
}

export function tagsOf(pageId) {
  return db
    .prepare('SELECT tag FROM page_tags WHERE page_id = ? ORDER BY tag COLLATE NOCASE')
    .all(pageId)
    .map((r) => r.tag);
}

// Columna SQL con las etiquetas de cada página (para listados)
export const TAGS_COLUMN = `(SELECT group_concat(tag, char(31)) FROM page_tags WHERE page_id = pages.id) AS tags`;
export const splitTags = (v) => (v ? String(v).split(SEP).sort((a, b) => a.localeCompare(b, 'es')) : []);

export const setPageTags = db.transaction((pageId, list) => {
  const wanted = [];
  for (const raw of list) {
    const n = normalizeTag(raw);
    if (n && !wanted.some((w) => w.toLowerCase() === n.toLowerCase())) wanted.push(ensureTag(n));
  }
  const current = tagsOf(pageId);
  const del = db.prepare('DELETE FROM page_tags WHERE page_id = ? AND tag = ?');
  for (const t of current) if (!wanted.some((w) => w.toLowerCase() === t.toLowerCase())) del.run(pageId, t);
  const add = db.prepare('INSERT OR IGNORE INTO page_tags (page_id, tag) VALUES (?, ?)');
  for (const t of wanted) add.run(pageId, t);
  return tagsOf(pageId);
});

export function addPageTags(pageId, add = [], remove = []) {
  const rm = new Set(remove.map((t) => normalizeTag(t)?.toLowerCase()).filter(Boolean));
  const next = tagsOf(pageId).filter((t) => !rm.has(t.toLowerCase()));
  return setPageTags(pageId, [...next, ...add]);
}

export function copyTags(fromId, toId) {
  db.prepare('INSERT OR IGNORE INTO page_tags (page_id, tag) SELECT ?, tag FROM page_tags WHERE page_id = ?').run(toId, fromId);
}

// Ids de páginas (no borradas) con todas (all) o alguna (any) de las etiquetas
export function pagesWithTags(tags, mode = 'all') {
  const list = tags.map(normalizeTag).filter(Boolean);
  if (!list.length) return null;
  const marks = list.map(() => '?').join(', ');
  const having = mode === 'any' ? '' : `HAVING COUNT(DISTINCT pt.tag) = ${list.length}`;
  return db
    .prepare(
      `SELECT pt.page_id AS id FROM page_tags pt JOIN pages p ON p.id = pt.page_id
       WHERE p.trashed_at IS NULL AND pt.tag IN (${marks})
       GROUP BY pt.page_id ${having}`
    )
    .all(...list)
    .map((r) => r.id);
}

export function listTags() {
  return db
    .prepare(
      `SELECT t.name, t.color, COUNT(p.id) AS count
       FROM tags t
       LEFT JOIN page_tags pt ON pt.tag = t.name
       LEFT JOIN pages p ON p.id = pt.page_id AND p.trashed_at IS NULL
       GROUP BY t.name ORDER BY t.name COLLATE NOCASE`
    )
    .all();
}

export function mountTags(app, { notifyTree }) {
  app.get('/api/tags', (req, res) => res.json(listTags()));

  app.put('/api/pages/:id/tags', (req, res) => {
    if (!db.prepare('SELECT 1 FROM pages WHERE id = ?').get(req.params.id)) {
      return res.status(404).json({ error: 'Página no encontrada' });
    }
    const list = Array.isArray(req.body?.tags) ? req.body.tags : [];
    const tags = setPageTags(req.params.id, list);
    notifyTree(req);
    res.json({ tags });
  });

  // Cambiar color o renombrar (si el nombre nuevo ya existe, se fusionan)
  app.patch('/api/tags/:name', (req, res) => {
    const tag = selectTag.get(req.params.name);
    if (!tag) return res.status(404).json({ error: 'Etiqueta no encontrada' });
    const { color, name } = req.body || {};
    if (typeof color === 'string') {
      if (!TAG_COLORS.includes(color)) return res.status(400).json({ error: 'Color no válido' });
      db.prepare('UPDATE tags SET color = ? WHERE name = ?').run(color, tag.name);
    }
    let finalName = tag.name;
    if (name !== undefined) {
      const n = normalizeTag(name);
      if (!n) return res.status(400).json({ error: 'Nombre no válido' });
      const existing = selectTag.get(n);
      db.transaction(() => {
        if (existing && existing.name.toLowerCase() !== tag.name.toLowerCase()) {
          db.prepare(
            `INSERT OR IGNORE INTO page_tags (page_id, tag) SELECT page_id, ? FROM page_tags WHERE tag = ?`
          ).run(existing.name, tag.name);
          db.prepare('DELETE FROM tags WHERE name = ?').run(tag.name);
          finalName = existing.name;
        } else {
          // ON UPDATE CASCADE renombra también en page_tags
          db.prepare('UPDATE tags SET name = ? WHERE name = ?').run(n, tag.name);
          finalName = n;
        }
      })();
    }
    notifyTree(req);
    res.json(db.prepare('SELECT name, color FROM tags WHERE name = ?').get(finalName));
  });

  app.delete('/api/tags/:name', (req, res) => {
    db.prepare('DELETE FROM tags WHERE name = ?').run(req.params.name);
    notifyTree(req);
    res.json({ ok: true });
  });

  // Filtro: páginas con las etiquetas pedidas y sus adjuntos
  app.get('/api/tagged', (req, res) => {
    const tags = String(req.query.tags || '').split(',').filter(Boolean);
    const mode = req.query.mode === 'any' ? 'any' : 'all';
    const ids = pagesWithTags(tags, mode);
    if (!ids || !ids.length) return res.json({ pages: [], files: [] });
    const marks = ids.map(() => '?').join(', ');
    const pages = db
      .prepare(
        `SELECT id, parent_id, title, icon, updated_at, page_date, ${TAGS_COLUMN}
         FROM pages WHERE id IN (${marks}) ORDER BY updated_at DESC`
      )
      .all(...ids)
      .map((p) => ({ ...p, tags: splitTags(p.tags) }));
    const files = db
      .prepare(
        `SELECT id, page_id, name, mime, size, created_at FROM files
         WHERE page_id IN (${marks}) AND deleted_at IS NULL ORDER BY created_at DESC`
      )
      .all(...ids);
    res.json({ pages, files });
  });
}
