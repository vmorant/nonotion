import Database from 'better-sqlite3';
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
  db.prepare('DELETE FROM pages_fts WHERE page_id = ?').run(pageId);
  db.prepare('INSERT INTO pages_fts (page_id, title, body) VALUES (?, ?, ?)').run(pageId, title, body);
}

export function ftsDelete(pageId) {
  db.prepare('DELETE FROM pages_fts WHERE page_id = ?').run(pageId);
}

// Extrae texto plano de un content almacenado (JSON Tiptap o markdown crudo)
export function extractText(content) {
  if (!content) return '';
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
