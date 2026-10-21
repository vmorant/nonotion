import { useCallback, useEffect, useRef, useState } from 'react';
import { Extension } from '@tiptap/core';
import { useEditor, EditorContent } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import Link from '@tiptap/extension-link';
import Placeholder from '@tiptap/extension-placeholder';
import TaskList from '@tiptap/extension-task-list';
import TaskItem from '@tiptap/extension-task-item';
import Table from '@tiptap/extension-table';
import TableRow from '@tiptap/extension-table-row';
import TableHeader from '@tiptap/extension-table-header';
import TableCell from '@tiptap/extension-table-cell';
import CodeBlockLowlight from '@tiptap/extension-code-block-lowlight';
import { createLowlight, common } from 'lowlight';
import { Slice, Fragment, DOMParser as PMDOMParser } from '@tiptap/pm/model';
import { Markdown } from 'tiptap-markdown';
import SlashCommands from './SlashCommands.js';
import { HeadingFold } from './headingFold.js';
import TableToolbar from './TableToolbar.jsx';
import { TableNav } from './tableTools.js';
import LinkPopover, { linkAt } from './LinkPopover.jsx';
import { PageLinkSuggest } from './pageLinks.js';
import { ResizableImage, insertImages } from './imageView.js';
import { pageIdFromHref, openInNewTab } from '../fileLinks.js';
import { withMarkdownTables, withCellAlign, fixParsedTables, protectFormulas } from '../tableMarkdown.js';
import { api } from '../api.js';

const lowlight = createLowlight(common);

// Captura Tab/Shift-Tab: indenta o desindenta en listas y de tareas; en el resto
// inserta una tabulación. Siempre consume el evento para no perder el foco (evita
// que el navegador salte al siguiente control de la interfaz).
const TabHandler = Extension.create({
  name: 'tabHandler',
  priority: 100,
  addKeyboardShortcuts() {
    return {
      Tab: () => {
        if (this.editor.can().sinkListItem('listItem')) return this.editor.chain().focus().sinkListItem('listItem').run();
        if (this.editor.can().sinkListItem('taskItem')) return this.editor.chain().focus().sinkListItem('taskItem').run();
        return this.editor.chain().focus().insertContent('\t').run();
      },
      'Shift-Tab': () => {
        if (this.editor.can().liftListItem('listItem')) return this.editor.chain().focus().liftListItem('listItem').run();
        if (this.editor.can().liftListItem('taskItem')) return this.editor.chain().focus().liftListItem('taskItem').run();
        return true; // consume el evento aunque no haya nada que desindentar
      },
    };
  },
});

// Al pegar Markdown de Claude, los <br> de las celdas de tabla llegan como
// texto literal (se convierten en saltos de párrafo dentro de la celda) y las
// fórmulas <!-- TBLFM: … --> como párrafos (pasan a ser fórmulas de la tabla)
function splitPastedBreaks(slice, schema) {
  let found = false;
  slice.content.descendants((node) => {
    if (node.isText && /<br\s*\/?>|TBLFM:/i.test(node.text)) found = true;
    return !found;
  });
  if (!found) return slice;
  const json = fixParsedTables({ type: 'doc', content: slice.content.toJSON() || [] });
  try {
    return new Slice(Fragment.fromJSON(schema, json.content), slice.openStart, slice.openEnd);
  } catch {
    return slice;
  }
}

// Markdown con fórmulas de tabla (<!-- TBLFM: … -->, de Obsidian o Claude):
// markdown-it las tomaría por filas de la tabla, así que se protegen antes
function pasteMarkdownWithFormulas(view, editor, text) {
  const html = editor.storage.markdown.parser.parse(protectFormulas(text));
  const dom = new window.DOMParser().parseFromString(`<body>${html}</body>`, 'text/html').body;
  const slice = PMDOMParser.fromSchema(view.state.schema).parseSlice(dom);
  const json = fixParsedTables({ type: 'doc', content: slice.content.toJSON() || [] });
  const fixed = new Slice(Fragment.fromJSON(view.state.schema, json.content), slice.openStart, slice.openEnd);
  view.dispatch(view.state.tr.replaceSelection(fixed).scrollIntoView());
}

