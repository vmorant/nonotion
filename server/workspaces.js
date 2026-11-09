// Espacios de trabajo y control de acceso.
//
// Regla única: todo recurso (página, archivo, versión, subida, etiqueta) es de un
// espacio, y una petición solo ve los recursos de los espacios a los que su
// usuario (o su token) tiene acceso. El guardián `workspaceGuard` se monta
// ANTES de todas las rutas: resuelve el espacio de lo que se pide y corta con
// 404 (como si no existiera) lo ajeno. Las rutas solo consultan `req.ws`.
import crypto from 'crypto';
import db, { DEFAULT_WORKSPACE, instanceOwners } from './db.js';

// viewer: solo lectura · editor: lee y escribe · admin: además gestiona el espacio
export const ROLES = ['admin', 'editor', 'viewer'];
const RANK = { viewer: 1, editor: 2, admin: 3 };
export const atLeast = (role, min) => (RANK[role] || 0) >= (RANK[min] || 99);
const ID = '[A-Za-z0-9_-]+';

// ---------- Identidad ----------

// Modo de autenticación ('github' | 'off' | 'misconfigured'); lo fija setupAuth
let authMode = 'off';
export const setAuthMode = (mode) => {
  authMode = mode;
};

// Login de la petición: el de la sesión, el dueño del token (null si es el
// token general) o 'local' cuando no hay login de GitHub
export function loginOf(req) {
  if (req.authKind === 'token') return req.tokenLogin || null;
  if (req.authKind === 'session') return req.user.login;
  return authMode === 'off' ? 'local' : null;
}

export function isOwner(req) {
  if (req.authKind === 'token') return false;
  if (req.authKind === 'session') return instanceOwners().includes(String(req.user.login).toLowerCase());
  // Sin login de GitHub (local / solo Cloudflare Access) hay una única persona;
  // con login activo, una petición anónima nunca es propietaria
  return authMode === 'off';
}

// ---------- Cuenta de GitHub detrás de cada nombre ----------
// Los accesos se dan por nombre de GitHub, pero un nombre puede cambiar de dueño
// (renombrado o cuenta borrada). Cada nombre queda atado al id numérico de la
// cuenta que lo usó (o que se resolvió al añadirla): otra cuenta con el mismo
// nombre no entra.
db.exec(`CREATE TABLE IF NOT EXISTS github_identities (
  github_login TEXT PRIMARY KEY COLLATE NOCASE,
  github_id INTEGER NOT NULL,
  bound_at TEXT NOT NULL DEFAULT (datetime('now'))
)`);
// Las sesiones abiertas antes de esto ya traían el id: se toma de la más reciente
db.exec(`INSERT OR IGNORE INTO github_identities (github_login, github_id)
  SELECT github_login, github_id FROM sessions WHERE github_id IS NOT NULL ORDER BY created_at DESC`);

// Primer login de un nombre: se ata a esa cuenta. Después, solo esa cuenta.
export function bindIdentity(login, githubId) {
  const row = db.prepare('SELECT github_id FROM github_identities WHERE github_login = ?').get(login);
  if (row) return row.github_id === githubId;
  db.prepare('INSERT INTO github_identities (github_login, github_id) VALUES (?, ?)').run(login, githubId);
  return true;
}

// En cada petición con sesión: la sesión debe ser de la cuenta atada a ese
// nombre (si aún no hay ninguna atada, se ata a esta)
export function identityMatches(login, githubId) {
  if (githubId == null) return true; // sesiones antiguas sin id
  return bindIdentity(login, githubId);
}

// Al añadir a alguien, se comprueba en GitHub que la cuenta existe y se ata su id.
// Sin red no se bloquea: se atará en su primer login.
async function resolveGithubAccount(login) {
  if (process.env.GITHUB_LOOKUP === 'off') return { ok: true };
  try {
    const r = await fetch(`https://api.github.com/users/${encodeURIComponent(login)}`, {
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'nonotion' },
      signal: AbortSignal.timeout(6000),
    });
    if (r.status === 404) return { ok: false };
    if (!r.ok) return { ok: true };
    const u = await r.json();
    return Number.isInteger(u.id) ? { ok: true, id: u.id, login: u.login, name: u.name || null } : { ok: true };
  } catch {
    return { ok: true };
  }
}

