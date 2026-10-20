import { useEffect, useState } from 'react';
import { TextSelection } from '@tiptap/pm/state';
import { CellSelection, TableMap } from '@tiptap/pm/tables';

// Barra flotante sobre la tabla en la que está el cursor: ordenar por la
// columna actual, copiar para Excel y añadir/quitar filas y columnas.

// Tabla y celda en la que está la selección, o null
function currentTable(state) {
  const sel = state.selection;
  const $pos = sel instanceof CellSelection ? sel.$anchorCell : sel.$from;
  let tableDepth = 0;
  let cellDepth = 0;
  for (let d = $pos.depth; d > 0; d--) {
    const name = $pos.node(d).type.name;
    if (!cellDepth && (name === 'tableCell' || name === 'tableHeader')) cellDepth = d;
    if (name === 'table') {
      tableDepth = d;
      break;
    }
  }
  if (!tableDepth) return null;
  const table = $pos.node(tableDepth);
  const pos = $pos.before(tableDepth);
  const map = TableMap.get(table);
  let col = 0;
  if (sel instanceof CellSelection) {
    col = map.findCell(sel.$anchorCell.pos - pos - 1).left;
  } else if (cellDepth) {
    col = map.findCell($pos.before(cellDepth) - pos - 1).left;
  }
  return { table, pos, map, col };
}

// Texto de una celda: cada párrafo o elemento de lista en una línea
function cellLines(cell) {
  const lines = [];
  cell.descendants((node) => {
    if (node.isTextblock) {
      lines.push(node.textContent);
      return false;
    }
    return true;
  });
  return lines;
}

const hasHeaderRow = (table) => {
  const first = table.firstChild;
  let all = first.childCount > 0;
  first.forEach((cell) => {
    if (cell.type.name !== 'tableHeader') all = false;
  });
  return all;
};

// Números con formato español o inglés ("1.234,5", "12%", "3,5 €")
function asNumber(s) {
  const t = s.replace(/[\s€$%]/g, '');
  if (!/^-?[\d.,]+$/.test(t)) return null;
  let norm = t;
  if (t.includes(',') && t.includes('.')) {
    norm = t.lastIndexOf(',') > t.lastIndexOf('.') ? t.replace(/\./g, '').replace(',', '.') : t.replace(/,/g, '');
  } else if (t.includes(',')) {
    norm = /,\d{3}$/.test(t) && !/^-?0,/.test(t) ? t.replace(/,/g, '') : t.replace(',', '.');
  }
  const n = Number(norm);
  return Number.isFinite(n) ? n : null;
}

const collator = new Intl.Collator('es', { numeric: true, sensitivity: 'base' });

export function sortTable(editor, dir) {
  const info = currentTable(editor.state);
  if (!info) return 'Sitúa el cursor en una tabla';
  const { table, pos, map, col } = info;
  let merged = false;
  table.descendants((node) => {
    if (node.attrs?.rowspan > 1) merged = true;
    return !node.isTextblock;
  });
  if (merged) return 'No se puede ordenar una tabla con celdas combinadas verticalmente';

  const rows = [];
  table.forEach((row, offset, i) => {
    // celda que ocupa la columna col en esta fila
    const cellOffset = map.map[i * map.width + col];
    const cell = table.nodeAt(cellOffset);
    rows.push({ row, key: cell ? cell.textContent.trim() : '' });
  });
  const head = hasHeaderRow(table) ? rows.slice(0, 1) : [];
  const body = rows.slice(head.length);
  const sign = dir === 'desc' ? -1 : 1;
  const sorted = body
    .map((r, i) => ({ ...r, i }))
    .sort((a, b) => {
      if (!a.key || !b.key) return a.key ? -1 : b.key ? 1 : a.i - b.i; // vacías al final
      const na = asNumber(a.key);
      const nb = asNumber(b.key);
      const c = na !== null && nb !== null ? na - nb : collator.compare(a.key, b.key);
      return c * sign || a.i - b.i;
    });
  const newTable = table.type.create(table.attrs, [...head, ...sorted].map((r) => r.row), table.marks);
  // El cursor se queda en el mismo sitio de la tabla (misma columna) para
  // poder seguir ordenando o editando
  const rel = editor.state.selection.from - pos;
  const tr = editor.state.tr.replaceWith(pos, pos + table.nodeSize, newTable);
  tr.setSelection(TextSelection.near(tr.doc.resolve(Math.min(pos + rel, pos + newTable.nodeSize - 2))));
  editor.view.dispatch(tr);
  return null;
}

