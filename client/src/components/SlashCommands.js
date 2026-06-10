import { Extension } from '@tiptap/core';
import Suggestion from '@tiptap/suggestion';

const ITEMS = [
  {
    title: 'Texto',
    hint: 'Párrafo normal',
    icon: '¶',
    keywords: 'texto parrafo paragraph',
    run: (e, r) => e.chain().focus().deleteRange(r).setParagraph().run(),
  },
  {
    title: 'Encabezado 1',
    hint: 'Título grande',
    icon: 'H1',
    keywords: 'h1 titulo heading',
    run: (e, r) => e.chain().focus().deleteRange(r).setNode('heading', { level: 1 }).run(),
  },
  {
    title: 'Encabezado 2',
    hint: 'Título mediano',
    icon: 'H2',
    keywords: 'h2 subtitulo heading',
    run: (e, r) => e.chain().focus().deleteRange(r).setNode('heading', { level: 2 }).run(),
  },
  {
    title: 'Encabezado 3',
    hint: 'Título pequeño',
    icon: 'H3',
    keywords: 'h3 heading',
    run: (e, r) => e.chain().focus().deleteRange(r).setNode('heading', { level: 3 }).run(),
  },
  {
    title: 'Lista',
    hint: 'Lista con viñetas',
    icon: '•',
    keywords: 'lista bullet viñetas ul',
    run: (e, r) => e.chain().focus().deleteRange(r).toggleBulletList().run(),
  },
  {
    title: 'Lista numerada',
    hint: 'Lista ordenada',
    icon: '1.',
    keywords: 'numerada ordenada ol numeros',
    run: (e, r) => e.chain().focus().deleteRange(r).toggleOrderedList().run(),
  },
  {
    title: 'Lista de tareas',
    hint: 'Casillas de verificación',
    icon: '☑',
    keywords: 'tareas todo checkbox check',
    run: (e, r) => e.chain().focus().deleteRange(r).toggleTaskList().run(),
  },
  {
    title: 'Cita',
    hint: 'Bloque de cita',
    icon: '❝',
    keywords: 'cita quote blockquote',
    run: (e, r) => e.chain().focus().deleteRange(r).toggleBlockquote().run(),
  },
  {
    title: 'Bloque de código',
    hint: 'Código con resaltado de sintaxis',
    icon: '</>',
    keywords: 'codigo code programar snippet',
    run: (e, r) => e.chain().focus().deleteRange(r).toggleCodeBlock().run(),
  },
  {
    title: 'Tabla',
    hint: 'Tabla de 3×3',
    icon: '▦',
    keywords: 'tabla table',
    run: (e, r) =>
      e.chain().focus().deleteRange(r).insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run(),
  },
  {
    title: 'Separador',
    hint: 'Línea divisoria',
    icon: '—',
    keywords: 'separador divisor hr linea',
    run: (e, r) => e.chain().focus().deleteRange(r).setHorizontalRule().run(),
  },
  {
    title: 'Imagen',
    hint: 'Subir una imagen',
    icon: '🖼',
    keywords: 'imagen foto image picture',
    run: (e, r) => {
      e.chain().focus().deleteRange(r).run();
      document.dispatchEvent(new CustomEvent('nonotion:insert-image'));
    },
  },
];

function createMenu() {
  let el = null;
  let selected = 0;
  let currentItems = [];
  let currentCommand = null;

  const renderItems = () => {
    if (!el) return;
    el.innerHTML = '';
    currentItems.forEach((item, i) => {
      const btn = document.createElement('button');
      btn.className = 'slash-item' + (i === selected ? ' selected' : '');
      btn.innerHTML = `<span class="slash-icon">${item.icon}</span><span><span class="slash-title">${item.title}</span><span class="slash-hint">${item.hint}</span></span>`;
      btn.addEventListener('mousedown', (ev) => {
        ev.preventDefault();
        currentCommand(item);
      });
      el.appendChild(btn);
    });
    if (currentItems.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'slash-empty';
      empty.textContent = 'Sin resultados';
      el.appendChild(empty);
    }
  };

  const position = (clientRect) => {
    if (!el || !clientRect) return;
    const rect = clientRect();
    if (!rect) return;
    el.style.left = `${rect.left + window.scrollX}px`;
    const below = rect.bottom + window.scrollY + 6;
    el.style.top = `${below}px`;
    const menuRect = el.getBoundingClientRect();
    if (rect.bottom + menuRect.height + 10 > window.innerHeight) {
      el.style.top = `${rect.top + window.scrollY - menuRect.height - 6}px`;
    }
  };

  return {
    onStart(props) {
      el = document.createElement('div');
      el.className = 'slash-menu';
      document.body.appendChild(el);
      selected = 0;
      currentItems = props.items;
      currentCommand = props.command;
      renderItems();
      position(props.clientRect);
    },
    onUpdate(props) {
      currentItems = props.items;
      currentCommand = props.command;
      if (selected >= currentItems.length) selected = 0;
      renderItems();
      position(props.clientRect);
    },
    onKeyDown(props) {
      if (props.event.key === 'Escape') return true;
      if (props.event.key === 'ArrowDown') {
        selected = (selected + 1) % Math.max(currentItems.length, 1);
        renderItems();
        return true;
      }
      if (props.event.key === 'ArrowUp') {
        selected = (selected - 1 + Math.max(currentItems.length, 1)) % Math.max(currentItems.length, 1);
        renderItems();
        return true;
      }
      if (props.event.key === 'Enter') {
        if (currentItems[selected]) currentCommand(currentItems[selected]);
        return true;
      }
      return false;
    },
    onExit() {
      el?.remove();
      el = null;
    },
  };
}

const SlashCommands = Extension.create({
  name: 'slashCommands',

  addProseMirrorPlugins() {
    return [
      Suggestion({
        editor: this.editor,
        char: '/',
        allowSpaces: false,
        command: ({ editor, range, props }) => props.run(editor, range),
        items: ({ query }) =>
          ITEMS.filter((i) =>
            (i.title + ' ' + i.keywords).toLowerCase().includes(query.toLowerCase())
          ),
        render: createMenu,
      }),
    ];
  },
});

export default SlashCommands;
