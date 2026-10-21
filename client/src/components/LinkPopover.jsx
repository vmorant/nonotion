import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { getMarkRange } from '@tiptap/core';
import { fileFromHref, pageIdFromHref, viewFile, openInNewTab } from '../fileLinks.js';

// Burbuja al hacer clic en un enlace del editor: abrir (página interna, visor
// de adjuntos o pestaña nueva), vista previa de webs externas, editar y quitar.
// Ctrl/⌘+clic o clic central abren directamente en una pestaña nueva.

export function previewUrl(url) {
  document.dispatchEvent(new CustomEvent('nonotion:preview-url', { detail: url }));
}

function shortUrl(href) {
  try {
    const u = new URL(href);
    const rest = (u.pathname + u.search).replace(/\/$/, '');
    return u.hostname + (rest.length > 40 ? rest.slice(0, 40) + '…' : rest);
  } catch {
    return href.length > 60 ? href.slice(0, 60) + '…' : href;
  }
}

// Enlace del editor bajo un evento de clic: { href, a, range } o null
export function linkAt(view, event) {
  const a = event.target.closest?.('a[href]');
  if (!a || !view.dom.contains(a)) return null;
  const href = a.getAttribute('href');
  let range = null;
  try {
    const pos = view.posAtDOM(a, 0);
    range = getMarkRange(view.state.doc.resolve(pos), view.state.schema.marks.link) || null;
  } catch {}
  return { href, a, range };
}

export default function LinkPopover({ editor, containerRef, pages, link, onClose }) {
  const navigate = useNavigate();
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState('');
  const boxRef = useRef(null);

  useEffect(() => {
    setEditing(false);
    setValue(link?.href || '');
  }, [link]);

  // Se cierra al cambiar el documento, al mover el cursor fuera del enlace o con Escape
  useEffect(() => {
    if (!editor || !link) return;
    const onSel = () => {
      const { from } = editor.state.selection;
      if (!link.range || from < link.range.from || from > link.range.to) onClose();
    };
    const onUpdate = () => !editing && onClose();
    const onKey = (e) => e.key === 'Escape' && onClose();
    const onDown = (e) => {
      if (boxRef.current?.contains(e.target) || link.a.contains(e.target)) return;
      onClose();
    };
    editor.on('selectionUpdate', onSel);
    editor.on('update', onUpdate);
    window.addEventListener('keydown', onKey);
    // en captura: antes de que React cambie la burbuja (p. ej. al pulsar ✎)
    document.addEventListener('mousedown', onDown, true);
    return () => {
      editor.off('selectionUpdate', onSel);
      editor.off('update', onUpdate);
      window.removeEventListener('keydown', onKey);
      document.removeEventListener('mousedown', onDown, true);
    };
  }, [editor, link, editing, onClose]);

  if (!link || !containerRef.current) return null;

  const c = containerRef.current.getBoundingClientRect();
  const r = link.a.getBoundingClientRect();
  const style = { top: r.bottom - c.top + 6, left: Math.max(0, Math.min(r.left - c.left, c.width - 340)) };

  const pageId = pageIdFromHref(link.href);
  const file = !pageId && fileFromHref(link.href);
  const page = pageId && pages.find((p) => p.id === pageId);

  const act = (fn) => (e) => {
    e.preventDefault();
    fn();
  };
  const selectLink = () => editor.chain().focus().setTextSelection(link.range || editor.state.selection).extendMarkRange('link');

  const save = () => {
    const href = value.trim();
    if (!href) selectLink().unsetLink().run();
    else selectLink().setLink({ href }).run();
    onClose();
  };

  let icon = '🌐';
  let label = shortUrl(link.href);
  if (pageId) {
    icon = page?.icon || '📄';
    label = page ? page.title || 'Sin título' : 'Página no encontrada (¿en la papelera?)';
  } else if (file) {
    icon = '📎';
    label = file.name;
  }

  return (
    <div className="link-popover" style={style} ref={boxRef} onMouseDown={(e) => e.target.tagName !== 'INPUT' && e.preventDefault()}>
      {editing ? (
        <div className="link-edit">
          <input
            autoFocus
            value={value}
            placeholder="https://… o /p/<id>"
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                save();
              }
              if (e.key === 'Escape') setEditing(false);
            }}
          />
          <button onMouseDown={act(save)}>Guardar</button>
        </div>
      ) : (
        <>
          <a className="link-label" href={link.href} target="_blank" rel="noopener noreferrer" title={link.href}>
            <span>{icon}</span> {label}
          </a>
          <div className="link-actions">
            {pageId && page && (
              <button onMouseDown={act(() => (onClose(), navigate(`/p/${pageId}`)))} title="Abrir la página aquí">
                Abrir
              </button>
            )}
            {file && (
              <button onMouseDown={act(() => (onClose(), viewFile(file)))} title="Ver en el visor de NoNotion">
                Ver
              </button>
            )}
            {!pageId && !file && (
              <button onMouseDown={act(() => (onClose(), previewUrl(link.href)))} title="Vista previa dentro de NoNotion (si la web lo permite)">
                👁 Vista previa
              </button>
            )}
            <button onMouseDown={act(() => (onClose(), openInNewTab(link.href)))} title="Abrir en una pestaña nueva (o Ctrl/⌘+clic en el enlace)">
              ↗ Pestaña nueva
            </button>
            {editor.isEditable && (
              <>
                <button onMouseDown={act(() => setEditing(true))} title="Cambiar la dirección">
                  ✎
                </button>
                <button
                  onMouseDown={act(() => {
                    selectLink().unsetLink().run();
                    onClose();
                  })}
                  title="Quitar el enlace (el texto se queda)"
                >
                  ⛓̸
                </button>
              </>
            )}
          </div>
        </>
      )}
    </div>
  );
}
