// Smoke test headless: valida que el Markdown (formato de respuestas de Claude)
// se convierte a bloques Tiptap y se exporta de vuelta. Ejecutar: node smoke.mjs
import { JSDOM } from 'jsdom';

const dom = new JSDOM('<!doctype html><html><body></body></html>');
global.window = dom.window;
global.document = dom.window.document;
Object.defineProperty(global, 'navigator', { value: dom.window.navigator, configurable: true });
global.MutationObserver = dom.window.MutationObserver;
global.Node = dom.window.Node;
global.Element = dom.window.Element;
global.HTMLElement = dom.window.HTMLElement;
global.Text = dom.window.Text;
global.DOMParser = dom.window.DOMParser;
global.XMLSerializer = dom.window.XMLSerializer;
global.ClipboardEvent = dom.window.ClipboardEvent;
global.DragEvent = dom.window.Event;
global.InputEvent = dom.window.InputEvent;
global.KeyboardEvent = dom.window.KeyboardEvent;
global.MouseEvent = dom.window.MouseEvent;
global.CustomEvent = dom.window.CustomEvent;
global.Range = dom.window.Range;
global.NodeFilter = dom.window.NodeFilter;
global.getComputedStyle = dom.window.getComputedStyle;
global.requestAnimationFrame = (cb) => setTimeout(cb, 0);

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

const markdown = `# Respuesta de Claude

Aquí tienes un script en **Python** para tu LXC:

\`\`\`python
import os
print("hola proxmox")
\`\`\`

## Pasos

1. Instalar dependencias
2. Configurar \`cloudflared\`

- [ ] Tarea pendiente
- [x] Tarea hecha

| Servicio | Puerto |
| -------- | ------ |
| NoNotion | 3000   |

> Nota: sin límites de capacidad.
`;

const editor = new Editor({
  element: document.createElement('div'),
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
    Markdown.configure({ html: false, linkify: true, transformPastedText: true, transformCopiedText: true }),
  ],
  content: markdown,
});

const json = editor.getJSON();
const types = json.content.map((n) => n.type);
console.log('Tipos de bloque:', types.join(', '));

const assert = (cond, msg) => {
  if (!cond) {
    console.error('❌ FALLO:', msg);
    process.exit(1);
  }
  console.log('✓', msg);
};

assert(types.includes('heading'), 'el encabezado # se convierte en heading');
assert(types.includes('codeBlock'), 'el bloque ``` se convierte en codeBlock');
const code = json.content.find((n) => n.type === 'codeBlock');
assert(code.attrs.language === 'python', 'el codeBlock conserva el lenguaje (python)');
assert(types.includes('orderedList'), 'la lista numerada se convierte');
assert(types.includes('taskList'), 'las casillas - [ ] se convierten en taskList');
assert(types.includes('table'), 'la tabla Markdown se convierte en table');
assert(types.includes('blockquote'), 'la cita > se convierte en blockquote');
assert(JSON.stringify(json).includes('"bold"'), 'las negritas ** se conservan');

const roundtrip = editor.storage.markdown.getMarkdown();
assert(roundtrip.includes('```python'), 'la exportación a Markdown conserva el bloque de código');
assert(roundtrip.includes('| Servicio |'), 'la exportación a Markdown conserva la tabla');

console.log('\n✅ Smoke test del editor superado');
process.exit(0);