const escapeHtml = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// Copia la tabla como TSV (texto) y HTML: Excel y Google Sheets la pegan en celdas
export async function copyTable(editor) {
  const info = currentTable(editor.state);
  if (!info) return false;
  const tsvRows = [];
  const htmlRows = [];
  info.table.forEach((row) => {
    const tsv = [];
    const html = [];
    row.forEach((cell) => {
      const lines = cellLines(cell);
      const text = lines.join('\n');
      tsv.push(/[\t\n"]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text);
      for (let k = 1; k < (cell.attrs.colspan || 1); k++) tsv.push('');
      const tag = cell.type.name === 'tableHeader' ? 'th' : 'td';
      const span = cell.attrs.colspan > 1 ? ` colspan="${cell.attrs.colspan}"` : '';
      const rspan = cell.attrs.rowspan > 1 ? ` rowspan="${cell.attrs.rowspan}"` : '';
      html.push(`<${tag}${span}${rspan}>${lines.map(escapeHtml).join('<br>')}</${tag}>`);
    });
    tsvRows.push(tsv.join('\t'));
    htmlRows.push(`<tr>${html.join('')}</tr>`);
  });
  const tsv = tsvRows.join('\n');
  const html = `<table>${htmlRows.join('')}</table>`;
  try {
    await navigator.clipboard.write([
      new ClipboardItem({
        'text/plain': new Blob([tsv], { type: 'text/plain' }),
        'text/html': new Blob([html], { type: 'text/html' }),
      }),
    ]);
  } catch {
    await navigator.clipboard.writeText(tsv);
  }
  return true;
}

export default function TableToolbar({ editor, containerRef }) {
  const [box, setBox] = useState(null); // { top, left, width } relativo al contenedor
  const [msg, setMsg] = useState(null);

  useEffect(() => {
    if (!editor) return;
    const update = () => {
      const info = editor.isFocused || editor.view.hasFocus() ? currentTable(editor.state) : null;
      const container = containerRef.current;
      if (!info || !container) return setBox(null);
      const dom = editor.view.nodeDOM(info.pos);
      if (!(dom instanceof HTMLElement)) return setBox(null);
      const a = dom.getBoundingClientRect();
      const c = container.getBoundingClientRect();
      setBox({ top: a.top - c.top, left: a.left - c.left, col: info.col });
    };
    const hide = () => setTimeout(update, 150); // deja terminar el clic en la barra
    editor.on('selectionUpdate', update);
    editor.on('update', update);
    editor.on('focus', update);
    editor.on('blur', hide);
    return () => {
      editor.off('selectionUpdate', update);
      editor.off('update', update);
      editor.off('focus', update);
      editor.off('blur', hide);
    };
  }, [editor, containerRef]);

  useEffect(() => {
    if (!msg) return;
    const t = setTimeout(() => setMsg(null), 2500);
    return () => clearTimeout(t);
  }, [msg]);

  if (!box || !editor) return null;

  // mousedown + preventDefault: el editor no pierde el foco ni la selección
  const act = (fn) => (e) => {
    e.preventDefault();
    fn();
  };
  const chain = () => editor.chain().focus();

  return (
    <div className="table-toolbar" style={{ top: box.top, left: box.left }}>
      <span className="table-toolbar-label">Col. {box.col + 1}:</span>
      <button title="Ordenar filas por esta columna (A→Z, 0→9)" onMouseDown={act(() => setMsg(sortTable(editor, 'asc')))}>
        ↑ A-Z
      </button>
      <button title="Ordenar filas por esta columna (Z→A, 9→0)" onMouseDown={act(() => setMsg(sortTable(editor, 'desc')))}>
        ↓ Z-A
      </button>
      <span className="table-toolbar-sep" />
      <button title="Añadir fila debajo" onMouseDown={act(() => chain().addRowAfter().run())}>
        + Fila
      </button>
      <button title="Añadir columna a la derecha" onMouseDown={act(() => chain().addColumnAfter().run())}>
        + Col
      </button>
      <button title="Eliminar fila" onMouseDown={act(() => chain().deleteRow().run())}>
        − Fila
      </button>
      <button title="Eliminar columna" onMouseDown={act(() => chain().deleteColumn().run())}>
        − Col
      </button>
      <span className="table-toolbar-sep" />
      <button
        title="Copiar la tabla para pegarla en Excel o Google Sheets"
        onMouseDown={act(async () => setMsg((await copyTable(editor)) ? '✓ Tabla copiada: pégala en Excel' : null))}
      >
        ⧉ Copiar para Excel
      </button>
      {msg && <span className="table-toolbar-msg">{msg}</span>}
    </div>
  );
}
