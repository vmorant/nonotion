// Serialización de tablas a Markdown que NUNCA pierde contenido.
//
// tiptap-markdown solo sabe escribir tablas "simples" (fila de cabecera y una
// sola línea por celda). Con cualquier otra (dos párrafos en una celda, una
// lista, celdas combinadas, sin cabecera) escribía el texto literal "[table]"
// y la tabla desaparecía al guardar ese Markdown. Aquí siempre se escribe una
// tabla GFM: los bloques de una celda se unen con <br>, que splitCellBreaks()
// vuelve a separar en párrafos al leer.
//
// Es una fábrica sin imports para usar la misma lógica en el navegador y en el
// servidor, cada uno con su propia copia de @tiptap/extension-table.

const BR_RE = /<br\s*\/?>/i;

function cellText(state, cell) {
  const parts = [];
  // Con inTable=false los saltos de línea salen como "\\\n" (en vez de
  // "[hardBreak]") y aquí se convierten en <br>
  const wasInTable = state.inTable;
  state.inTable = false;
  const renderBlock = (block, prefix = '') => {
    if (block.type.name === 'paragraph' || block.type.name === 'heading') {
      const start = state.out.length;
      state.renderInline(block);
      const seg = state.out.slice(start).replace(/\\\n/g, '<br>');
      state.out = state.out.slice(0, start);
      if (seg.trim()) parts.push(prefix + seg);
    } else if (/list/i.test(block.type.name)) {
      block.forEach((item, _, i) => {
        const bullet = block.type.name === 'orderedList' ? `${i + 1}. ` : item.attrs?.checked !== undefined ? (item.attrs.checked ? '☑ ' : '☐ ') : '• ';
        item.forEach((child) => renderBlock(child, prefix + bullet));
      });
    } else if (block.textContent.trim()) {
      parts.push(prefix + block.textContent);
    }
  };
  cell.forEach((block) => renderBlock(block));
  state.inTable = wasInTable;
  // Las barras rompen columnas; los saltos de línea, la fila
  return parts
    .join('<br>')
    .replace(/\n/g, '<br>')
    .replace(/\\?\|/g, (m) => (m === '|' ? '\\|' : m));
}

export function withMarkdownTables(Table) {
  return Table.extend({
    addStorage() {
      return {
        markdown: {
          serialize(state, node) {
            state.inTable = true;
            let columns = 0;
            node.forEach((row, _, i) => {
              // Primero el inicio de fila: así el separador del bloque anterior
              // (y el prefijo de lista/cita) se escribe fuera de las celdas
              state.write('| ');
              let n = 0;
              row.forEach((cell) => {
                if (n) state.write(' | ');
                state.write(cellText(state, cell));
                n++;
                // Celdas combinadas: se rellenan columnas vacías para no desalinear
                for (let k = 1; k < (cell.attrs.colspan || 1); k++, n++) state.write(' | ');
              });
              if (!i) columns = n;
              for (; n < columns; n++) state.write(' | ');
              state.write(' |');
              state.ensureNewLine();
              if (!i) {
                state.write(`| ${Array.from({ length: columns }, () => '---').join(' | ')} |`);
                state.ensureNewLine();
              }
            });
            state.closeBlock(node);
            state.inTable = false;
          },
          parse: {
            // lo hace markdown-it
          },
        },
      };
    },
  });
}

// Tras leer Markdown: los <br> literales de las celdas vuelven a ser párrafos
// separados (con html:false markdown-it los deja como texto).
export function splitCellBreaks(json) {
  const walk = (node) => {
    if (!node || typeof node !== 'object') return node;
    if ((node.type === 'tableCell' || node.type === 'tableHeader') && Array.isArray(node.content)) {
      const out = [];
      for (const block of node.content) {
        if (block.type !== 'paragraph' || !Array.isArray(block.content)) {
          out.push(block);
          continue;
        }
        let current = [];
        const flush = () => {
          out.push(current.length ? { type: 'paragraph', content: current } : { type: 'paragraph' });
          current = [];
        };
        for (const inline of block.content) {
          if (inline.type === 'text' && BR_RE.test(inline.text)) {
            const pieces = inline.text.split(/<br\s*\/?>/gi);
            pieces.forEach((piece, idx) => {
              if (idx > 0) flush();
              if (piece) current.push({ ...inline, text: piece });
            });
          } else if (inline.type === 'hardBreak') {
            flush();
          } else {
            current.push(inline);
          }
        }
        flush();
      }
      return { ...node, content: out.map(walk) };
    }
    return Array.isArray(node.content) ? { ...node, content: node.content.map(walk) } : node;
  };
  return walk(json);
}
