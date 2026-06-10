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
  uploadFile: (file, pageId) => {
    const fd = new FormData();
    fd.append('page_id', pageId || '');
    fd.append('file', file);
    return req('/api/files', { method: 'POST', body: fd });
  },
};

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
