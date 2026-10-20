// Identificador único de esta pestaña: el servidor lo usa para no devolvernos
// por SSE los cambios que hemos hecho nosotros mismos (evita auto-recargas).
export const CLIENT_ID =
  (typeof crypto !== 'undefined' && crypto.randomUUID && crypto.randomUUID()) ||
  Math.random().toString(36).slice(2);

// ---------- Trabajo sin guardar ----------
// Cualquier parte de la app (autoguardado, subidas) se apunta aquí mientras
// tenga algo pendiente; al cerrar la pestaña el navegador avisa si hay algo.
const busy = new Set();
export const markBusy = (key) => busy.add(key);
export const clearBusy = (key) => busy.delete(key);
export const hasUnsavedWork = () => busy.size > 0;

// Sesión caducada (login con GitHub activo): vuelve al login conservando la ruta
function goToLogin() {
  const next = window.location.pathname + window.location.search;
  window.location.href = `/login?next=${encodeURIComponent(next)}`;
}

export class ApiError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

async function req(url, options = {}) {
  const headers = { 'X-Client-Id': CLIENT_ID, ...(options.headers || {}) };
  if (!(options.body instanceof FormData) && !headers['Content-Type']) {
    headers['Content-Type'] = 'application/json';
  }
  const res = await fetch(url, { ...options, headers });
  if (res.status === 401) {
    goToLogin();
    throw new ApiError('Sesión caducada', 401);
  }
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new ApiError(err.error || `Error ${res.status}`, res.status);
  }
  return res.json();
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// PUT de un trozo con XHR para tener progreso dentro del trozo
function putChunk(id, offset, blob, onChunkProgress) {
  return new Promise((resolve) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', `/api/uploads/${id}?offset=${offset}`);
    xhr.setRequestHeader('Content-Type', 'application/octet-stream');
    xhr.setRequestHeader('X-Client-Id', CLIENT_ID);
    xhr.upload.onprogress = (e) => onChunkProgress?.(e.loaded);
    xhr.onload = () => {
      let json = {};
      try {
        json = JSON.parse(xhr.responseText);
      } catch {}
      resolve({ status: xhr.status, json });
    };
    xhr.onerror = () => resolve({ status: 0, json: {} }); // red caída: se reintenta
    xhr.ontimeout = () => resolve({ status: 0, json: {} });
    xhr.timeout = 5 * 60 * 1000;
    xhr.send(blob);
  });
}

// Subida por trozos de 8 MB, reanudable: si la red falla, pregunta al
// servidor cuánto llegó y sigue desde ahí. Evita el límite de 100 MB por
// petición de Cloudflare y no pierde lo ya subido.
async function uploadChunked(file, pageId, onProgress) {
  const key = `upload:${CLIENT_ID}:${file.name}:${file.size}:${Math.random()}`;
  markBusy(key);
  try {
    const init = await req('/api/uploads', {
      method: 'POST',
      body: JSON.stringify({ name: file.name, size: file.size, mime: file.type || '', page_id: pageId || null }),
    });
    const { id, chunk_size: chunkSize } = init;
    let offset = 0;
    let failures = 0;
    const report = (n) => onProgress?.(file.size ? Math.min(1, n / file.size) : 1);
    report(0);

    while (offset < file.size) {
      const blob = file.slice(offset, offset + chunkSize);
      const { status, json } = await putChunk(id, offset, blob, (loaded) => report(offset + loaded));
      if (status === 401) {
        goToLogin();
        throw new ApiError('Sesión caducada', 401);
      }
      if (status >= 200 && status < 300) {
        offset = json.received;
        failures = 0;
        report(offset);
        continue;
      }
      if (status === 409 && typeof json.received === 'number') {
        offset = json.received; // nos resincronizamos con lo que tiene el servidor
        continue;
      }
      if (status >= 400 && status < 500 && status !== 408 && status !== 429) {
        throw new ApiError(json.error || `Error ${status} al subir`, status);
      }
      // Red caída, timeout o error del servidor: reintento con espera creciente
      failures += 1;
      if (failures > 12) throw new ApiError('No se pudo completar la subida tras varios reintentos', status);
      await sleep(Math.min(30000, 1000 * 2 ** failures));
      try {
        const state = await req(`/api/uploads/${id}`);
        offset = state.received;
      } catch {}
    }

    for (let attempt = 0; ; attempt++) {
      try {
        const meta = await req(`/api/uploads/${id}/complete`, { method: 'POST' });
        report(file.size);
        return meta;
      } catch (e) {
        if (attempt >= 5 || (e.status && e.status < 500 && e.status !== 409)) throw e;
        await sleep(1000 * 2 ** attempt);
      }
    }
  } finally {
    clearBusy(key);
  }
}

