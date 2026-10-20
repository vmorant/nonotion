// Login con GitHub (OAuth) a nivel de aplicación.
//
// Se activa cuando /etc/nonotion.env define GITHUB_CLIENT_ID, GITHUB_CLIENT_SECRET,
// AUTH_ALLOWED_GITHUB_USERS y PUBLIC_URL. Sin esas variables la app funciona como
// antes (protegida solo por Cloudflare Access). Si están a medias, falla cerrado:
// nadie entra hasta completar la configuración.
//
// Quedan fuera del login, por diseño:
//   - /mcp/<token>            (el conector de Claude, protegido por su token)
//   - /share/*, /api/share/*  (enlaces públicos de solo lectura)
//   - /files/<id> de páginas compartidas
//   - peticiones con "Authorization: Bearer <token MCP>" (scripts CLI y el propio MCP)
import crypto from 'crypto';
import db from './db.js';

const SESSION_DAYS = 30;
const SESSION_COOKIE = 'nn_session';
const STATE_COOKIE = 'nn_oauth';

export function authConfig() {
  const clientId = (process.env.GITHUB_CLIENT_ID || '').trim();
  const clientSecret = (process.env.GITHUB_CLIENT_SECRET || '').trim();
  const allowed = (process.env.AUTH_ALLOWED_GITHUB_USERS || '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  const publicUrl = (process.env.PUBLIC_URL || '').trim().replace(/\/+$/, '');
  const complete = Boolean(clientId && clientSecret && allowed.length && publicUrl);
  const started = Boolean(clientId || clientSecret);
  return { clientId, clientSecret, allowed, publicUrl, mode: complete ? 'github' : started ? 'misconfigured' : 'off' };
}

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

function safeEqual(a, b) {
  const A = Buffer.from(String(a));
  const B = Buffer.from(String(b));
  return A.length === B.length && crypto.timingSafeEqual(A, B);
}

function parseCookies(header = '') {
  const out = {};
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    if (k) out[k] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function cookieString(name, value, { maxAge, secure }) {
  let c = `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}`;
  if (secure) c += '; Secure';
  return c;
}

// Solo rutas relativas internas: evita redirecciones abiertas a otros dominios
function safeNext(next) {
  return typeof next === 'string' && next.startsWith('/') && !next.startsWith('//') && !next.startsWith('/\\')
    ? next
    : '/';
}

const PUBLIC_PREFIXES = ['/auth/', '/mcp/', '/assets/', '/share/', '/api/share/'];
const PUBLIC_EXACT = new Set(['/login', '/favicon.ico', '/robots.txt', '/api/health']);
const isPublic = (p) => PUBLIC_EXACT.has(p) || PUBLIC_PREFIXES.some((pre) => p.startsWith(pre));

// Un adjunto es público si pertenece a una página compartida (no borrada)
function isSharedFile(p) {
  const m = p.match(/^\/files\/([A-Za-z0-9_-]{21})(?:\/|$)/);
  if (!m) return false;
  return Boolean(
    db
      .prepare(
        `SELECT 1 FROM files f JOIN pages p ON p.id = f.page_id
         WHERE f.id = ? AND f.deleted_at IS NULL AND p.share_token IS NOT NULL AND p.trashed_at IS NULL`
      )
      .get(m[1])
  );
}

export function purgeExpiredSessions() {
  db.prepare(`DELETE FROM sessions WHERE expires_at < datetime('now')`).run();
}

const escapeHtml = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const LOGIN_ERRORS = {
  denied: 'Esa cuenta de GitHub no tiene acceso a este NoNotion.',
  state: 'La sesión de login caducó o no es válida. Vuelve a intentarlo.',
  github: 'GitHub no completó el login. Vuelve a intentarlo.',
  config: 'El login con GitHub no está configurado en el servidor.',
};

function loginPage({ next, error }) {
  const msg = error && (LOGIN_ERRORS[error] || 'No se pudo iniciar sesión.');
  return `<!doctype html>
<html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Entrar · NoNotion</title>
<style>
  :root { color-scheme: dark; }
  body { margin:0; min-height:100vh; display:flex; align-items:center; justify-content:center;
         background:#191919; color:#e8e8e6; font-family: ui-sans-serif,-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif; }
  .card { width:min(360px, calc(100vw - 32px)); background:#202020; border:1px solid #333; border-radius:12px;
          padding:32px 28px; text-align:center; box-shadow:0 16px 50px rgba(0,0,0,.45); }
  h1 { font-size:1.4rem; margin:0 0 6px; }
  p { color:#9b9b9b; font-size:.9rem; margin:0 0 22px; }
  a.btn { display:flex; align-items:center; justify-content:center; gap:10px; padding:11px 16px; border-radius:8px;
          background:#e8e8e6; color:#191919; font-weight:600; text-decoration:none; }
  a.btn:hover { background:#fff; }
  .err { background:#3a1d1d; border:1px solid #6b2b2b; color:#f0a0a0; border-radius:8px; padding:10px 12px;
         font-size:.85rem; margin-bottom:18px; text-align:left; }
  svg { width:20px; height:20px; }
</style></head>
<body><main class="card">
  <h1>🗂️ NoNotion</h1>
  <p>Acceso privado. Identifícate con tu cuenta de GitHub.</p>
  ${msg ? `<div class="err">${escapeHtml(msg)}</div>` : ''}
  <a class="btn" href="/auth/github?next=${encodeURIComponent(next)}">
    <svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"/></svg>
    Entrar con GitHub
  </a>
</main></body></html>`;
}

export function setupAuth(app, { apiToken }) {
  const cfg = authConfig();
  const secure = cfg.publicUrl.startsWith('https://');
  if (cfg.mode === 'github') {
    console.log(`Login con GitHub activo (${cfg.allowed.length} usuario/s permitido/s)`);
  } else if (cfg.mode === 'misconfigured') {
    console.error(
      'Login con GitHub A MEDIAS: faltan GITHUB_CLIENT_ID, GITHUB_CLIENT_SECRET, AUTH_ALLOWED_GITHUB_USERS o PUBLIC_URL. Acceso bloqueado hasta completarlo.'
    );
  } else {
    console.log('Login con GitHub desactivado (sin GITHUB_CLIENT_ID): acceso protegido solo por Cloudflare Access');
  }

  // Cabeceras de seguridad básicas para todas las respuestas
  app.use((req, res, next) => {
    res.set({
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'same-origin',
      'X-Frame-Options': 'SAMEORIGIN',
    });
    next();
  });

  // Identifica al usuario: token de API (Bearer) o cookie de sesión
  app.use((req, res, next) => {
    req.user = null;
    req.authKind = null;
    const header = req.headers.authorization || '';
    if (apiToken && header.startsWith('Bearer ') && safeEqual(header.slice(7).trim(), apiToken)) {
      req.user = { login: 'api-token' };
      req.authKind = 'token';
      return next();
    }
    if (cfg.mode !== 'github') return next();
    const sid = parseCookies(req.headers.cookie)[SESSION_COOKIE];
    if (!sid) return next();
    const row = db
      .prepare(`SELECT * FROM sessions WHERE id = ? AND expires_at > datetime('now')`)
      .get(sha256(sid));
    // Quitar a alguien de AUTH_ALLOWED_GITHUB_USERS le corta el acceso al reiniciar
    if (row && cfg.allowed.includes(row.github_login.toLowerCase())) {
      req.user = { login: row.github_login, name: row.name, avatar_url: row.avatar_url };
      req.authKind = 'session';
      // Sesión deslizante: renovamos como mucho una vez por hora
      db.prepare(
        `UPDATE sessions SET last_seen_at = datetime('now'), expires_at = datetime('now', ?)
         WHERE id = ? AND last_seen_at < datetime('now', '-1 hour')`
      ).run(`+${SESSION_DAYS} days`, row.id);
    }
    next();
  });

  app.get('/login', (req, res) => {
    const next = safeNext(req.query.next);
    if (cfg.mode === 'off' || req.authKind === 'session') return res.redirect(next);
    res.type('html').send(loginPage({ next, error: cfg.mode === 'misconfigured' ? 'config' : req.query.error }));
  });

  app.get('/auth/github', (req, res) => {
    if (cfg.mode !== 'github') return res.redirect('/login?error=config');
    const state = crypto.randomBytes(24).toString('hex');
    const next = safeNext(req.query.next);
    res.setHeader(
      'Set-Cookie',
      cookieString(STATE_COOKIE, `${state}.${Buffer.from(next).toString('base64url')}`, { maxAge: 600, secure })
    );
    const url = new URL('https://github.com/login/oauth/authorize');
    url.searchParams.set('client_id', cfg.clientId);
    url.searchParams.set('redirect_uri', `${cfg.publicUrl}/auth/github/callback`);
    url.searchParams.set('scope', 'read:user');
    url.searchParams.set('state', state);
    url.searchParams.set('allow_signup', 'false');
    res.redirect(url.toString());
  });

  app.get('/auth/github/callback', async (req, res) => {
    if (cfg.mode !== 'github') return res.redirect('/login?error=config');
    const raw = parseCookies(req.headers.cookie)[STATE_COOKIE] || '';
    const [state, nextEnc] = raw.split('.');
    const clearState = cookieString(STATE_COOKIE, '', { maxAge: 0, secure });
    if (!state || !req.query.state || !safeEqual(state, req.query.state)) {
      res.setHeader('Set-Cookie', clearState);
      return res.redirect('/login?error=state');
    }
    let next = '/';
    try {
      next = safeNext(Buffer.from(nextEnc || '', 'base64url').toString());
    } catch {}
    if (req.query.error || !req.query.code) {
      res.setHeader('Set-Cookie', clearState);
      return res.redirect('/login?error=github');
    }
    try {
      const tokenRes = await fetch('https://github.com/login/oauth/access_token', {
        method: 'POST',
        headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
        body: JSON.stringify({
          client_id: cfg.clientId,
          client_secret: cfg.clientSecret,
          code: req.query.code,
          redirect_uri: `${cfg.publicUrl}/auth/github/callback`,
        }),
        signal: AbortSignal.timeout(15000),
      });
      const tokenJson = await tokenRes.json();
      if (!tokenJson.access_token) throw new Error(tokenJson.error_description || tokenJson.error || 'sin access_token');

      const userRes = await fetch('https://api.github.com/user', {
        headers: {
          Authorization: `Bearer ${tokenJson.access_token}`,
          Accept: 'application/vnd.github+json',
          'User-Agent': 'nonotion',
        },
        signal: AbortSignal.timeout(15000),
      });
      if (!userRes.ok) throw new Error(`GitHub /user respondió ${userRes.status}`);
      const u = await userRes.json();
      // El token de GitHub no se guarda: solo sirve para saber quién eres

      if (!u.login || !cfg.allowed.includes(String(u.login).toLowerCase())) {
        console.warn(`Login denegado para la cuenta de GitHub "${u.login}"`);
        res.setHeader('Set-Cookie', clearState);
        return res.redirect('/login?error=denied');
      }

      const sessionToken = crypto.randomBytes(32).toString('base64url');
      db.prepare(
        `INSERT INTO sessions (id, github_login, github_id, name, avatar_url, user_agent, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, datetime('now', ?))`
      ).run(
        sha256(sessionToken),
        u.login,
        u.id ?? null,
        u.name || null,
        u.avatar_url || null,
        String(req.headers['user-agent'] || '').slice(0, 200),
        `+${SESSION_DAYS} days`
      );
      console.log(`Login correcto: ${u.login}`);
      res.setHeader('Set-Cookie', [
        clearState,
        cookieString(SESSION_COOKIE, sessionToken, { maxAge: SESSION_DAYS * 86400, secure }),
      ]);
      res.redirect(next);
    } catch (e) {
      console.error('Error en el login con GitHub:', e.message);
      res.setHeader('Set-Cookie', clearState);
      res.redirect('/login?error=github');
    }
  });

  app.post('/auth/logout', (req, res) => {
    const sid = parseCookies(req.headers.cookie)[SESSION_COOKIE];
    if (sid) db.prepare('DELETE FROM sessions WHERE id = ?').run(sha256(sid));
    res.setHeader('Set-Cookie', cookieString(SESSION_COOKIE, '', { maxAge: 0, secure }));
    if (req.accepts(['html', 'json']) === 'json') return res.json({ ok: true });
    res.redirect('/login');
  });

  // Puerta de acceso: todo lo que no sea público necesita sesión o token
  app.use((req, res, next) => {
    if (cfg.mode === 'off' || isPublic(req.path)) return next();
    if (cfg.mode === 'misconfigured') {
      return res.status(503).json({ error: 'Login con GitHub configurado a medias; revisa /etc/nonotion.env' });
    }
    if (req.user) {
      // Anti-CSRF: con cookie de sesión, las escrituras deben venir de nuestro dominio
      if (req.authKind === 'session' && !['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
        const origin = req.headers.origin;
        if (origin && origin !== cfg.publicUrl) return res.status(403).json({ error: 'Origen no permitido' });
      }
      return next();
    }
    if (isSharedFile(req.path)) return next();
    const wantsHtml = req.method === 'GET' && !req.path.startsWith('/api/') && req.accepts(['html', 'json']) === 'html';
    if (wantsHtml) return res.redirect(`/login?next=${encodeURIComponent(req.originalUrl)}`);
    res.status(401).json({ error: 'No autenticado', login: '/login' });
  });

  return cfg;
}
