async function req(url, options = {}) {
  const res = await fetch(url, {
    headers: options.body instanceof FormData ? {} : { 'Content-Type': 'application/json' },
    ...options,
  });
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
  stats: () => req('/api/stats'),
  startRecording: (pageId) =>
    req('/api/recordings/start', { method: 'POST', body: JSON.stringify({ page_id: pageId }) }),
  uploadChunk: (id, blob) =>
    req(`/api/recordings/${id}/chunk`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: blob,
    }),
  finishRecording: (id, data) =>
    req(`/api/recordings/${id}/finish`, { method: 'POST', body: JSON.stringify(data) }),
  cancelRecording: (id) => req(`/api/recordings/${id}`, { method: 'DELETE' }),
  versions: (pageId) => req(`/api/pages/${pageId}/versions`),
  version: (vid) => req(`/api/versions/${vid}`),
  restoreVersion: (pageId, vid) => req(`/api/pages/${pageId}/restore-version/${vid}`, { method: 'POST' }),
  uploadFile: (file, pageId) => {
    const fd = new FormData();
    fd.append('page_id', pageId || '');
    fd.append('file', file);
    return req('/api/files', { method: 'POST', body: fd });
  },
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
