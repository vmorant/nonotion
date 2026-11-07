// Espacios de trabajo y control de acceso.
//
// Regla única: todo recurso (página, archivo, versión, subida, etiqueta) es de un
// espacio, y una petición solo ve los recursos de los espacios a los que su
// usuario (o su token) tiene acceso. El guardián `workspaceGuard` se monta
// ANTES de todas las rutas: resuelve el espacio de lo que se pide y corta con
// 404 (como si no existiera) lo ajeno. Las rutas solo consultan `req.ws`.
import crypto from 'crypto';
import db, { DEFAULT_WORKSPACE, instanceOwners, ftsUpsert } from './db.js';

export const ROLES = ['admin', 'editor'];
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

// Un token vale si su espacio existe y su dueño sigue teniendo acceso a él
export function lookupToken(token) {
  if (!token || typeof token !== 'string' || token.length < 16) return null;
  const row = db.prepare('SELECT * FROM api_tokens WHERE token = ?').get(token);
  if (!row) return null;
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
  ).run(token);
  return row;
}

export function createToken(wsId, login, label) {
  const token = newToken();
  db.prepare('INSERT INTO api_tokens (token, workspace_id, github_login, label) VALUES (?, ?, ?, ?)').run(
    token,
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
export function adoptLegacyToken(token) {
  if (!token) return;
  db.exec(`CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT)`);
  const done = db.prepare(`SELECT value FROM meta WHERE key = 'legacy_token_adopted'`).get();
  if (done) return;
  db.transaction(() => {
    db.prepare(
      `INSERT OR IGNORE INTO api_tokens (token, workspace_id, github_login, label) VALUES (?, ?, NULL, 'Conector principal')`
    ).run(token, DEFAULT_WORKSPACE);
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
    return next();
  }
  // Un recurso con un id que no se ha podido resolver arriba no se sirve nunca
  // con el espacio por defecto de quien pregunta
  if (!listing && ID_PREFIXES.test(p)) return res.status(404).json({ error: 'No encontrado' });

  const ws = requestedWs(req);
  if (!ws || !roleIn(req, ws)) {
    return res.status(ws ? 404 : 403).json({ error: ws ? 'Espacio no encontrado' : 'No tienes acceso a ningún espacio' });
  }
  req.ws = ws;
  next();
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
        .prepare(`SELECT 1 FROM pages WHERE id = ? AND workspace_id = ? AND trashed_at IS NULL AND kind NOT IN ('idea', 'issue')`)
        .get(pageId, ws)
  );
}

// ---------- API de espacios, miembros y tokens ----------

const normLogin = (l) => (typeof l === 'string' && /^[A-Za-z0-9-]{1,39}$/.test(l.trim()) ? l.trim() : null);

export function mountWorkspaces(app, { notifyAll }) {
  const requireRole = (req, res, wsId, role = 'editor') => {
    const r = roleIn(req, wsId);
    if (!r || (role === 'admin' && r !== 'admin')) {
      res.status(r ? 403 : 404).json({ error: r ? 'Solo administradores del espacio' : 'Espacio no encontrado' });
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
    // Prefijo de los elementos de seguimiento (AXA-12): cambia todas las claves
    if (req.body?.issue_prefix !== undefined) {
      const p = String(req.body.issue_prefix || '').trim().toUpperCase();
      if (!/^[A-Z][A-Z0-9]{0,9}$/.test(p)) return res.status(400).json({ error: 'Prefijo: letras y números, empezando por letra (máx. 10)' });
      db.prepare('UPDATE workspaces SET issue_prefix = ? WHERE id = ?').run(p, req.params.id);
      try {
        for (const r of db
          .prepare(`SELECT p.id, p.title, p.content_text FROM issues i JOIN pages p ON p.id = i.page_id WHERE i.workspace_id = ?`)
          .all(req.params.id)) {
          ftsUpsert(r.id, r.title, r.content_text);
        }
      } catch {}
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
    if (!requireRole(req, res, req.params.id, 'editor')) return;
    res.json({
      owners: instanceOwners(),
      members: db
        .prepare('SELECT github_login, role, added_at FROM workspace_members WHERE workspace_id = ? ORDER BY github_login')
        .all(req.params.id),
    });
  });

  app.put('/api/workspaces/:id/members/:login', (req, res) => {
    if (!requireRole(req, res, req.params.id, 'admin')) return;
    const login = normLogin(req.params.login);
    const role = ROLES.includes(req.body?.role) ? req.body.role : 'editor';
    if (!login) return res.status(400).json({ error: 'Usuario de GitHub no válido' });
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
      .prepare('SELECT token, github_login, label, created_at, last_used_at FROM api_tokens WHERE workspace_id = ? ORDER BY created_at')
      .all(req.params.id);
    const mine = (t) => (t.github_login ? me && t.github_login.toLowerCase() === me.toLowerCase() : isOwner(req));
    res.json(
      rows
        .filter((t) => mine(t) || role === 'admin')
        .map((t) => ({
          id: t.token.slice(0, 6),
          token: mine(t) ? t.token : null,
          owner: t.github_login || '(propietarios)',
          mine: mine(t),
          label: t.label,
          created_at: t.created_at,
          last_used_at: t.last_used_at,
        }))
    );
  });

  app.post('/api/workspaces/:id/tokens', (req, res) => {
    if (req.authKind === 'token' || !requireRole(req, res, req.params.id, 'editor')) return;
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
      .prepare('SELECT token, github_login FROM api_tokens WHERE workspace_id = ? AND substr(token, 1, 6) = ?')
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
