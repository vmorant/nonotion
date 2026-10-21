// Conversión entre contenido Tiptap (JSON) y Markdown en el servidor, usando
// el mismo stack del cliente en modo headless (jsdom). Inicialización perezosa.
//
// Regla para no perder nada: el Markdown sirve para LEER (Claude, export) y
// para ESCRIBIR fragmentos nuevos. Nunca se reescribe una página entera a
// partir de su propio Markdown: añadir y editar trabajan sobre el documento y
// solo tocan los bloques afectados.
import { withMarkdownTables, splitCellBreaks } from '../client/src/tableMarkdown.js';
import { withImageAttrs } from '../client/src/imageAttrs.js';

let editorPromise = null;

async function createEditor() {
  const { JSDOM } = await import('jsdom');
  const dom = new JSDOM('<!doctype html><html><body></body></html>');
  const w = dom.window;
  global.window = w;
  global.document = w.document;
  Object.defineProperty(global, 'navigator', { value: w.navigator, configurable: true });
  for (const k of [
    'MutationObserver', 'Node', 'Element', 'HTMLElement', 'Text', 'DOMParser',
    'XMLSerializer', 'ClipboardEvent', 'InputEvent', 'KeyboardEvent', 'MouseEvent',
    'CustomEvent', 'Range', 'NodeFilter',
  ]) {
    if (global[k] === undefined) global[k] = w[k];
  }
  if (global.DragEvent === undefined) global.DragEvent = w.Event;
  if (global.getComputedStyle === undefined) global.getComputedStyle = w.getComputedStyle;
  if (global.requestAnimationFrame === undefined) global.requestAnimationFrame = (cb) => setTimeout(cb, 0);

  const { Editor } = await import('@tiptap/core');
  const StarterKit = (await import('@tiptap/starter-kit')).default;
  const Link = (await import('@tiptap/extension-link')).default;
  const Image = (await import('@tiptap/extension-image')).default;
  const TaskList = (await import('@tiptap/extension-task-list')).default;
  const TaskItem = (await import('@tiptap/extension-task-item')).default;
  const Table = (await import('@tiptap/extension-table')).default;
  const TableRow = (await import('@tiptap/extension-table-row')).default;
  const TableHeader = (await import('@tiptap/extension-table-header')).default;
  const TableCell = (await import('@tiptap/extension-table-cell')).default;
  const CodeBlockLowlight = (await import('@tiptap/extension-code-block-lowlight')).default;
  const { createLowlight, common } = await import('lowlight');
  const { Markdown } = await import('tiptap-markdown');

  return new Editor({
    element: w.document.createElement('div'),
    extensions: [
      StarterKit.configure({ codeBlock: false }),
      CodeBlockLowlight.configure({ lowlight: createLowlight(common) }),
      Link.configure({ openOnClick: false, autolink: true }),
      withImageAttrs(Image), // conserva ancho y alineación
      TaskList,
      TaskItem.configure({ nested: true }),
      withMarkdownTables(Table),
      TableRow,
      TableHeader,
      TableCell,
      Markdown.configure({ html: false }),
    ],
    content: '',
  });
}

async function getEditor() {
  if (!editorPromise) editorPromise = createEditor();
  return editorPromise;
}

const isRawMarkdown = (content) => typeof content === 'string' && !content.trim().startsWith('{');

export async function docToMarkdown(content) {
  if (!content) return '';
  // Las páginas capturadas antiguas guardan markdown crudo: va tal cual.
  if (isRawMarkdown(content)) return content;
  let doc = content;
  if (typeof doc === 'string') {
    try {
      doc = JSON.parse(doc);
    } catch {
      return content;
    }
  }
  const editor = await getEditor();
  editor.commands.setContent(doc);
  return editor.storage.markdown.getMarkdown();
}

// Markdown -> documento Tiptap (JSON), igual que lo haría el editor web
export async function markdownToDoc(markdown) {
  const editor = await getEditor();
  editor.commands.setContent(markdown || '');
  return splitCellBreaks(editor.getJSON());
}

// Contenido almacenado (JSON o markdown crudo) -> documento Tiptap
export async function toDoc(content) {
  if (!content) return { type: 'doc', content: [] };
  if (isRawMarkdown(content)) return markdownToDoc(content);
  try {
    const doc = typeof content === 'string' ? JSON.parse(content) : content;
    return { type: 'doc', content: [], ...doc };
  } catch {
    return markdownToDoc(String(content));
  }
}

const isEmptyParagraph = (n) => n && n.type === 'paragraph' && !(n.content && n.content.length);

// Añade Markdown al final sin tocar lo que ya hay (las tablas complejas,
// imágenes, etc. de la página quedan exactamente como estaban)
export async function appendMarkdown(content, markdown) {
  const doc = await toDoc(content);
  const extra = (await markdownToDoc(markdown)).content || [];
  const current = [...(doc.content || [])];
  while (current.length && isEmptyParagraph(current[current.length - 1])) current.pop();
  return { ...doc, content: [...current, ...extra] };
}

export class EditError extends Error {
  constructor(message, code) {
    super(message);
    this.code = code;
  }
}

// Sustituye un fragmento exacto del Markdown de la página. Solo se vuelven a
// generar los bloques que contienen el fragmento; el resto del documento no
// pasa por Markdown y queda intacto.
export async function replaceInDoc(content, find, replace) {
  if (!find) throw new EditError('find_text está vacío', 'empty');
  const doc = await toDoc(content);
  const blocks = doc.content || [];
  const editor = await getEditor();
  const pieces = blocks.map((b) => {
    editor.commands.setContent({ type: 'doc', content: [b] });
    return editor.storage.markdown.getMarkdown();
  });
  const SEP = '\n\n';
  const full = pieces.join(SEP);
  const at = full.indexOf(find);
  if (at < 0) throw new EditError('find_text no aparece en la página', 'not_found');
  if (full.indexOf(find, at + 1) >= 0) throw new EditError('find_text aparece más de una vez', 'ambiguous');
  const end = at + find.length;
  // Bloques que solapan con el fragmento
  let pos = 0;
  let first = -1;
  let last = -1;
  pieces.forEach((piece, i) => {
    const s = pos;
    const e = pos + piece.length;
    if (first < 0 && end > s && at < e + SEP.length) first = i;
    if (at < e && end > s) last = i;
    pos = e + SEP.length;
  });
  if (first < 0) first = 0;
  if (last < first) last = first;
  const offset = pieces.slice(0, first).reduce((n, p) => n + p.length + SEP.length, 0);
  const segment = pieces.slice(first, last + 1).join(SEP);
  const edited = segment.slice(0, at - offset) + replace + segment.slice(end - offset);
  const newBlocks = edited.trim() ? (await markdownToDoc(edited)).content || [] : [];
  return { ...doc, content: [...blocks.slice(0, first), ...newBlocks, ...blocks.slice(last + 1)] };
}