// ¿Puede entrar esta cuenta de GitHub en la instancia? (propietaria o miembro de algún espacio)
export function loginAllowed(login) {
  const l = String(login || '').toLowerCase();
  if (!l) return false;
  if (instanceOwners().includes(l)) return true;
  return Boolean(db.prepare('SELECT 1 FROM workspace_members WHERE github_login = ? LIMIT 1').get(l));
}

// Rol en un espacio: 'admin' | 'editor' | null
export function roleIn(req, wsId) {
  if (!wsId) return null;
  if (req.authKind === 'token') return req.tokenWs === wsId ? 'editor' : null;
  if (isOwner(req)) return db.prepare('SELECT 1 FROM workspaces WHERE id = ?').get(wsId) ? 'admin' : null;
  if (req.authKind !== 'session') return null;
  const row = db
    .prepare('SELECT role FROM workspace_members WHERE workspace_id = ? AND github_login = ?')
    .get(wsId, req.user.login);
  return row?.role || null;
}

export function accessibleWorkspaces(req) {
  if (req.authKind === 'token') {
    return db.prepare(`SELECT *, 'editor' AS role FROM workspaces WHERE id = ?`).all(req.tokenWs);
  }
  if (isOwner(req)) {
    return db.prepare(`SELECT *, 'admin' AS role FROM workspaces ORDER BY position, created_at`).all();
  }
  if (req.authKind !== 'session') return [];
  return db
    .prepare(
      `SELECT w.*, m.role FROM workspaces w JOIN workspace_members m ON m.workspace_id = w.id
       WHERE m.github_login = ? ORDER BY w.position, w.created_at`
    )
    .all(req.user.login);
}

// ---------- Tokens (conector de Claude, scripts) ----------

const newToken = () => crypto.randomBytes(24).toString('base64url');

// En la base de datos (y por tanto en las copias de seguridad) solo se guarda el
// hash del token: quien lea una copia no puede usarlo. Se enseña entero una sola
// vez, al crearlo. La columna `token` guarda 'sha256:<hex>' y `prefix` sus 6
// primeros caracteres, que sirven para reconocerlo y revocarlo.
const HASHED = 'sha256:';
const tokenHash = (t) => HASHED + crypto.createHash('sha256').update(t).digest('hex');
{
  const cols = db.prepare('PRAGMA table_info(api_tokens)').all().map((c) => c.name);
  if (!cols.includes('prefix')) db.exec('ALTER TABLE api_tokens ADD COLUMN prefix TEXT');
}
function hashLegacyTokens() {
  const rows = db.prepare(`SELECT token FROM api_tokens WHERE token NOT LIKE '${HASHED}%'`).all();
  const upd = db.prepare('UPDATE api_tokens SET token = ?, prefix = ? WHERE token = ?');
  db.transaction(() => {
    for (const r of rows) upd.run(tokenHash(r.token), r.token.slice(0, 6), r.token);
  })();
}
hashLegacyTokens();

// Un token vale si su espacio existe y su dueño sigue teniendo acceso a él
export function lookupToken(token) {
  if (!token || typeof token !== 'string' || token.length < 16 || token.length > 200) return null;
  let row = db.prepare('SELECT * FROM api_tokens WHERE token = ?').get(tokenHash(token));
  if (!row) {
    // Un token insertado en claro por fuera (scripts antiguos): se pasa a hash al usarlo
    const plain = db.prepare('SELECT 1 FROM api_tokens WHERE token = ?').get(token);
    if (!plain || token.startsWith(HASHED)) return null;
    hashLegacyTokens();
    row = db.prepare('SELECT * FROM api_tokens WHERE token = ?').get(tokenHash(token));
    if (!row) return null;
  }
  if (row.github_login) {
    const l = row.github_login.toLowerCase();
    const member = db
      .prepare('SELECT 1 FROM workspace_members WHERE workspace_id = ? AND github_login = ?')
      .get(row.workspace_id, l);
    if (!member && !instanceOwners().includes(l)) return null;
  }
  db.prepare(
    `UPDATE api_tokens SET last_used_at = datetime('now')
     WHERE token = ? AND (last_used_at IS NULL OR last_used_at < datetime('now', '-10 minutes'))`
  ).run(row.token);
  return row;
}