export const baseExtensions = [
  StarterKit.configure({ codeBlock: false }),
  CodeBlockLowlight.configure({ lowlight }),
  // Los enlaces se abren desde la burbuja (clic) o con Ctrl/⌘+clic
  Link.configure({ openOnClick: false, autolink: true, HTMLAttributes: { rel: 'noopener noreferrer' } }),
  ResizableImage.configure({ allowBase64: false }),
  TaskList,
  TaskItem.configure({ nested: true }),
  // copiar/exportar sin perder tablas; columnas redimensionables arrastrando el borde
  withMarkdownTables(Table).configure({ resizable: true, cellMinWidth: 60 }),
  TableRow,
  withCellAlign(TableHeader),
  withCellAlign(TableCell),
  Markdown.configure({
    html: false,
    linkify: true,
    transformPastedText: true,
    transformCopiedText: true,
  }),
];

export default function Editor({ initialContent, onChange, onFileUploaded, pageId, pages = [], onReady, onFocusChange }) {
  const fileInputRef = useRef(null);
  const wrapRef = useRef(null);
  const pagesRef = useRef(pages);
  pagesRef.current = pages;
  const [uploads, setUploads] = useState([]); // archivos (no imagen) pegados/arrastrados subiendo ahora
  const [link, setLink] = useState(null); // enlace con la burbuja abierta

  // Imágenes: se ven al instante en su sitio; el resto de archivos, al terminar la subida
  const uploadAndInsert = async (editor, all, pos) => {
    const images = all.filter((f) => f.type.startsWith('image/'));
    const files = all.filter((f) => !f.type.startsWith('image/'));
    if (images.length) insertImages(editor, images, pageId, pos, onFileUploaded);
    for (const file of files) {
      const key = `${file.name}-${Math.random().toString(36).slice(2)}`;
      setUploads((u) => [...u, { key, name: file.name, pct: 0 }]);
      try {
        const meta = await api.uploadFile(file, pageId, (frac) =>
          setUploads((u) => u.map((it) => (it.key === key ? { ...it, pct: Math.round(frac * 100) } : it)))
        );
        setUploads((u) => u.filter((it) => it.key !== key));
        editor
          .chain()
          .focus()
          .insertContent({
            type: 'paragraph',
            content: [
              {
                type: 'text',
                text: `📎 ${meta.name}`,
                marks: [{ type: 'link', attrs: { href: meta.url } }],
              },
            ],
          })
          .run();
        onFileUploaded?.(meta);
      } catch (err) {
        console.error('Error subiendo archivo', err);
        setUploads((u) => u.map((it) => (it.key === key ? { ...it, error: err.message } : it)));
      }
    }
  };

  const editor = useEditor({
    extensions: [
      ...baseExtensions,
      TabHandler,
      SlashCommands,
      HeadingFold.configure({ pageId }),
      PageLinkSuggest.configure({ getPages: () => pagesRef.current, currentId: pageId }),
      TableNav,
      Placeholder.configure({
        placeholder: "Escribe algo, pega Markdown de Claude, o usa '/' para comandos…",
      }),
    ],
    content: initialContent || '',
    editorProps: {
      transformPasted: (slice, view) => splitPastedBreaks(slice, view.state.schema),
      handlePaste: (view, event) => {
        const files = Array.from(event.clipboardData?.files || []);
        if (files.length > 0) {
          event.preventDefault();
          uploadAndInsert(editorRef.current, files);
          return true;
        }
        // Pegar la URL de una página de NoNotion → enlace con su título
        const text = (event.clipboardData?.getData('text/plain') || '').trim();
        if (/<!--\s*TBLFM:/.test(text) && !event.clipboardData?.getData('text/html')) {
          event.preventDefault();
          pasteMarkdownWithFormulas(view, editorRef.current, text);
          return true;
        }
        const linked = /^https?:\/\/\S+$/.test(text) && pageIdFromHref(text);
        const page = linked && pagesRef.current.find((p) => p.id === linked);
        if (page && view.state.selection.empty) {
          event.preventDefault();
          editorRef.current
            .chain()
            .focus()
            .insertContent([
              {
                type: 'text',
                text: `${page.icon ? page.icon + ' ' : ''}${page.title || 'Sin título'}`,
                marks: [{ type: 'link', attrs: { href: `/p/${page.id}` } }],
              },
              { type: 'text', text: ' ' },
            ])
            .run();
          return true;
        }
        return false;
      },
      handleDrop: (view, event, slice, moved) => {
        if (moved) return false;
        const files = Array.from(event.dataTransfer?.files || []);
        if (files.length > 0) {
          event.preventDefault();
          // donde se suelta, no donde estaba el cursor
          const at = view.posAtCoords({ left: event.clientX, top: event.clientY });
          uploadAndInsert(editorRef.current, files, at?.pos);
          return true;
        }
        return false;
      },
      handleDOMEvents: {
        // Clic en un enlace: burbuja; con Ctrl/⌘, pestaña nueva directamente
        click: (view, event) => {
          const l = event.button === 0 && linkAt(view, event);
          if (!l) return false;
          if (event.ctrlKey || event.metaKey) {
            event.preventDefault();
            openInNewTab(l.href);
            return true;
          }
          setLink(l);
          return false;
        },
        // clic central en un enlace: pestaña nueva
        auxclick: (view, event) => {
          const a = event.button === 1 && event.target.closest?.('a[href]');
          if (!a) return false;
          event.preventDefault();
          openInNewTab(a.getAttribute('href'));
          return true;
        },
      },
    },
    onUpdate: ({ editor }) => {
      onChange?.({ json: editor.getJSON(), text: editor.getText() });
    },
    onFocus: () => onFocusChange?.(true),
    onBlur: () => onFocusChange?.(false),
  });

  const editorRef = useRef(null);
  editorRef.current = editor;
  const closeLink = useCallback(() => setLink(null), []);

  useEffect(() => {
    onReady?.(editor);
  }, [editor, onReady]);

  useEffect(() => {
    const handler = () => fileInputRef.current?.click();
    document.addEventListener('nonotion:insert-image', handler);
    return () => document.removeEventListener('nonotion:insert-image', handler);
  }, []);

  return (
    <>
      <div className="editor-wrap" ref={wrapRef}>
        <EditorContent editor={editor} className="editor" />
        <TableToolbar editor={editor} containerRef={wrapRef} />
        <LinkPopover editor={editor} containerRef={wrapRef} pages={pages} link={link} onClose={closeLink} />
      </div>
      {uploads.length > 0 && (
        <ul className="upload-list editor-uploads">
          {uploads.map((u) => (
            <li key={u.key} className={'upload-item' + (u.error ? ' error' : '')}>
              <div className="upload-row">
                <span className="upload-name">{u.name}</span>
                <span className="upload-pct">{u.error ? '⚠' : `${u.pct}%`}</span>
                {u.error && (
                  <button
                    className="icon-btn"
                    title="Cerrar"
                    onClick={() => setUploads((list) => list.filter((it) => it.key !== u.key))}
                  >
                    ✕
                  </button>
                )}
              </div>
              {u.error ? (
                <div className="upload-error">{u.error}</div>
              ) : (
                <div className="upload-bar">
                  <div className="upload-bar-fill" style={{ width: `${u.pct}%` }} />
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
      <input
        ref={fileInputRef}
        type="file"
        accept="image/*"
        multiple
        hidden
        onChange={(e) => {
          const files = Array.from(e.target.files || []);
          if (files.length && editorRef.current) uploadAndInsert(editorRef.current, files);
          e.target.value = '';
        }}
      />
    </>
  );
}
