// Etiquetas de páginas: clasificar y filtrar. No son contenido, así que
// asignarlas no cambia la revisión de la página ni crea versiones.
import db from './db.js';

export const TAG_COLORS = ['gray', 'red', 'orange', 'yellow', 'green', 'teal', 'blue', 'purple', 'pink'];
const MAX_TAG_LENGTH = 40;
const SEP = '\u001f';

// "#Cliente AXA " → "cliente axa"; null si no queda nada válido. Siempre en
// minúsculas: "Pegasus" y "pegasus" son la misma etiqueta al guardar, al
// comparar y al quitar (también con acentos y eñes, que NOCASE de SQLite no pliega)
export function normalizeTag(raw) {
  if (typeof raw !== 'string') return null;
  const t = raw
    .replace(/^#+/, '')
    .replace(/[,\u001f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
    .slice(0, MAX_TAG_LENGTH);
  return t || null;
}

// Renombra una etiqueta del espacio también en sus páginas. No basta con ON
// UPDATE CASCADE: si solo cambian mayúsculas (Riesgos → riesgos), SQLite
// compara con NOCASE, da la clave por igual y no propaga el cambio.
function renameTag(ws, from, to) {
  db.prepare('UPDATE tags SET name = ? WHERE workspace_id = ? AND name = ?').run(to, ws, from);
  db.prepare('UPDATE page_tags SET tag = ? WHERE workspace_id = ? AND tag = ?').run(to, ws, from);
}

// Migración: todas las etiquetas a minúsculas. Si dos solo difieren en
// mayúsculas (p. ej. "Ñandú" y "ñandú"), se fusionan en una: sus páginas pasan
// a la que queda y se conserva el color de la más antigua. Idempotente.
export function lowercaseTags() {
  const rows = db.prepare('SELECT workspace_id, name, color, created_at FROM tags ORDER BY created_at, rowid').all();
  const groups = new Map();
  for (const t of rows) {
    const key = `${t.workspace_id}\u001f${normalizeTag(t.name) || t.name}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(t);
  }
  let renamed = 0;
  let merged = 0;
  db.transaction(() => {
    for (const [key, list] of groups) {
      const target = key.split('\u001f')[1];
      if (list.length === 1 && list[0].name === target) continue;
      const [keep, ...dups] = list;
      for (const d of dups) {
        // las páginas de la duplicada pasan a la que se queda (sin repetirse)
        db.prepare(
          `INSERT OR IGNORE INTO page_tags (page_id, workspace_id, tag)
           SELECT page_id, workspace_id, ? FROM page_tags WHERE workspace_id = ? AND tag = ?`
        ).run(keep.name, d.workspace_id, d.name);
        db.prepare('DELETE FROM tags WHERE workspace_id = ? AND name = ?').run(d.workspace_id, d.name);
        merged++;
      }
      if (keep.name !== target) {
        renameTag(keep.workspace_id, keep.name, target);
        renamed++;
      }
    }
  })();
  if (renamed || merged) console.log(`Etiquetas a minúsculas: ${renamed} renombradas, ${merged} fusionadas`);
  return { renamed, merged };
}

// Color estable a partir del nombre, para que una etiqueta nueva no sea siempre gris
function colorFor(name) {
  let h = 0;
  for (const ch of name.toLowerCase()) h = (h * 31 + ch.codePointAt(0)) >>> 0;
  return TAG_COLORS[1 + (h % (TAG_COLORS.length - 1))];
}

// Las etiquetas son de cada espacio: "Riesgos" en AXA y en otro proyecto son
// etiquetas distintas
const insertTag = db.prepare('INSERT OR IGNORE INTO tags (workspace_id, name, color) VALUES (?, ?, ?)');
const selectTag = db.prepare('SELECT name, color FROM tags WHERE workspace_id = ? AND name = ?');

// Devuelve el nombre canónico (el de la primera vez que se creó)
function ensureTag(ws, name) {
  insertTag.run(ws, name, colorFor(name));
  return selectTag.get(ws, name).name;
}

export function tagsOf(pageId) {
  return db
    .prepare('SELECT tag FROM page_tags WHERE page_id = ?')
    .all(pageId)
    .map((r) => r.tag)
    .sort((a, b) => a.localeCompare(b, 'es')); // igual que splitTags (ñ entre n y o)
}

// Columna SQL con las etiquetas de cada página (para listados)
export const TAGS_COLUMN = `(SELECT group_concat(tag, char(31)) FROM page_tags WHERE page_id = pages.id) AS tags`;
export const splitTags = (v) => (v ? String(v).split(SEP).sort((a, b) => a.localeCompare(b, 'es')) : []);

export const setPageTags = db.transaction((pageId, ws, list) => {
  const wanted = [];
  for (const raw of list) {
    const n = normalizeTag(raw);
    if (n && !wanted.some((w) => w.toLowerCase() === n.toLowerCase())) wanted.push(ensureTag(ws, n));
  }
  const current = tagsOf(pageId);
  const del = db.prepare('DELETE FROM page_tags WHERE page_id = ? AND tag = ?');
  for (const t of current) if (!wanted.some((w) => w.toLowerCase() === t.toLowerCase())) del.run(pageId, t);
  const add = db.prepare('INSERT OR IGNORE INTO page_tags (page_id, workspace_id, tag) VALUES (?, ?, ?)');
  for (const t of wanted) add.run(pageId, ws, t);
  return tagsOf(pageId);
});

export function copyTags(fromId, toId) {
  db.prepare(
    'INSERT OR IGNORE INTO page_tags (page_id, workspace_id, tag) SELECT ?, workspace_id, tag FROM page_tags WHERE page_id = ?'
  ).run(toId, fromId);
}

// Ids de páginas (no borradas) del espacio con todas (all) o alguna (any) de las etiquetas
export function pagesWithTags(ws, tags, mode = 'all') {
  const list = tags.map(normalizeTag).filter(Boolean);
  if (!list.length) return null;
  const marks = list.map(() => '?').join(', ');
  const having = mode === 'any' ? '' : `HAVING COUNT(DISTINCT pt.tag) = ${list.length}`;
  return db
    .prepare(
      `SELECT pt.page_id AS id FROM page_tags pt JOIN pages p ON p.id = pt.page_id
       WHERE p.trashed_at IS NULL AND p.workspace_id = ? AND pt.workspace_id = ? AND pt.tag IN (${marks})
       GROUP BY pt.page_id ${having}`
    )
    .all(ws, ws, ...list)
    .map((r) => r.id);
}

export function listTags(ws) {
  return db
    .prepare(
      `SELECT t.name, t.color, COUNT(p.id) AS count
       FROM tags t
       LEFT JOIN page_tags pt ON pt.workspace_id = t.workspace_id AND pt.tag = t.name
       LEFT JOIN pages p ON p.id = pt.page_id AND p.trashed_at IS NULL
       WHERE t.workspace_id = ?
       GROUP BY t.name ORDER BY t.name COLLATE NOCASE`
    )
    .all(ws);
}

export function mountTags(app, { notifyTree }) {
  // req.ws lo fija el guardián de espacios (workspaces.js)
  app.get('/api/tags', (req, res) => res.json(listTags(req.ws)));

  app.put('/api/pages/:id/tags', (req, res) => {
    if (!db.prepare('SELECT 1 FROM pages WHERE id = ? AND workspace_id = ?').get(req.params.id, req.ws)) {
      return res.status(404).json({ error: 'Página no encontrada' });
    }
    const list = Array.isArray(req.body?.tags) ? req.body.tags : [];
    const tags = setPageTags(req.params.id, req.ws, list);
    notifyTree(req);
    res.json({ tags });
  });

  // Cambiar color o renombrar (si el nombre nuevo ya existe, se fusionan)
  app.patch('/api/tags/:name', (req, res) => {
    const ws = req.ws;
    const tag = selectTag.get(ws, req.params.name);
    if (!tag) return res.status(404).json({ error: 'Etiqueta no encontrada' });
    const { color, name } = req.body || {};
    if (typeof color === 'string') {
      if (!TAG_COLORS.includes(color)) return res.status(400).json({ error: 'Color no válido' });
      db.prepare('UPDATE tags SET color = ? WHERE workspace_id = ? AND name = ?').run(color, ws, tag.name);
    }
    let finalName = tag.name;
    if (name !== undefined) {
      const n = normalizeTag(name);
      if (!n) return res.status(400).json({ error: 'Nombre no válido' });
      const existing = selectTag.get(ws, n);
      db.transaction(() => {
        if (existing && existing.name.toLowerCase() !== tag.name.toLowerCase()) {
          db.prepare(
            `INSERT OR IGNORE INTO page_tags (page_id, workspace_id, tag)
             SELECT page_id, workspace_id, ? FROM page_tags WHERE workspace_id = ? AND tag = ?`
          ).run(existing.name, ws, tag.name);
          db.prepare('DELETE FROM tags WHERE workspace_id = ? AND name = ?').run(ws, tag.name);
          finalName = existing.name;
        } else {
          renameTag(ws, tag.name, n);
          finalName = n;
        }
      })();
    }
    notifyTree(req);
    res.json(selectTag.get(ws, finalName));
  });

  app.delete('/api/tags/:name', (req, res) => {
    db.prepare('DELETE FROM tags WHERE workspace_id = ? AND name = ?').run(req.ws, req.params.name);
    notifyTree(req);
    res.json({ ok: true });
  });

  // Filtro: páginas con las etiquetas pedidas y sus adjuntos
  app.get('/api/tagged', (req, res) => {
    const tags = String(req.query.tags || '').split(',').filter(Boolean);
    const mode = req.query.mode === 'any' ? 'any' : 'all';
    const ids = pagesWithTags(req.ws, tags, mode);
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