export function createToken(wsId, login, label) {
  const token = newToken();
  db.prepare('INSERT INTO api_tokens (token, prefix, workspace_id, github_login, label) VALUES (?, ?, ?, ?, ?)').run(
    tokenHash(token),
    token.slice(0, 6),
    wsId,
    login || null,
    label || null
  );
  return token;
}

// El token histórico (archivo mcp_token) queda como token del espacio inicial:
// el conector de Claude que ya estaba configurado sigue funcionando igual
// Se adopta UNA sola vez: si después se revoca desde Ajustes, no vuelve a
// aparecer al reiniciar (antes se reinsertaba en cada arranque).
// Espacio del token histórico (para el aviso del arranque)
export const tokenWorkspaceName = (token) =>
  db.prepare('SELECT w.name FROM api_tokens t JOIN workspaces w ON w.id = t.workspace_id WHERE t.token = ?').get(tokenHash(token))?.name;

export function adoptLegacyToken(token) {
  if (!token) return;
  db.exec(`CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT)`);
  const done = db.prepare(`SELECT value FROM meta WHERE key = 'legacy_token_adopted'`).get();
  if (done) return;
  db.transaction(() => {
    db.prepare(
      `INSERT OR IGNORE INTO api_tokens (token, prefix, workspace_id, github_login, label) VALUES (?, ?, ?, NULL, 'Conector principal')`
    ).run(tokenHash(token), token.slice(0, 6), DEFAULT_WORKSPACE);
    db.prepare(`INSERT INTO meta (key, value) VALUES ('legacy_token_adopted', datetime('now'))`).run();
  })();
}

// ---------- Resolución del espacio de cada petición ----------

const pageWs = (id) => db.prepare('SELECT workspace_id FROM pages WHERE id = ?').get(id)?.workspace_id;
const fileWs = (id) => db.prepare('SELECT workspace_id FROM files WHERE id = ?').get(id)?.workspace_id;
const uploadWs = (id) => db.prepare('SELECT workspace_id FROM uploads WHERE id = ?').get(id)?.workspace_id;
const versionWs = (id) =>
  db.prepare('SELECT p.workspace_id FROM versions v JOIN pages p ON p.id = v.page_id WHERE v.id = ?').get(id)
    ?.workspace_id;

// Espacio pedido para listados y creaciones: el del token, o el de la cabecera
// X-Workspace / ?ws=, o (si no se indica) el primero accesible
function requestedWs(req) {
  if (req.authKind === 'token') return req.tokenWs;
  const asked = req.headers['x-workspace'] || req.query.ws;
  if (asked) return String(asked);
  return accessibleWorkspaces(req)[0]?.id || null;
}

// Rutas cuyo espacio sale del recurso del path. El orden importa.
const RESOURCE_ROUTES = [
  [new RegExp(`^/api/trash/files/(${ID})(?:/|$)`), fileWs],
  [/^\/api\/trash\/files\/?$/, null],
  [new RegExp(`^/api/(?:pages|trash)/(${ID})(?:/|$)`), pageWs],
  [new RegExp(`^/api/versions/(${ID})(?:/|$)`), versionWs],
  [new RegExp(`^/api/files/(${ID})(?:/|$)`), fileWs],
  [new RegExp(`^/files/(${ID})(?:/|$)`), fileWs],
  [new RegExp(`^/api/uploads/(${ID})(?:/|$)`), uploadWs],
];

