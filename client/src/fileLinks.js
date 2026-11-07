// Utilidades para enlaces: adjuntos (/files/<id>/<nombre>) y páginas (/p/<id>)

const MIME_BY_EXT = {
  pdf: 'application/pdf',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  mp4: 'video/mp4',
  webm: 'video/webm',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  txt: 'text/plain',
  md: 'text/markdown',
  csv: 'text/csv',
  json: 'application/json',
  html: 'text/html',
};

export function guessMime(name = '') {
  const ext = name.split('.').pop().toLowerCase();
  return MIME_BY_EXT[ext] || 'application/octet-stream';
}

// Ruta relativa si el enlace apunta a esta misma instancia de NoNotion
function localPath(href) {
  if (!href) return null;
  try {
    const u = new URL(href, location.origin);
    return u.origin === location.origin ? u.pathname + u.search + u.hash : null;
  } catch {
    return null;
  }
}

// { id, name, mime } si el enlace es un adjunto de NoNotion
export function fileFromHref(href) {
  const p = localPath(href);
  const m = p && p.match(/^\/files\/([A-Za-z0-9_-]{21})(?:\/([^?#]*))?/);
  if (!m) return null;
  let name = 'archivo';
  try {
    name = decodeURIComponent(m[2] || '') || name;
  } catch {}
  return { id: m[1], name, mime: guessMime(name) };
}

// Id de página si el enlace es a una página de NoNotion
export function pageIdFromHref(href) {
  const p = localPath(href);
  const m = p && p.match(/^\/p\/([A-Za-z0-9_-]+)/);
  return m ? m[1] : null;
}

export function viewFile(file) {
  document.dispatchEvent(new CustomEvent('nonotion:view-file', { detail: file }));
}

// Solo webs, rutas internas o correo: nunca javascript:, data:, vbscript:…
export function safeHref(href) {
  const h = String(href || '').trim();
  if (/^(https?:|mailto:)/i.test(h) || (h.startsWith('/') && !h.startsWith('//'))) return h;
  return null;
}

export function openInNewTab(href) {
  const h = safeHref(href);
  if (!h) return;
  window.open(h, '_blank', 'noopener,noreferrer');
}
