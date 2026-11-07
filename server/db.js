import Database from 'better-sqlite3';
import crypto from 'crypto';
import { parseCanvas, canvasText } from './canvas.js';
import { parseIdea, ideaText } from './idea.js';
import fs from 'fs';
import path from 'path';

export const DATA_DIR = process.env.DATA_DIR || path.join(process.cwd(), 'data');
export const FILES_DIR = path.join(DATA_DIR, 'files');
fs.mkdirSync(FILES_DIR, { recursive: true });

const db = new Database(path.join(DATA_DIR, 'nonotion.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS pages (
  id TEXT PRIMARY KEY,
  parent_id TEXT REFERENCES pages(id) ON DELETE CASCADE,
  title TEXT NOT NULL DEFAULT '',
  icon TEXT NOT NULL DEFAULT '',
  content TEXT NOT NULL DEFAULT '',
  content_text TEXT NOT NULL DEFAULT '',
  share_token TEXT UNIQUE,
  position INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_pages_parent ON pages(parent_id);

CREATE TABLE IF NOT EXISTS files (
  id TEXT PRIMARY KEY,
  page_id TEXT REFERENCES pages(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  mime TEXT,
  size INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_files_page ON files(page_id);

CREATE VIRTUAL TABLE IF NOT EXISTS pages_fts USING fts5(page_id UNINDEXED, title, body);

CREATE TABLE IF NOT EXISTS versions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  page_id TEXT NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  title TEXT NOT NULL DEFAULT '',
  content TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_versions_page ON versions(page_id, created_at);
`);

// Migración para bases de datos creadas antes de la papelera
const pageCols = db.prepare('PRAGMA table_info(pages)').all().map((c) => c.name);
if (!pageCols.includes('trashed_at')) {
  db.exec('ALTER TABLE pages ADD COLUMN trashed_at TEXT');
}
// Fecha asignada (reuniones, eventos): la página queda fijada a ese día en el calendario
if (!pageCols.includes('page_date')) {
  db.exec('ALTER TABLE pages ADD COLUMN page_date TEXT');
  db.exec('CREATE INDEX IF NOT EXISTS idx_pages_date ON pages(page_date)');
}

// Registro de actividad: una fila por página y día con ediciones
db.exec(`
CREATE TABLE IF NOT EXISTS activity (
  page_id TEXT NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  day TEXT NOT NULL,
  edits INTEGER NOT NULL DEFAULT 1,
  last_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (page_id, day)
);
CREATE INDEX IF NOT EXISTS idx_activity_day ON activity(day);
`);

// Revisión de la página: se incrementa en cada escritura y permite detectar
// que otro dispositivo la cambió entre medias (control de concurrencia)
if (!pageCols.includes('rev')) {
  db.exec('ALTER TABLE pages ADD COLUMN rev INTEGER NOT NULL DEFAULT 0');
}

// Favoritas (fecha en que se marcó, para ordenarlas) y ancho completo por página
if (!pageCols.includes('favorite_at')) {
  db.exec('ALTER TABLE pages ADD COLUMN favorite_at TEXT');
}
if (!pageCols.includes('full_width')) {
  db.exec('ALTER TABLE pages ADD COLUMN full_width INTEGER NOT NULL DEFAULT 0');
}

// Etiquetas: cada página puede tener varias; el nombre no distingue mayúsculas
db.exec(`
CREATE TABLE IF NOT EXISTS tags (
  name TEXT PRIMARY KEY COLLATE NOCASE,
  color TEXT NOT NULL DEFAULT 'gray',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS page_tags (
  page_id TEXT NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  tag TEXT NOT NULL COLLATE NOCASE REFERENCES tags(name) ON DELETE CASCADE ON UPDATE CASCADE,
  PRIMARY KEY (page_id, tag)
);
CREATE INDEX IF NOT EXISTS idx_page_tags_tag ON page_tags(tag);
`);

// Papelera de adjuntos: borrar un archivo lo marca, no lo elimina del disco
const fileCols = db.prepare('PRAGMA table_info(files)').all().map((c) => c.name);
if (!fileCols.includes('deleted_at')) {
  db.exec('ALTER TABLE files ADD COLUMN deleted_at TEXT');
}

// Subidas por trozos en curso (reanudables)
db.exec(`
CREATE TABLE IF NOT EXISTS uploads (
  id TEXT PRIMARY KEY,
  page_id TEXT,
  name TEXT NOT NULL,
  mime TEXT,
  size INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  github_login TEXT NOT NULL,
  github_id INTEGER,
  name TEXT,
  avatar_url TEXT,
  user_agent TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_seen_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT NOT NULL
);
`);

// ---------- Espacios de trabajo (varios proyectos en la misma instancia) ----------
// Cada página, archivo, subida y etiqueta pertenece a un espacio. Los usuarios de
// AUTH_ALLOWED_GITHUB_USERS son propietarios de la instancia y ven todos; el
// resto entra solo en los espacios donde es miembro.
db.exec(`
CREATE TABLE IF NOT EXISTS workspaces (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  icon TEXT NOT NULL DEFAULT '🗂️',
  position INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS workspace_members (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  github_login TEXT NOT NULL COLLATE NOCASE,
  role TEXT NOT NULL DEFAULT 'editor',
  added_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (workspace_id, github_login)
);
-- Tokens del conector de Claude / scripts: cada uno da acceso a UN espacio
CREATE TABLE IF NOT EXISTS api_tokens (
  token TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  github_login TEXT COLLATE NOCASE,
  label TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_used_at TEXT
);
-- Favoritas por persona
CREATE TABLE IF NOT EXISTS favorites (
  github_login TEXT NOT NULL COLLATE NOCASE,
  page_id TEXT NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (github_login, page_id)
);
`);

export const instanceOwners = () =>
  (process.env.AUTH_ALLOWED_GITHUB_USERS || '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);

let defaultWs = db.prepare('SELECT id FROM workspaces ORDER BY position, created_at LIMIT 1').get()?.id;
if (!defaultWs) {
  defaultWs = 'ws_' + crypto.randomBytes(6).toString('hex');
  db.prepare('INSERT INTO workspaces (id, name, icon, position) VALUES (?, ?, ?, 0)').run(
    defaultWs,
    (process.env.DEFAULT_WORKSPACE_NAME || 'Principal').trim() || 'Principal',
    '🗂️'
  );
}

const colsOf = (table) => db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
for (const table of ['pages', 'files', 'uploads']) {
  if (!colsOf(table).includes('workspace_id')) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN workspace_id TEXT`);
  }
}
db.exec(`
CREATE INDEX IF NOT EXISTS idx_pages_ws ON pages(workspace_id);
CREATE INDEX IF NOT EXISTS idx_files_ws ON files(workspace_id);
`);
// Lo existente pasa al espacio inicial; los archivos y subidas, al de su página
db.prepare('UPDATE pages SET workspace_id = ? WHERE workspace_id IS NULL').run(defaultWs);
db.prepare(
  `UPDATE files SET workspace_id = COALESCE((SELECT workspace_id FROM pages WHERE pages.id = files.page_id), ?)
   WHERE workspace_id IS NULL`
).run(defaultWs);
db.prepare(
  `UPDATE uploads SET workspace_id = COALESCE((SELECT workspace_id FROM pages WHERE pages.id = uploads.page_id), ?)
   WHERE workspace_id IS NULL`
).run(defaultWs);

// Favoritas: de la columna global a favoritas por persona (las de los propietarios)
if (colsOf('pages').includes('favorite_at')) {
  const owners = instanceOwners();
  const logins = owners.length ? owners : ['local'];
  const ins = db.prepare('INSERT OR IGNORE INTO favorites (github_login, page_id, created_at) VALUES (?, ?, ?)');
  db.transaction(() => {
    for (const f of db.prepare('SELECT id, favorite_at FROM pages WHERE favorite_at IS NOT NULL').all()) {
      for (const login of logins) ins.run(login, f.id, f.favorite_at);
    }
    db.prepare('UPDATE pages SET favorite_at = NULL WHERE favorite_at IS NOT NULL').run();
  })();
}

// Etiquetas por espacio: se reconstruyen las tablas con workspace_id
if (!colsOf('tags').includes('workspace_id')) {
  db.pragma('foreign_keys = OFF');
  db.transaction(() => {
    db.exec(`
      CREATE TABLE tags_new (
        workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        name TEXT NOT NULL COLLATE NOCASE,
        color TEXT NOT NULL DEFAULT 'gray',
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        PRIMARY KEY (workspace_id, name)
      );
      CREATE TABLE page_tags_new (
        page_id TEXT NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
        workspace_id TEXT NOT NULL,
        tag TEXT NOT NULL COLLATE NOCASE,
        PRIMARY KEY (page_id, tag),
        FOREIGN KEY (workspace_id, tag) REFERENCES tags_new(workspace_id, name) ON DELETE CASCADE ON UPDATE CASCADE
      );
    `);
    db.prepare('INSERT INTO tags_new (workspace_id, name, color, created_at) SELECT ?, name, color, created_at FROM tags').run(defaultWs);
    db.exec(`
      INSERT INTO page_tags_new (page_id, workspace_id, tag)
        SELECT pt.page_id, p.workspace_id, pt.tag FROM page_tags pt JOIN pages p ON p.id = pt.page_id;
      -- una etiqueta usada en páginas de otro espacio (no ocurre al migrar, pero por si acaso)
      INSERT OR IGNORE INTO tags_new (workspace_id, name, color)
        SELECT DISTINCT workspace_id, tag, 'gray' FROM page_tags_new;
      DROP TABLE page_tags;
      DROP TABLE tags;
      ALTER TABLE tags_new RENAME TO tags;
      ALTER TABLE page_tags_new RENAME TO page_tags;
      CREATE INDEX IF NOT EXISTS idx_page_tags_tag ON page_tags(workspace_id, tag);
    `);
    const broken = db.pragma('foreign_key_check');
    if (broken.length) throw new Error(`Migración de etiquetas: ${broken.length} referencias rotas`);
  })();
  db.pragma('foreign_keys = ON');
}

export const DEFAULT_WORKSPACE = defaultWs;

// Tipo de página: 'doc' (editor) o 'canvas' (JSON Canvas, como en Obsidian)
if (!colsOf('pages').includes('kind')) {
  db.exec(`ALTER TABLE pages ADD COLUMN kind TEXT NOT NULL DEFAULT 'doc'`);
}

// Backfill inicial: reconstruye actividad pasada desde el historial de
// versiones y la última modificación de cada página
if (!db.prepare('SELECT 1 FROM activity LIMIT 1').get()) {
  db.exec(`
    INSERT OR IGNORE INTO activity (page_id, day, edits, last_at)
    SELECT page_id, date(created_at, 'localtime'), 1, created_at FROM versions;
    INSERT OR IGNORE INTO activity (page_id, day, edits, last_at)
    SELECT id, date(updated_at, 'localtime'), 1, updated_at FROM pages
    WHERE updated_at != created_at;
  `);
}

export function logActivity(pageId) {
  db.prepare(
    `INSERT INTO activity (page_id, day) VALUES (?, date('now', 'localtime'))
     ON CONFLICT(page_id, day) DO UPDATE SET edits = edits + 1, last_at = datetime('now')`
  ).run(pageId);
}

export function ftsUpsert(pageId, title, body) {
  // Elementos de seguimiento: su clave (AXA-12) también se busca
  try {
    const k = db
      .prepare('SELECT i.number, t.prefix AS p FROM issues i JOIN trackers t ON t.page_id = i.tracker_id WHERE i.page_id = ?')
      .get(pageId);
    if (k?.p && !String(title || '').startsWith(`${k.p}-${k.number} `)) title = `${k.p}-${k.number} ${title || ''}`;
  } catch {} // antes de crear la tabla de elementos
  db.prepare('DELETE FROM pages_fts WHERE page_id = ?').run(pageId);
  db.prepare('INSERT INTO pages_fts (page_id, title, body) VALUES (?, ?, ?)').run(pageId, title, body);
}

export function ftsDelete(pageId) {
  db.prepare('DELETE FROM pages_fts WHERE page_id = ?').run(pageId);
}

// Extrae texto plano de un content almacenado (JSON Tiptap o markdown crudo)
export function extractText(content) {
  if (!content) return '';
  if (parseIdea(content)) return ideaText(content);
  if (parseCanvas(content)) return canvasText(content);
  if (typeof content === 'string' && !content.startsWith('{')) return content;
  let doc = content;
  if (typeof doc === 'string') {
    try {
      doc = JSON.parse(doc);
    } catch {
      return content;
    }
  }
  const parts = [];
  const walk = (node) => {
    if (!node || typeof node !== 'object') return;
    if (node.type === 'text' && node.text) parts.push(node.text);
    if (Array.isArray(node.content)) {
      node.content.forEach(walk);
      parts.push('\n');
    }
  };
  walk(doc);
  return parts.join(' ').replace(/\s+\n/g, '\n').trim();
}

export default db;
