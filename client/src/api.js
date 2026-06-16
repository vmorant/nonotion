// Identificador único de esta pestaña: el servidor lo usa para no devolvernos
// por SSE los cambios que hemos hecho nosotros mismos (evita auto-recargas).
export const CLIENT_ID =
  (typeof crypto !== 'undefined' && crypto.randomUUID && crypto.randomUUID()) ||
  Math.random().toString(36).slice(2);

async function req(url, options = {}) {
  const headers = { 'X-Client-Id': CLIENT_ID, ...(options.headers || {}) };
  if (!(options.body instanceof FormData) && !headers['Content-Type']) {
    headers['Content-Type'] = 'application/json';
  }
  const res = await fetch(url, { ...options, headers });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || `Error ${res.status}`);
  }
  return res.json();
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
  trash: () => req('/api/trash'),
  restoreTrash: (id) => req(`/api/trash/${id}/restore`, { method: 'POST' }),
  deleteTrashItem: (id) => req(`/api/trash/${id}`, { method: 'DELETE' }),
  emptyTrash: () => req('/api/trash', { method: 'DELETE' }),
  calendar: (from, to) => req(`/api/calendar?from=${from}&to=${to}`),
  versions: (pageId) => req(`/api/pages/${pageId}/versions`),
  version: (vid) => req(`/api/versions/${vid}`),
  restoreVersion: (pageId, vid) => req(`/api/pages/${pageId}/restore-version/${vid}`, { method: 'POST' }),
  uploadFile: (file, pageId) => {
    const fd = new FormData();
    fd.append('page_id', pageId || '');
    fd.append('file', file);
    return req('/api/files', { method: 'POST', body: fd });
  },
  // Subida con progreso (XHR expone upload.onprogress; fetch no)
  uploadFileProgress: (file, pageId, onProgress) =>
    new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('POST', '/api/files');
      xhr.setRequestHeader('X-Client-Id', CLIENT_ID);
      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable && onProgress) onProgress(e.loaded / e.total);
      };
      xhr.onload = () => {
        if (xhr.status >= 200 && xhr.status < 300) {
          try {
            resolve(JSON.parse(xhr.responseText));
          } catch {
            reject(new Error('Respuesta inválida del servidor'));
          }
        } else {
          let msg = `Error ${xhr.status}`;
          try {
            msg = JSON.parse(xhr.responseText).error || msg;
          } catch {}
          reject(new Error(msg));
        }
      };
      xhr.onerror = () => reject(new Error('Error de red al subir el archivo'));
      const fd = new FormData();
      fd.append('page_id', pageId || '');
      fd.append('file', file);
      xhr.send(fd);
    }),
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
