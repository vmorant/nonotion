// Login con GitHub (OAuth) a nivel de aplicación.
//
// Se activa cuando /etc/nonotion.env define GITHUB_CLIENT_ID, GITHUB_CLIENT_SECRET,
// AUTH_ALLOWED_GITHUB_USERS y PUBLIC_URL. Falla SIEMPRE cerrado: si están a medias,
// o si en producción (NODE_ENV=production) no hay login configurado, nadie entra.
// Para usar la app sin login (solo detrás de Cloudflare Access, o en local) hay
// que pedirlo explícitamente con AUTH_MODE=off.
//
// Quedan fuera del login, por diseño:
//   - /mcp/<token>            (el conector de Claude, protegido por su token)
//   - /share/*, /api/share/*  (enlaces públicos de solo lectura)
//   - /files/<id> de páginas compartidas
//   - peticiones con "Authorization: Bearer <token>" (scripts CLI y el propio MCP);
//     cada token da acceso a un único espacio
//
// Pueden entrar los propietarios (AUTH_ALLOWED_GITHUB_USERS) y los miembros de
// algún espacio (se añaden desde la app, sin reiniciar).
import crypto from 'crypto';
import db from './db.js';
import { loginAllowed, lookupToken, setAuthMode, bindIdentity, identityMatches } from './workspaces.js';

const SESSION_DAYS = 30; // deslizante: se renueva con el uso…
const SESSION_MAX_DAYS = 90; // …pero ninguna sesión dura más que esto desde el login

// Límite de intentos por IP (detrás del túnel de Cloudflare, la IP real llega en
// CF-Connecting-IP; el puerto no debe ser accesible sin pasar por el túnel)
const buckets = new Map();
export function clientIp(req) {
  return String(req.headers['cf-connecting-ip'] || req.socket?.remoteAddress || '?').slice(0, 64);
}
export function rateLimited(key, max, windowMs) {
  const now = Date.now();
  let b = buckets.get(key);
  if (!b || b.reset < now) {
    b = { n: 0, reset: now + windowMs };
    buckets.set(key, b);
  }
  b.n++;
  if (buckets.size > 50000) for (const [k, v] of buckets) if (v.reset < now) buckets.delete(k);
  return b.n > max;
}