// Rutas públicas o que no tocan datos de un espacio
const UNSCOPED = [/^\/api\/share\//, /^\/api\/health$/, /^\/api\/me$/, /^\/api\/workspaces(?:\/|$)/, /^\/api\/tokens\//];

// Prefijos cuyo segmento siguiente es SIEMPRE el id de un recurso (salvo los
// listados ya cubiertos en RESOURCE_ROUTES): si el id no es válido, 404 sin más
const ID_PREFIXES = /^\/(?:api\/(?:pages|trash|versions|files|uploads)|files)\/[^/]/;

export function workspaceGuard(req, res, next) {
  // Se compara con la ruta DECODIFICADA, igual que Express decodifica :id antes
  // del handler: si no, /api/pages/%41bc… se saltaría el control de espacio
  let p;
  try {
    p = decodeURIComponent(req.path);
  } catch {
    return res.status(400).json({ error: 'Ruta no válida' });
  }
  const isApi = p.startsWith('/api/');
  if (!isApi && !p.startsWith('/files/')) return next(); // SPA, assets, MCP (el MCP llama a la API con su token)
  if (UNSCOPED.some((re) => re.test(p))) return next();

  let listing = false;
  for (const [re, resolve] of RESOURCE_ROUTES) {
    const m = p.match(re);
    if (!m) continue;
    if (!resolve) {
      listing = true; // listado: espacio pedido
      break;
    }
    const ws = resolve(m[1]);
    // Un adjunto de página compartida es público aunque se tenga sesión
    if (p.startsWith('/files/') && ws && isSharedFileId(m[1]) && req.method === 'GET') {
      req.ws = ws;
      return next();
    }
    if (!ws || !roleIn(req, ws)) return res.status(404).json({ error: 'No encontrado' });
    req.ws = ws;
    return readOnlyGuard(req, res, next);
  }
  // Un recurso con un id que no se ha podido resolver arriba no se sirve nunca
  // con el espacio por defecto de quien pregunta
  if (!listing && ID_PREFIXES.test(p)) return res.status(404).json({ error: 'No encontrado' });

  const ws = requestedWs(req);
  if (!ws || !roleIn(req, ws)) {
    return res.status(ws ? 404 : 403).json({ error: ws ? 'Espacio no encontrado' : 'No tienes acceso a ningún espacio' });
  }
  req.ws = ws;
  readOnlyGuard(req, res, next);
}

// Lectores: todo lo que no sea leer se corta aquí, antes de cualquier ruta
const READS = new Set(['GET', 'HEAD', 'OPTIONS']);
// Marcar favorita una página es personal: también para quien solo lee
const onlyFavorite = (req) =>
  req.method === 'PUT' && /^\/api\/pages\/[^/]+$/.test(req.path) && req.body && Object.keys(req.body).join() === 'favorite';
function readOnlyGuard(req, res, next) {
  if (READS.has(req.method) || roleIn(req, req.ws) !== 'viewer' || onlyFavorite(req)) return next();
  res.status(403).json({ error: 'Tienes acceso de solo lectura a este espacio' });
}

function isSharedFileId(fileId) {
  return Boolean(
    db
      .prepare(
        `SELECT 1 FROM files f JOIN pages p ON p.id = f.page_id
         WHERE f.id = ? AND f.deleted_at IS NULL AND p.share_token IS NOT NULL AND p.trashed_at IS NULL`
      )
      .get(fileId)
  );
}

// ¿La página existe y es del espacio de la petición? (para parent_id, page_id del cuerpo)
export function pageInWs(pageId, ws) {
  return Boolean(pageId && db.prepare('SELECT 1 FROM pages WHERE id = ? AND workspace_id = ?').get(pageId, ws));
}

// Padre válido para crear una página: del espacio, no en la papelera (se
// borraría con él al vaciarla) y no una idea (las ideas no tienen subpáginas)
export function liveParentInWs(pageId, ws) {
  return Boolean(
    pageId &&
      db
        .prepare(`SELECT 1 FROM pages WHERE id = ? AND workspace_id = ? AND trashed_at IS NULL AND kind NOT IN ('idea', 'issue', 'tracker', 'minutes')`)
        .get(pageId, ws)
  );
}

// ---------- API de espacios, miembros y tokens ----------

const normLogin = (l) => (typeof l === 'string' && /^[A-Za-z0-9-]{1,39}$/.test(l.trim()) ? l.trim() : null);

export function mountWorkspaces(app, { notifyAll }) {
  const requireRole = (req, res, wsId, role = 'editor') => {
    const r = roleIn(req, wsId);
    if (!r || !atLeast(r, role)) {
      res
        .status(r ? 403 : 404)
        .json({ error: !r ? 'Espacio no encontrado' : role === 'admin' ? 'Solo administradores del espacio' : 'Tienes acceso de solo lectura a este espacio' });
      return false;
    }
    return true;
  };
  const requireOwner = (req, res) => {
    if (isOwner(req)) return true;
    res.status(403).json({ error: 'Solo los propietarios de la instancia' });
    return false;
  };

  app.get('/api/workspaces', (req, res) => {
    res.json({ owner: isOwner(req), workspaces: accessibleWorkspaces(req) });
  });

  app.post('/api/workspaces', (req, res) => {
    if (!requireOwner(req, res)) return;
    const name = String(req.body?.name || '').trim().slice(0, 60);
    if (!name) return res.status(400).json({ error: 'Falta el nombre' });
    const id = 'ws_' + crypto.randomBytes(6).toString('hex');
    const pos = db.prepare('SELECT COALESCE(MAX(position) + 1, 0) AS p FROM workspaces').get().p;
    db.prepare('INSERT INTO workspaces (id, name, icon, position) VALUES (?, ?, ?, ?)').run(
      id,
      name,
      String(req.body?.icon || '🗂️').slice(0, 8),
      pos
    );
    notifyAll();
    res.json({ ...db.prepare('SELECT * FROM workspaces WHERE id = ?').get(id), role: 'admin' });
  });

  app.patch('/api/workspaces/:id', (req, res) => {
    if (!requireRole(req, res, req.params.id, 'admin')) return;
    const { name, icon } = req.body || {};
    if (typeof name === 'string' && name.trim()) {
      db.prepare('UPDATE workspaces SET name = ? WHERE id = ?').run(name.trim().slice(0, 60), req.params.id);
    }
    if (typeof icon === 'string' && icon.trim()) {
      db.prepare('UPDATE workspaces SET icon = ? WHERE id = ?').run(icon.trim().slice(0, 8), req.params.id);
    }
    notifyAll();
    res.json(db.prepare('SELECT * FROM workspaces WHERE id = ?').get(req.params.id));
  });

  // Solo un espacio vacío (sin páginas, ni en la papelera) se puede borrar
  app.delete('/api/workspaces/:id', (req, res) => {
    if (!requireOwner(req, res)) return;
    const ws = db.prepare('SELECT id FROM workspaces WHERE id = ?').get(req.params.id);
    if (!ws) return res.status(404).json({ error: 'Espacio no encontrado' });
    if (db.prepare('SELECT 1 FROM pages WHERE workspace_id = ? LIMIT 1').get(ws.id)) {
      return res.status(409).json({ error: 'El espacio tiene páginas: vacíalo (y su papelera) antes de borrarlo' });
    }
    if (db.prepare('SELECT COUNT(*) AS n FROM workspaces').get().n <= 1) {
      return res.status(409).json({ error: 'Debe quedar al menos un espacio' });
    }
    db.prepare('DELETE FROM workspaces WHERE id = ?').run(ws.id);
    notifyAll();
    res.json({ ok: true });
  });

  app.get('/api/workspaces/:id/members', (req, res) => {
    if (!requireRole(req, res, req.params.id, 'viewer')) return;
    res.json({
      owners: instanceOwners(),
      members: db
        .prepare('SELECT github_login, role, added_at FROM workspace_members WHERE workspace_id = ? ORDER BY github_login')
        .all(req.params.id),
    });
  });

  // Dar acceso a una cuenta nueva abre la instancia a esa persona: solo los
  // propietarios. Cambiar el rol de alguien que ya es miembro: también los admins.
  app.put('/api/workspaces/:id/members/:login', async (req, res) => {
    if (!requireRole(req, res, req.params.id, 'admin')) return;
    const login = normLogin(req.params.login);
    const role = req.body?.role === undefined ? 'editor' : req.body.role;
    if (!login) return res.status(400).json({ error: 'Usuario de GitHub no válido' });
    if (!ROLES.includes(role)) return res.status(400).json({ error: `Rol no válido (usa ${ROLES.join(', ')})` });
    const existing = db
      .prepare('SELECT 1 FROM workspace_members WHERE workspace_id = ? AND github_login = ?')
      .get(req.params.id, login);
    if (!existing && !isOwner(req)) {
      return res.status(403).json({ error: 'Solo los propietarios de la instancia pueden dar acceso a una cuenta nueva' });
    }
    if (!existing) {
      const gh = await resolveGithubAccount(login);
      if (!gh.ok) return res.status(400).json({ error: `No existe ninguna cuenta de GitHub llamada «${login}»` });
      // El propietario da acceso a la cuenta que hoy tiene ese nombre
      if (gh.id) {
        db.prepare(
          `INSERT INTO github_identities (github_login, github_id) VALUES (?, ?)
           ON CONFLICT (github_login) DO UPDATE SET github_id = excluded.github_id, bound_at = datetime('now')`
        ).run(login, gh.id);
      }
    }
    db.prepare(
      `INSERT INTO workspace_members (workspace_id, github_login, role) VALUES (?, ?, ?)
       ON CONFLICT (workspace_id, github_login) DO UPDATE SET role = excluded.role`
    ).run(req.params.id, login, role);
    res.json({ ok: true });
  });

  app.delete('/api/workspaces/:id/members/:login', (req, res) => {
    if (!requireRole(req, res, req.params.id, 'admin')) return;
    db.prepare('DELETE FROM workspace_members WHERE workspace_id = ? AND github_login = ?').run(
      req.params.id,
      req.params.login
    );
    // Sus tokens de este espacio dejan de valer (lookupToken ya lo comprueba) y se borran
    db.prepare('DELETE FROM api_tokens WHERE workspace_id = ? AND github_login = ?').run(req.params.id, req.params.login);
    res.json({ ok: true });
  });

  // Tokens: cada persona ve los suyos; los administradores ven todos (enmascarados los ajenos)
  app.get('/api/workspaces/:id/tokens', (req, res) => {
    const role = roleIn(req, req.params.id);
    if (!role || req.authKind === 'token') return res.status(404).json({ error: 'Espacio no encontrado' });
    const me = loginOf(req);
    const rows = db
      .prepare('SELECT prefix, github_login, label, created_at, last_used_at FROM api_tokens WHERE workspace_id = ? ORDER BY created_at')
      .all(req.params.id);
    const mine = (t) => (t.github_login ? me && t.github_login.toLowerCase() === me.toLowerCase() : isOwner(req));
    res.json(
      rows
        .filter((t) => mine(t) || role === 'admin')
        .map((t) => ({
          id: t.prefix,
          token: null, // solo se guarda su hash: se ve entero únicamente al crearlo
          owner: t.github_login || '(propietarios)',
          mine: mine(t),
          label: t.label,
          created_at: t.created_at,
          last_used_at: t.last_used_at,
        }))
    );
  });

  app.post('/api/workspaces/:id/tokens', (req, res) => {
    if (req.authKind === 'token') return res.status(404).json({ error: 'Espacio no encontrado' });
    if (!requireRole(req, res, req.params.id, 'editor')) return;
    const label = String(req.body?.label || 'Conector de Claude').slice(0, 60);
    const token = createToken(req.params.id, req.authKind === 'session' ? loginOf(req) : null, label);
    res.json({ token });
  });

  // Revocar por su prefijo (id); el propio o, si eres admin, cualquiera del espacio
  app.delete('/api/workspaces/:id/tokens/:prefix', (req, res) => {
    const role = roleIn(req, req.params.id);
    if (!role || req.authKind === 'token') return res.status(404).json({ error: 'Espacio no encontrado' });
    const me = loginOf(req);
    const rows = db
      .prepare('SELECT token, github_login FROM api_tokens WHERE workspace_id = ? AND prefix = ?')
      .all(req.params.id, req.params.prefix);
    let n = 0;
    for (const t of rows) {
      const mine = t.github_login ? me && t.github_login.toLowerCase() === me.toLowerCase() : isOwner(req);
      if (mine || role === 'admin') {
        db.prepare('DELETE FROM api_tokens WHERE token = ?').run(t.token);
        n++;
      }
    }
    res.json({ deleted: n });
  });
}
