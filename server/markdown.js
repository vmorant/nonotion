// Conversión de contenido Tiptap (JSON) a Markdown en el servidor, usando
// el mismo stack del cliente en modo headless (jsdom). Inicialización perezosa:
// solo paga el coste el primer export.

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
      Image,
      TaskList,
      TaskItem.configure({ nested: true }),
      Table,
      TableRow,
      TableHeader,
      TableCell,
      Markdown.configure({ html: false }),
    ],
    content: '',
  });
}

export async function docToMarkdown(content) {
  if (!content) return '';
  // Las páginas capturadas vía API guardan markdown crudo: va tal cual.
  if (typeof content === 'string' && !content.trim().startsWith('{')) return content;
  let doc = content;
  if (typeof doc === 'string') {
    try {
      doc = JSON.parse(doc);
    } catch {
      return content;
    }
  }
  if (!editorPromise) editorPromise = createEditor();
  const editor = await editorPromise;
  editor.commands.setContent(doc);
  return editor.storage.markdown.getMarkdown();
}