export function authConfig() {
  const clientId = (process.env.GITHUB_CLIENT_ID || '').trim();
  const clientSecret = (process.env.GITHUB_CLIENT_SECRET || '').trim();
  const allowed = (process.env.AUTH_ALLOWED_GITHUB_USERS || '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  const publicUrl = (process.env.PUBLIC_URL || '').trim().replace(/\/+$/, '');
  const complete = Boolean(clientId && clientSecret && allowed.length && publicUrl);
  const explicitOff = /^off$/i.test((process.env.AUTH_MODE || '').trim());
  // Cualquier pista de que se quería login (o estar en producción sin pedir AUTH_MODE=off)
  // y no estar completo = cerrado. Nunca se abre por un fichero de entorno perdido o mal escrito.
  const wanted = Boolean(clientId || clientSecret || allowed.length) || (process.env.NODE_ENV === 'production' && !explicitOff);
  const mode = complete ? 'github' : wanted ? 'misconfigured' : explicitOff || process.env.NODE_ENV !== 'production' ? 'off' : 'misconfigured';
  return { clientId, clientSecret, allowed, publicUrl, mode };
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
const PUBLIC_EXACT = new Set(['/login', '/favicon.ico', '/favicon.svg', '/logo.svg', '/robots.txt', '/api/health']);
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
  identity:
    'Ese nombre de GitHub pertenece ahora a otra cuenta distinta de la que tenía acceso. Un propietario debe volver a darle acceso.',
  state: 'La sesión de login caducó o no es válida. Vuelve a intentarlo.',
  github: 'GitHub no completó el login. Vuelve a intentarlo.',
  config: 'El login con GitHub no está configurado en el servidor.',
};

// Marca (igual que client/public/logo.svg), en línea: el login no carga nada más
const LOGO_SVG = `<svg viewBox="0 0 64 64" width="64" height="64" aria-hidden="true">
  <defs>
    <linearGradient id="t" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#16181F"/><stop offset="1" stop-color="#08090C"/></linearGradient>
    <linearGradient id="s" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#5B8CFF"/><stop offset="1" stop-color="#1F5CFF"/></linearGradient>
    <filter id="g" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="3"/></filter>
  </defs>
  <rect width="64" height="64" rx="15" fill="url(#t)"/>
  <rect x="0.75" y="0.75" width="62.5" height="62.5" rx="14.25" fill="none" stroke="#fff" stroke-opacity="0.09" stroke-width="1.5"/>
  <path d="M20 45V19M44 45V19" stroke="#F4F6FA" stroke-width="7" stroke-linecap="round"/>
  <path d="M20 19L44 45" stroke="#2E6BFF" stroke-width="8" stroke-linecap="round" filter="url(#g)" opacity="0.7"/>
  <path d="M20 19L44 45" stroke="url(#s)" stroke-width="7" stroke-linecap="round"/>
</svg>`;

function loginPage({ next, error }) {
  const msg = error && (LOGIN_ERRORS[error] || 'No se pudo iniciar sesión.');
  return `<!doctype html>
<html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Entrar · NoNotion</title>
<link rel="icon" type="image/svg+xml" href="/favicon.svg">
<meta name="theme-color" content="#0e0f12">
<style>
  :root { color-scheme: dark; --blue:#2e6bff; }
  * { box-sizing: border-box; }
  body { margin:0; min-height:100vh; display:flex; align-items:center; justify-content:center; padding:16px;
         background: radial-gradient(900px 500px at 50% -10%, rgba(46,107,255,.22), transparent 60%), #0e0f12;
         color:#e8ebf1; font-family: Inter, ui-sans-serif,-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif; }
  .card { width:min(380px, 100%); background:#14161c; border:1px solid #2f3542; border-radius:16px;
          padding:36px 30px 30px; text-align:center; box-shadow:0 30px 90px -20px rgba(0,0,0,.7); }
  .logo svg { display:block; margin:0 auto 14px; border-radius:15px; box-shadow:0 18px 50px -14px var(--blue); }
  h1 { font-size:1.7rem; margin:0 0 6px; letter-spacing:-.03em; font-weight:750; }
  h1 span { color:var(--blue); }
  p { color:#8c94a5; font-size:.92rem; margin:0 0 24px; }
  a.btn { display:flex; align-items:center; justify-content:center; gap:10px; padding:12px 16px; border-radius:10px;
          background:#f4f6fa; color:#0a0b0f; font-weight:650; text-decoration:none; transition:transform .1s, box-shadow .15s; }
  a.btn:hover { box-shadow:0 0 0 3px rgba(46,107,255,.55); }
  a.btn:active { transform:translateY(1px); }
  a.btn:focus-visible { outline:2px solid var(--blue); outline-offset:2px; }
  .err { background:rgba(255,77,94,.1); border:1px solid rgba(255,77,94,.45); color:#ff9aa4; border-radius:10px; padding:10px 12px;
         font-size:.85rem; margin-bottom:18px; text-align:left; }
  .gh { width:20px; height:20px; }
  footer { margin-top:22px; color:#5c6373; font-size:.75rem; }
</style></head>
<body><main class="card">
  <div class="logo">${LOGO_SVG}</div>
  <h1><span>No</span>Notion</h1>
  <p>Acceso privado. Identifícate con tu cuenta de GitHub.</p>
  ${msg ? `<div class="err">${escapeHtml(msg)}</div>` : ''}
  <a class="btn" href="/auth/github?next=${encodeURIComponent(next)}">
    <svg class="gh" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"/></svg>
    Entrar con GitHub
  </a>
  <footer>Tus notas, en tu servidor.</footer>
</main></body></html>`;
}

export function setupAuth(app) {
  const cfg = authConfig();
  setAuthMode(cfg.mode);
  const secure = cfg.publicUrl.startsWith('https://');
  // Con https, prefijo __Host-: el navegador solo la acepta de este mismo host
  // (ningún subdominio hermano puede plantarla ni pisarla)
  const SESSION_COOKIE = secure ? '__Host-nn_session' : 'nn_session';
  const STATE_COOKIE = secure ? '__Host-nn_oauth' : 'nn_oauth';
  const sameSiteWrite = (req) => {
    // Escrituras con cookie: deben venir de nuestra propia web. Los navegadores
    // mandan Origin en todo POST/PUT/DELETE; si faltara, se mira Referer.
    const origin = req.headers.origin;
    if (origin) return origin === cfg.publicUrl;
    const ref = req.headers.referer || '';
    return ref === cfg.publicUrl || ref.startsWith(cfg.publicUrl + '/');
  };
  if (cfg.mode === 'github') {
    console.log(`Login con GitHub activo (${cfg.allowed.length} propietario/s; más los miembros de cada espacio)`);
  } else if (cfg.mode === 'misconfigured') {
    console.error(
      'Login con GitHub A MEDIAS: faltan GITHUB_CLIENT_ID, GITHUB_CLIENT_SECRET, AUTH_ALLOWED_GITHUB_USERS o PUBLIC_URL. Acceso bloqueado hasta completarlo.'
    );
  } else {
    console.log('Login con GitHub desactivado (AUTH_MODE=off o modo local): acceso protegido solo por Cloudflare Access');
  }

  // Cabeceras de seguridad básicas para todas las respuestas
  app.use((req, res, next) => {
    res.set({
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'same-origin',
      'X-Frame-Options': 'SAMEORIGIN',
    });
    if (secure) res.set('Strict-Transport-Security', 'max-age=31536000');
    next();
  });

  // Identifica al usuario: token de API (Bearer) o cookie de sesión
  app.use((req, res, next) => {
    req.user = null;
    req.authKind = null;
    const header = req.headers.authorization || '';
    if (header.startsWith('Bearer ')) {
      const ip = clientIp(req);
      const t = lookupToken(header.slice(7).trim());
      if (!t && rateLimited(`badtoken:${ip}`, 30, 10 * 60_000)) {
        return res.status(429).json({ error: 'Demasiados intentos con un token no válido; espera unos minutos' });
      }
      if (t) {
        req.user = { login: t.github_login || 'api-token' };
        req.authKind = 'token';
        req.tokenWs = t.workspace_id;
        req.tokenLogin = t.github_login || null;
      }
      return next(); // un Bearer inválido no cuenta como sesión
    }
    if (cfg.mode !== 'github') return next();
    const sid = parseCookies(req.headers.cookie)[SESSION_COOKIE];
    if (!sid) return next();
    const row = db
      .prepare(
        `SELECT * FROM sessions WHERE id = ? AND expires_at > datetime('now') AND created_at > datetime('now', ?)`
      )
      .get(sha256(sid), `-${SESSION_MAX_DAYS} days`);
    // Quitar a alguien (de los propietarios o de todos sus espacios) le corta el acceso,
    // y una cuenta de GitHub distinta que herede el mismo nombre no entra
    if (row && loginAllowed(row.github_login) && identityMatches(row.github_login, row.github_id)) {
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

  // Login: como mucho 30 intentos cada 10 minutos por IP
  app.use('/auth/', (req, res, next) => {
    if (rateLimited(`auth:${clientIp(req)}`, 30, 10 * 60_000)) {
      return res.status(429).type('text').send('Demasiados intentos de login; espera unos minutos.');
    }
    next();
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

      if (!u.login || !loginAllowed(u.login)) {
        console.warn(`Login denegado para la cuenta de GitHub "${u.login}"`);
        res.setHeader('Set-Cookie', clearState);
        return res.redirect('/login?error=denied');
      }
      // El acceso es del nombre de GitHub, pero queda atado a la cuenta (id numérico)
      // que lo usó la primera vez: si alguien hereda el nombre tras un cambio, no entra
      if (!Number.isInteger(u.id) || !bindIdentity(u.login, u.id)) {
        console.warn(`Login denegado: "${u.login}" es ahora otra cuenta de GitHub (id ${u.id})`);
        res.setHeader('Set-Cookie', clearState);
        return res.redirect('/login?error=identity');
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
    if (cfg.mode === 'github' && !sameSiteWrite(req)) return res.status(403).json({ error: 'Origen no permitido' });
    const sid = parseCookies(req.headers.cookie)[SESSION_COOKIE];
    if (sid) {
      const row = db.prepare('SELECT github_login FROM sessions WHERE id = ?').get(sha256(sid));
      // ?all=1 cierra también las sesiones de esa cuenta en los demás dispositivos
      if (row && req.query.all === '1') db.prepare('DELETE FROM sessions WHERE github_login = ?').run(row.github_login);
      db.prepare('DELETE FROM sessions WHERE id = ?').run(sha256(sid));
    }
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
      if (req.authKind === 'session' && !['GET', 'HEAD', 'OPTIONS'].includes(req.method) && !sameSiteWrite(req)) {
        return res.status(403).json({ error: 'Origen no permitido' });
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
