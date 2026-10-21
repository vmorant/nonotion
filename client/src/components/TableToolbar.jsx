import { useEffect, useState } from 'react';
import {
  currentTable,
  sortTable,
  copyTable,
  moveRow,
  moveColumn,
  setColumnAlign,
  columnAlign,
  exportCsv,
  setFormulas,
  evaluateFormulas,
} from './tableTools.js';

const FORMULAS_HELP = 'https://github.com/tgrosinger/md-advanced-tables/blob/main/docs/formulas.md';
const SHORTCUTS = [
  'Tab / Mayús+Tab: celda siguiente / anterior (Tab en la última crea fila)',
  'Enter: fila de abajo, misma columna (en la última crea fila)',
  'Mayús+Enter: salto de línea dentro de la celda',
  'Alt+Mayús+↑↓: mover fila · Alt+Mayús+←→: mover columna',
  'Ctrl+Mayús+D: ocultar/mostrar este panel',
  'Escribe "| Col1 | Col2" y pulsa Enter (o Tab) para crear una tabla',
].join('\n');

// Panel de controles de la tabla en la que está el cursor: fijo abajo en la
// pantalla para no tapar el contenido (Ctrl+Mayús+D lo oculta/muestra, como
// en Advanced Tables).

const HIDDEN_KEY = 'nn:tablebar';
const readHidden = () => {
  try {
    return localStorage.getItem(HIDDEN_KEY) === 'off';
  } catch {
    return false;
  }
};

export default function TableToolbar({ editor, containerRef }) {
  const [box, setBox] = useState(null); // { top, left, width } relativo al contenedor
  const [msg, setMsg] = useState(null);
  const [fx, setFx] = useState(null); // texto del editor de fórmulas abierto
  const [hidden, setHidden] = useState(readHidden);

  useEffect(() => {
    const onKey = (e) => {
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === 'd' && box) {
        e.preventDefault();
        setHidden((h) => {
          try {
            localStorage.setItem(HIDDEN_KEY, h ? 'on' : 'off');
          } catch {}
          return !h;
        });
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  useEffect(() => {
    if (!editor) return;
    const update = () => {
      const info = editor.isFocused || editor.view.hasFocus() ? currentTable(editor.state) : null;
      const container = containerRef.current;
      if (!info || !container) return setBox(null);
      const c = container.getBoundingClientRect();
      setBox({
        left: c.left,
        width: c.width,
        col: info.col,
        row: info.row,
        pos: info.pos,
        formulas: info.table.attrs.formulas || '',
        align: columnAlign(editor.state),
      });
    };
    // deja terminar el clic en la barra; con el editor de fórmulas abierto no se oculta
    const hide = () =>
      setTimeout(() => {
        if (!document.activeElement?.closest?.('.table-toolbar')) update();
      }, 150);
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

  // otra tabla: se cierra el editor de fórmulas
  useEffect(() => setFx(null), [box?.pos]);

  useEffect(() => {
    if (!msg) return;
    const t = setTimeout(() => setMsg(null), 3500);
    return () => clearTimeout(t);
  }, [msg]);

  if (!box || !editor || hidden) return null;

  // mousedown + preventDefault: el editor no pierde el foco ni la selección
  const act = (fn) => (e) => {
    e.preventDefault();
    fn();
  };
  const chain = () => editor.chain().focus();
  const calc = async () => setMsg(await evaluateFormulas(editor));
  const pageName = () => document.querySelector('.page-title')?.value || 'tabla';
  // el foco vuelve al editor (con la selección en la tabla) antes de cambiarla
  const saveFx = () => {
    editor.view.focus();
    setFormulas(editor, fx);
    setFx(null);
    calc();
  };

  return (
    <div className="table-toolbar" style={{ left: box.left, width: box.width }} onMouseDown={(e) => e.target.tagName !== 'TEXTAREA' && e.preventDefault()}>
      <div className="table-toolbar-row">
      <span className="table-toolbar-label">Col. {box.col + 1}:</span>
      <button title="Ordenar filas por esta columna (A→Z, 0→9)" onMouseDown={act(() => setMsg(sortTable(editor, 'asc')))}>
        ↑ A-Z
      </button>
      <button title="Ordenar filas por esta columna (Z→A, 9→0)" onMouseDown={act(() => setMsg(sortTable(editor, 'desc')))}>
        ↓ Z-A
      </button>
      {[
        ['left', '⇤', 'Alinear columna a la izquierda'],
        ['center', '↔', 'Centrar columna'],
        ['right', '⇥', 'Alinear columna a la derecha'],
      ].map(([a, label, title]) => (
        <button key={a} className={box.align === a ? 'active' : ''} title={title} onMouseDown={act(() => setColumnAlign(editor, a))}>
          {label}
        </button>
      ))}
      <button title="Mover columna a la izquierda (Alt+Mayús+←)" onMouseDown={act(() => setMsg(moveColumn(editor, -1)))}>
        ◀
      </button>
      <button title="Mover columna a la derecha (Alt+Mayús+→)" onMouseDown={act(() => setMsg(moveColumn(editor, 1)))}>
        ▶
      </button>
      <span className="table-toolbar-sep" />
      <span className="table-toolbar-label">Fila:</span>
      <button title="Mover fila arriba (Alt+Mayús+↑)" onMouseDown={act(() => setMsg(moveRow(editor, -1)))}>
        ▲
      </button>
      <button title="Mover fila abajo (Alt+Mayús+↓)" onMouseDown={act(() => setMsg(moveRow(editor, 1)))}>
        ▼
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
        ⧉ Excel
      </button>
      <button title="Descargar la tabla como CSV" onMouseDown={act(() => exportCsv(editor, pageName()))}>
        ⬇ CSV
      </button>
      <span className="table-toolbar-sep" />
      <button
        className={box.formulas ? 'active' : ''}
        title={box.formulas ? `Fórmulas:\n${box.formulas}` : 'Añadir fórmulas a la tabla (sumas, medias, operaciones…)'}
        onMouseDown={act(() => setFx(fx === null ? box.formulas : null))}
      >
        ƒx
      </button>
      {box.formulas && (
        <button title="Recalcular las fórmulas" onMouseDown={act(calc)}>
          ↻ Calcular
        </button>
      )}
      <span className="table-toolbar-help" title={SHORTCUTS}>
        ⌨
      </span>
      </div>
      {fx !== null && (
        <div className="table-fx">
          <textarea
            autoFocus
            rows={Math.max(2, fx.split('\n').length)}
            value={fx}
            placeholder={'Una fórmula por línea, p. ej.:\n@>$2=sum(@I..@-1)\n$4=($2*$3);%.2f'}
            onChange={(e) => setFx(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                e.preventDefault();
                saveFx();
              }
              if (e.key === 'Escape') {
                editor.view.focus();
                setFx(null);
              }
            }}
          />
          <div className="table-fx-actions">
            <button
              className="primary"
              onMouseDown={act(saveFx)}
            >
              Guardar y calcular
            </button>
            <button onMouseDown={act(() => (editor.view.focus(), setFx(null)))}>Cancelar</button>
            <a href={FORMULAS_HELP} target="_blank" rel="noopener noreferrer">
              Sintaxis (@fila $columna, sum, mean, if…)
            </a>
            <span className="table-fx-hint">Ctrl+Enter guarda · @1 = cabecera, @I = primera fila de datos, @&gt; = última</span>
          </div>
        </div>
      )}
      {msg && <div className="table-toolbar-msg">{msg}</div>}
    </div>
  );
}
