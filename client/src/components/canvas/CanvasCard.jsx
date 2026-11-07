import { useEffect, useMemo, useRef, useState } from 'react';
import MarkdownIt from 'markdown-it';
import { FileText, Globe, ExternalLink, Paperclip } from 'lucide-react';
import { api } from '../../api.js';
import { fileFromHref, pageIdFromHref, viewFile, openInNewTab, guessMime } from '../../fileLinks.js';

// Contenido de una tarjeta del canvas según su tipo (JSON Canvas):
// text (Markdown), file (página de NoNotion o adjunto), link (web) y group.

const md = new MarkdownIt({ html: false, linkify: true, breaks: true });

// Vista previa de páginas enlazadas (una petición por página y sesión)
const pageCache = new Map();
function usePagePreview(pageId) {
  const [state, setState] = useState(() => pageCache.get(pageId) || null);
  useEffect(() => {
    if (!pageId) return undefined;
    let cancelled = false;
    if (!pageCache.has(pageId)) {
      pageCache.set(
        pageId,
        api
          .pageMarkdown(pageId)
          .then((p) => ({ title: p.title, icon: p.icon, markdown: p.markdown, kind: p.kind }))
          .catch(() => ({ error: true }))
      );
    }
    Promise.resolve(pageCache.get(pageId)).then((v) => {
      pageCache.set(pageId, v);
      if (!cancelled) setState(v);
    });
    return () => {
      cancelled = true;
    };
  }, [pageId]);
  return state && typeof state.then !== 'function' ? state : null;
}

export const invalidatePagePreview = (pageId) => pageCache.delete(pageId);

function Markdown({ text, onOpenPage }) {
  // listas de tareas "- [ ]" / "- [x]" como casillas
  const html = useMemo(
    () =>
      md
        .render(text || '')
        .replace(/<li>\[ \]\s?/g, '<li class="task">☐ ')
        .replace(/<li>\[[xX]\]\s?/g, '<li class="task done">☑ '),
    [text]
  );
  return (
    <div
      className="canvas-md"
      dangerouslySetInnerHTML={{ __html: html }}
      onClick={(e) => {
        const a = e.target.closest?.('a[href]');
        if (!a) return;
        e.preventDefault();
        // Como en Obsidian: con Ctrl/⌘ se sigue el enlace; sin él, el clic selecciona la tarjeta
        if (!(e.ctrlKey || e.metaKey)) return;
        const href = a.getAttribute('href');
        const pid = pageIdFromHref(href);
        if (pid) onOpenPage(pid);
        else {
          const f = fileFromHref(href);
          if (f) viewFile(f);
          else openInNewTab(href);
        }
      }}
    />
  );
}

function TextCard({ node, editing, onTextChange, onStopEdit, onOpenPage }) {
  const ref = useRef(null);
  useEffect(() => {
    if (editing && ref.current) {
      ref.current.focus();
      const end = ref.current.value.length;
      ref.current.setSelectionRange(end, end);
    }
  }, [editing]);
  if (editing) {
    return (
      <textarea
        ref={ref}
        className="canvas-textarea"
        value={node.text || ''}
        placeholder="Escribe en Markdown…"
        onChange={(e) => onTextChange(e.target.value)}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === 'Escape') onStopEdit();
        }}
        onBlur={onStopEdit}
      />
    );
  }
  if (!node.text) return <div className="canvas-empty-hint">Doble clic para escribir</div>;
  return <Markdown text={node.text} onOpenPage={onOpenPage} />;
}

function PageCard({ pageId, onOpenPage }) {
  const p = usePagePreview(pageId);
  return (
    <div className="canvas-page">
      <div className="canvas-card-head" onDoubleClick={() => onOpenPage(pageId)} title="Doble clic para abrir la página">
        <span className="canvas-card-icon">{p?.icon || <FileText size={14} />}</span>
        <span className="canvas-card-title">{p?.error ? 'Página no disponible' : p?.title || 'Cargando…'}</span>
      </div>
      <div className="canvas-card-body">
        {p?.kind === 'canvas' ? (
          <div className="canvas-empty-hint">Canvas · doble clic en el título para abrirlo</div>
        ) : p?.markdown ? (
          <Markdown text={p.markdown.slice(0, 6000)} onOpenPage={onOpenPage} />
        ) : p?.error ? (
          <div className="canvas-empty-hint">Sin acceso a esta página</div>
        ) : null}
      </div>
    </div>
  );
}

function FileCard({ href }) {
  const f = fileFromHref(href);
  const name = f?.name || decodeURIComponent((href || '').split('/').pop() || 'archivo');
  const mime = f?.mime || guessMime(name);
  const url = f ? `/files/${f.id}/${encodeURIComponent(f.name)}` : href;
  if (mime.startsWith('image/')) {
    return <img className="canvas-img" src={url} alt={name} draggable={false} />;
  }
  if (mime.startsWith('video/')) return <video className="canvas-img" src={url} controls />;
  return (
    <div className="canvas-file">
      <Paperclip size={22} />
      <span className="canvas-file-name">{name}</span>
      {f && (
        <button className="btn" onPointerDown={(e) => e.stopPropagation()} onClick={() => viewFile(f)}>
          Ver
        </button>
      )}
    </div>
  );
}

function LinkCard({ url, selected }) {
  let host = url;
  try {
    host = new URL(url).hostname;
  } catch {}
  return (
    <div className="canvas-link">
      <div className="canvas-card-head">
        <Globe size={14} />
        <span className="canvas-card-title" title={url}>
          {host}
        </span>
        <button
          className="icon-btn"
          title="Abrir en pestaña nueva"
          onPointerDown={(e) => e.stopPropagation()}
          onClick={() => openInNewTab(url)}
        >
          <ExternalLink size={13} />
        </button>
      </div>
      {/* Hasta seleccionar la tarjeta, la web no captura el ratón (como en Obsidian) */}
      <iframe
        src={url}
        title={url}
        className="canvas-iframe"
        style={{ pointerEvents: selected ? 'auto' : 'none' }}
        sandbox="allow-scripts allow-same-origin allow-popups allow-forms"
        referrerPolicy="no-referrer"
        loading="lazy"
      />
    </div>
  );
}

export default function CanvasCard({ node, selected, editing, onTextChange, onStopEdit, onOpenPage }) {
  if (node.type === 'text') {
    return <TextCard node={node} editing={editing} onTextChange={onTextChange} onStopEdit={onStopEdit} onOpenPage={onOpenPage} />;
  }
  if (node.type === 'file') {
    const pid = pageIdFromHref(node.file);
    if (pid) return <PageCard pageId={pid} onOpenPage={onOpenPage} />;
    return <FileCard href={node.file} />;
  }
  if (node.type === 'link') return <LinkCard url={node.url} selected={selected} />;
  return null;
}
