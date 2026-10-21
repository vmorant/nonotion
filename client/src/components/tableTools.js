import { Extension } from '@tiptap/core';
import { TextSelection } from '@tiptap/pm/state';
import { CellSelection, TableMap } from '@tiptap/pm/tables';

// Operaciones de tabla (las de Advanced Tables de Obsidian, sobre las tablas
// visuales del editor): ordenar, mover filas/columnas, alinear columnas,
// navegar como en Excel, copiar/exportar y fórmulas.

// Tabla y celda en la que está la selección, o null
export function currentTable(state) {
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
  let rect = { left: 0, top: 0, bottom: 1 };
  if (sel instanceof CellSelection) {
    rect = map.findCell(sel.$anchorCell.pos - pos - 1);
  } else if (cellDepth) {
    rect = map.findCell($pos.before(cellDepth) - pos - 1);
  }
  return { table, pos, map, col: rect.left, row: rect.top, rowBottom: rect.bottom };
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
export function asNumber(s) {
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


// ---------- Utilidades ----------

function hasMerges(table) {
  let merged = false;
  table.descendants((node) => {
    if (node.attrs?.colspan > 1 || node.attrs?.rowspan > 1) merged = true;
    return !node.isTextblock;
  });
  return merged;
}

// Cursor al principio de la celda (row, col) de la tabla que empieza en tablePos
function selectCell(tr, tablePos, row, col) {
  const table = tr.doc.nodeAt(tablePos);
  const map = TableMap.get(table);
  const r = Math.max(0, Math.min(row, map.height - 1));
  const c = Math.max(0, Math.min(col, map.width - 1));
  const cellPos = tablePos + 1 + map.map[r * map.width + c];
  return tr.setSelection(TextSelection.near(tr.doc.resolve(cellPos + 1)));
}

function replaceTable(editor, info, rows, row, col) {
  const { table, pos } = info;
  const newTable = table.type.create(table.attrs, rows, table.marks);
  const tr = editor.state.tr.replaceWith(pos, pos + table.nodeSize, newTable);
  selectCell(tr, pos, row, col);
  editor.view.dispatch(tr.scrollIntoView());
}

// ---------- Mover filas y columnas ----------

export function moveRow(editor, dir) {
  const info = currentTable(editor.state);
  if (!info) return 'Sitúa el cursor en una tabla';
  if (hasMerges(info.table)) return 'No se pueden mover filas en una tabla con celdas combinadas';
  const first = hasHeaderRow(info.table) ? 1 : 0;
  if (info.row < first) return 'La fila de cabecera se queda arriba';
  const target = info.row + dir;
  if (target < first || target >= info.table.childCount) return null;
  const rows = [];
  info.table.forEach((r) => rows.push(r));
  [rows[info.row], rows[target]] = [rows[target], rows[info.row]];
  replaceTable(editor, info, rows, target, info.col);
  return null;
}

export function moveColumn(editor, dir) {
  const info = currentTable(editor.state);
  if (!info) return 'Sitúa el cursor en una tabla';
  if (hasMerges(info.table)) return 'No se pueden mover columnas en una tabla con celdas combinadas';
  const target = info.col + dir;
  if (target < 0 || target >= info.map.width) return null;
  const rows = [];
  info.table.forEach((r) => {
    const cells = [];
    r.forEach((c) => cells.push(c));
    [cells[info.col], cells[target]] = [cells[target], cells[info.col]];
    rows.push(r.type.create(r.attrs, cells, r.marks));
  });
  replaceTable(editor, info, rows, info.row, target);
  return null;
}

// ---------- Alineación de columna ----------

export function setColumnAlign(editor, align) {
  const info = currentTable(editor.state);
  if (!info) return null;
  const { table, pos, map, col } = info;
  const offsets = new Set();
  for (let r = 0; r < map.height; r++) offsets.add(map.map[r * map.width + col]);
  const tr = editor.state.tr;
  for (const off of offsets) {
    const cell = table.nodeAt(off);
    tr.setNodeMarkup(pos + 1 + off, null, { ...cell.attrs, align: align === 'left' ? null : align });
  }
  editor.view.dispatch(tr);
  return null;
}

export function columnAlign(state) {
  const info = currentTable(state);
  if (!info) return null;
  const cell = info.table.nodeAt(info.map.map[info.col]);
  return cell?.attrs.align || 'left';
}

// ---------- Navegación tipo Excel ----------

// Enter: misma columna, fila siguiente (al final crea una fila nueva)
export function goToRowBelow(editor) {
  const info = currentTable(editor.state);
  if (!info) return false;
  const next = info.rowBottom;
  if (next >= info.map.height) {
    if (!editor.can().addRowAfter()) return false;
    editor.commands.addRowAfter();
  }
  const tr = selectCell(editor.state.tr, info.pos, next, info.col);
  editor.view.dispatch(tr.scrollIntoView());
  return true;
}

// "| Título | Otro" + Enter/Tab en un párrafo → tabla con esa cabecera
export function tableFromPipeLine(editor, mode) {
  const { state } = editor;
  const { $from, empty } = state.selection;
  if (!empty || $from.depth !== 1 || $from.parent.type.name !== 'paragraph') return false;
  const text = $from.parent.textContent.trim();
  if (!text.startsWith('|') || $from.parentOffset !== $from.parent.content.size) return false;
  const cells = text.replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());
  if (!cells.some(Boolean)) return false;
  if (mode === 'tab') cells.push('');
  const { tableHeader, tableCell, tableRow, table, paragraph } = state.schema.nodes;
  const p = (t) => paragraph.create(null, t ? state.schema.text(t) : null);
  const head = tableRow.create(null, cells.map((c) => tableHeader.create(null, p(c))));
  const body = tableRow.create(null, cells.map(() => tableCell.create(null, p(''))));
  const node = table.create(null, [head, body]);
  const from = $from.before(1);
  const tr = state.tr.replaceWith(from, $from.after(1), node);
  selectCell(tr, from, mode === 'tab' ? 0 : 1, mode === 'tab' ? cells.length - 1 : 0);
  editor.view.dispatch(tr.scrollIntoView());
  return true;
}

const inTableCellParagraph = (state) => {
  const { $from, empty } = state.selection;
  if (!empty || $from.depth < 2) return false;
  const name = $from.node(-1).type.name;
  return name === 'tableCell' || name === 'tableHeader';
};

export const TableNav = Extension.create({
  name: 'tableNav',
  priority: 200, // antes que Enter/Tab genéricos
  addKeyboardShortcuts() {
    const ed = this.editor;
    const guard = (fn) => () => (currentTable(ed.state) ? (fn(), true) : false);
    return {
      // con un menú de sugerencias abierto (/ o [[), Enter y Tab son suyos
      Enter: () =>
        !document.querySelector('.slash-menu') &&
        (inTableCellParagraph(ed.state) ? goToRowBelow(ed) : tableFromPipeLine(ed, 'enter')),
      Tab: () => {
        if (document.querySelector('.slash-menu')) return false;
        if (!currentTable(ed.state)) return tableFromPipeLine(ed, 'tab');
        // en una lista dentro de la celda, Tab sigue sangrando la lista
        if (ed.can().sinkListItem('listItem') || ed.can().sinkListItem('taskItem')) return false;
        if (ed.commands.goToNextCell()) return true;
        return ed.chain().addRowAfter().goToNextCell().run();
      },
      'Shift-Tab': () => {
        if (!currentTable(ed.state)) return false;
        if (ed.can().liftListItem('listItem') || ed.can().liftListItem('taskItem')) return false;
        ed.commands.goToPreviousCell();
        return true; // en la primera celda no se sale de la tabla
      },
      'Alt-Shift-ArrowUp': guard(() => moveRow(ed, -1)),
      'Alt-Shift-ArrowDown': guard(() => moveRow(ed, 1)),
      'Alt-Shift-ArrowLeft': guard(() => moveColumn(ed, -1)),
      'Alt-Shift-ArrowRight': guard(() => moveColumn(ed, 1)),
    };
  },
});

// ---------- Exportar a CSV ----------

export function exportCsv(editor, name = 'tabla') {
  const info = currentTable(editor.state);
  if (!info) return;
  const { table, map } = info;
  const lines = [];
  for (let r = 0; r < map.height; r++) {
    const row = [];
    for (let c = 0; c < map.width; c++) {
      const off = map.map[r * map.width + c];
      const first = (c === 0 || map.map[r * map.width + c - 1] !== off) && (r === 0 || map.map[(r - 1) * map.width + c] !== off);
      const text = first ? cellLines(table.nodeAt(off)).join('\n') : '';
      row.push(/[;"\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text);
    }
    lines.push(row.join(';'));
  }
  // BOM + punto y coma: Excel en español lo abre directamente en columnas
  const blob = new Blob(['﻿' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `${name.replace(/[\\/:*?"<>|]/g, '_') || 'tabla'}.csv`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

// ---------- Fórmulas (motor de md-advanced-tables, el de Advanced Tables) ----------

export function setFormulas(editor, text) {
  const info = currentTable(editor.state);
  if (!info) return;
  const clean = text
    .split('\n')
    .map((l) => l.trim().replace(/^<!--\s*TBLFM:\s*/, '').replace(/\s*-->$/, ''))
    .filter(Boolean)
    .join('\n');
  editor.view.dispatch(editor.state.tr.setNodeMarkup(info.pos, null, { ...info.table.attrs, formulas: clean || null }));
}

const NUMERIC = /^-?[\d.,]+\s?[%€$]?$/;
const COMMA_DECIMAL = /^-?\d{1,3}(\.\d{3})*,\d+|^-?\d+,\d{1,2}$/;

// Calcula las fórmulas de la tabla del cursor y escribe los resultados en las
// celdas destino. Devuelve un mensaje para mostrar.
export async function evaluateFormulas(editor) {
  const info = currentTable(editor.state);
  if (!info) return 'Sitúa el cursor en una tabla';
  const formulas = (info.table.attrs.formulas || '').split('\n').filter(Boolean);
  if (!formulas.length) return 'Esta tabla no tiene fórmulas';
  const mod = await import('@tgrosinger/md-advanced-tables');
  const { readTable, defaultOptions } = mod.readTable ? mod : mod.default;

  const { table, map, pos } = info;
  // Rejilla de textos; los números en formato español se pasan a 1234.5
  const anchors = []; // anchors[r][c] = offset de la celda si es su posición principal
  const input = [];
  let comma = false;
  for (let r = 0; r < map.height; r++) {
    anchors.push([]);
    input.push([]);
    for (let c = 0; c < map.width; c++) {
      const off = map.map[r * map.width + c];
      const first = (c === 0 || map.map[r * map.width + c - 1] !== off) && (r === 0 || map.map[(r - 1) * map.width + c] !== off);
      anchors[r].push(first ? off : null);
      let text = first ? cellLines(table.nodeAt(off)).join(' ').trim() : '';
      if (NUMERIC.test(text) && /\d/.test(text)) {
        if (COMMA_DECIMAL.test(text)) comma = true;
        const n = asNumber(text);
        if (n !== null) text = String(n);
      }
      input[r].push(text);
    }
  }
  const esc = (t) => t.replace(/\|/g, '\\|');
  const lines = input.map((row) => `| ${row.map(esc).join(' | ')} |`);
  lines.splice(1, 0, `| ${input[0].map(() => '---').join(' | ')} |`);

  let result;
  try {
    result = readTable(lines, defaultOptions).applyFormulas(formulas.map((f) => `<!-- TBLFM: ${f} -->`));
  } catch (e) {
    return `⚠ Error al calcular: ${e.message.replace(/^\[DecimalError\] Invalid argument: (.*)$/, 'hay un valor no numérico ("$1")')}`;
  }
  if (result.isErr()) return `⚠ ${result.error.message.replace(/^Formula '<!-- TBLFM: (.*) -->' could not be parsed$/, 'Fórmula no válida: $1')}`;

  const out = result.value.getRows().filter((_, i) => i !== 1);
  const updates = [];
  out.forEach((row, r) => {
    row.getCells().forEach((cell, c) => {
      if (r >= map.height || c >= map.width || anchors[r][c] === null) return;
      let text = cell.content.replace(/\\\|/g, '|');
      if (text === input[r][c]) return;
      if (comma && /^-?\d+\.\d+$/.test(text)) text = text.replace('.', ',');
      updates.push({ off: anchors[r][c], text });
    });
  });
  if (!updates.length) return '✓ Fórmulas calculadas (sin cambios)';
  const tr = editor.state.tr;
  const { paragraph } = editor.schema.nodes;
  // de atrás hacia delante: cada cambio no desplaza a los anteriores
  for (const u of updates.sort((a, b) => b.off - a.off)) {
    const cellPos = pos + 1 + u.off;
    const cell = tr.doc.nodeAt(cellPos);
    tr.replaceWith(cellPos + 1, cellPos + cell.nodeSize - 1, paragraph.create(null, u.text ? editor.schema.text(u.text) : null));
  }
  editor.view.dispatch(tr);
  return `✓ ${updates.length} celda${updates.length === 1 ? '' : 's'} calculada${updates.length === 1 ? '' : 's'}`;
}