export const api = {
  me: () => req('/api/me'),
  pages: () => req('/api/pages'),
  page: (id) => req(`/api/pages/${id}`),
  createPage: (data) => req('/api/pages', { method: 'POST', body: JSON.stringify(data) }),
  updatePage: (id, data) => req(`/api/pages/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
  deletePage: (id) => req(`/api/pages/${id}`, { method: 'DELETE' }),
  search: (q) => req(`/api/search?q=${encodeURIComponent(q)}`),
  share: (id) => req(`/api/pages/${id}/share`, { method: 'POST' }),
  unshare: (id) => req(`/api/pages/${id}/share`, { method: 'DELETE' }),
  sharedPage: (token) => req(`/api/share/${token}`),
  deleteFile: (id) => req(`/api/files/${id}`, { method: 'DELETE' }),
  movePage: (id, parentId, index) =>
    req(`/api/pages/${id}/move`, { method: 'POST', body: JSON.stringify({ parent_id: parentId, index }) }),
  duplicatePage: (id) => req(`/api/pages/${id}/duplicate`, { method: 'POST' }),
  pagePrefs: (id, prefs) => req(`/api/pages/${id}/prefs`, { method: 'POST', body: JSON.stringify(prefs) }),
  sheets: (fileId) => req(`/files/${fileId}/sheets`),
  trash: () => req('/api/trash'),
  restoreTrash: (id) => req(`/api/trash/${id}/restore`, { method: 'POST' }),
  deleteTrashItem: (id) => req(`/api/trash/${id}`, { method: 'DELETE' }),
  emptyTrash: () => req('/api/trash', { method: 'DELETE' }),
  trashFiles: () => req('/api/trash/files'),
  restoreTrashFile: (id) => req(`/api/trash/files/${id}/restore`, { method: 'POST' }),
  deleteTrashFile: (id) => req(`/api/trash/files/${id}`, { method: 'DELETE' }),
  calendar: (from, to) => req(`/api/calendar?from=${from}&to=${to}`),
  versions: (pageId) => req(`/api/pages/${pageId}/versions`),
  version: (vid) => req(`/api/versions/${vid}`),
  restoreVersion: (pageId, vid) => req(`/api/pages/${pageId}/restore-version/${vid}`, { method: 'POST' }),
  logout: () => req('/auth/logout', { method: 'POST', headers: { Accept: 'application/json' } }),
  // Todas las subidas van por trozos (sin límite de tamaño, reanudables)
  uploadFile: (file, pageId, onProgress) => uploadChunked(file, pageId, onProgress),
  uploadFileProgress: (file, pageId, onProgress) => uploadChunked(file, pageId, onProgress),
};

// El content de una página puede ser JSON Tiptap o Markdown crudo (páginas capturadas vía API)
export function parseContent(content) {
  if (!content) return '';
  if (typeof content === 'string' && content.trim().startsWith('{')) {
    try {
      return JSON.parse(content);
    } catch {
      return content;
    }
  }
  return content;
}

// Páginas visitadas hace poco en este navegador (para "Recientes")
const RECENT_KEY = 'nn:recent';
const RECENT_MAX = 8;
export function readRecent() {
  try {
    const list = JSON.parse(localStorage.getItem(RECENT_KEY) || '[]');
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}
export function pushRecent(id) {
  const list = [id, ...readRecent().filter((x) => x !== id)].slice(0, RECENT_MAX);
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify(list));
  } catch {}
  return list;
}

export function humanSize(bytes) {
  if (bytes == null) return '';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  let n = bytes;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i++;
  }
  return `${n < 10 && i > 0 ? n.toFixed(1) : Math.round(n)} ${units[i]}`;
}
