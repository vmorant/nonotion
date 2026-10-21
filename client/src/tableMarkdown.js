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
  // tiptap-markdown apunta posiciones de negritas/cursivas para retocarlas
  // después; el texto de la celda se recorta de la salida, así que esas
  // posiciones quedarían desfasadas y estropearían otro sitio
  const inlinesBefore = state.inlines ? state.inlines.length : 0;
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
  if (state.inlines) state.inlines.length = Math.min(state.inlines.length, inlinesBefore);
  state.inTable = wasInTable;
  // Las barras rompen columnas; los saltos de línea, la fila
  return parts
    .join('<br>')
    .replace(/\n/g, '<br>')
    .replace(/\\?\|/g, (m) => (m === '|' ? '\\|' : m));
}

// Columnas más anchas que esto no se rellenan con espacios (evita Markdown
// enorme con celdas largas); las demás quedan alineadas como en Advanced Tables
const PAD_MAX = 60;
const ALIGN_MARK = { left: [':', '-'], center: [':', ':'], right: ['-', ':'] };
const TBLFM_RE = /^<!--\s*TBLFM:\s*(.*?)\s*-->$/;
const MARK = 'NNTBLFM';
const MARK_RE = /^NNTBLFM([0-9a-f]+)$/;

const toHex = (str) => [...new TextEncoder().encode(str)].map((b) => b.toString(16).padStart(2, '0')).join('');
const fromHex = (hex) => new TextDecoder().decode(new Uint8Array(hex.match(/../g).map((h) => parseInt(h, 16))));

// Antes de leer Markdown: markdown-it tomaría las líneas <!-- TBLFM: … -->
// como filas de la tabla. Cada una pasa a ser un párrafo aparte con una marca
// inocua que fixParsedTables convierte en fórmula de la tabla anterior.
export function protectFormulas(md) {
  if (!md || !md.includes('TBLFM')) return md;
  return md
    .split('\n')
    .map((line) => {
      const m = line.trim().match(TBLFM_RE);
      return m ? `\n${MARK}${toHex(m[1])}\n` : line;
    })
    .join('\n');
}

export function withMarkdownTables(Table) {
  return Table.extend({
    addAttributes() {
      return {
        ...this.parent?.(),
        // Fórmulas estilo Advanced Tables / org-mode, una por línea (sin "<!-- TBLFM: -->")
        formulas: {
          default: null,
          parseHTML: (el) => el.getAttribute('data-formulas') || null,
          renderHTML: (attrs) => (attrs.formulas ? { 'data-formulas': attrs.formulas } : {}),
        },
      };
    },
    addStorage() {
      return {
        markdown: {
          serialize(state, node) {
            // Cierra antes el bloque anterior: su separador no debe acabar
            // dentro del texto capturado de la primera celda
            state.write('');
            state.inTable = true;
            // 1) texto de cada celda; 2) anchos; 3) se escribe alineado
            const rows = [];
            const aligns = [];
            node.forEach((row, _, i) => {
              const cells = [];
              row.forEach((cell) => {
                if (!i) aligns.push(cell.attrs.align || null);
                cells.push(cellText(state, cell));
                // Celdas combinadas: se rellenan columnas vacías para no desalinear
                for (let k = 1; k < (cell.attrs.colspan || 1); k++) {
                  cells.push('');
                  if (!i) aligns.push(null);
                }
              });
              rows.push(cells);
            });
            const columns = rows[0]?.length || 0;
            const widths = Array.from({ length: columns }, (_, c) => {
              const w = Math.max(3, ...rows.map((r) => [...(r[c] || '')].length));
              return w > PAD_MAX ? 0 : w;
            });
            const pad = (text, c) => {
              const w = widths[c];
              const len = [...text].length;
              if (!w || len >= w) return text;
              const gap = w - len;
              if (aligns[c] === 'right') return ' '.repeat(gap) + text;
              if (aligns[c] === 'center') return ' '.repeat(Math.floor(gap / 2)) + text + ' '.repeat(gap - Math.floor(gap / 2));
              return text + ' '.repeat(gap);
            };
            const delimiter = (c) => {
              const [l, r] = ALIGN_MARK[aligns[c]] || ['-', '-'];
              return l + '-'.repeat(Math.max(1, (widths[c] || 3) - 2)) + r;
            };
            rows.forEach((cells, i) => {
              // Primero el inicio de fila: así el separador del bloque anterior
              // (y el prefijo de lista/cita) se escribe fuera de las celdas
              state.write('| ');
              const full = Array.from({ length: columns }, (_, c) => pad(cells[c] || '', c));
              state.write(full.join(' | '));
              state.write(' |');
              state.ensureNewLine();
              if (!i) {
                state.write(`| ${Array.from({ length: columns }, (_, c) => delimiter(c)).join(' | ')} |`);
                state.ensureNewLine();
              }
            });
            // Fórmulas justo debajo, en el formato de Obsidian Advanced Tables
            for (const f of (node.attrs.formulas || '').split('\n').map((x) => x.trim()).filter(Boolean)) {
              state.write(`<!-- TBLFM: ${f} -->`);
              state.ensureNewLine();
            }
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

// Alineación de columna (izquierda/centro/derecha) en celdas y cabeceras; en
// Markdown es la fila separadora (:---, :---:, ---:)
export function withCellAlign(Cell) {
  return Cell.extend({
    addAttributes() {
      return {
        ...this.parent?.(),
        align: {
          default: null,
          parseHTML: (el) => {
            const a = el.style?.textAlign || el.getAttribute('align');
            return ['left', 'center', 'right'].includes(a) ? a : null;
          },
          renderHTML: (attrs) => (attrs.align ? { style: `text-align: ${attrs.align}` } : {}),
        },
      };
    },
  });
}

// Tras leer Markdown: arregla lo que markdown-it no sabe de nuestras tablas
//  - los <br> literales de las celdas vuelven a ser párrafos separados;
//  - las líneas <!-- TBLFM: … --> pasan a ser las fórmulas de la tabla.
export function fixParsedTables(json) {
  return attachFormulas(splitCellBreaks(json));
}

const tblfmOf = (node) => {
  if (node?.type !== 'paragraph' || !Array.isArray(node.content)) return null;
  const text = node.content.map((n) => (n.type === 'text' ? n.text : n.type === 'hardBreak' ? '\n' : '')).join('');
  const lines = text.split(/\s*\n\s*|\s+(?=NNTBLFM)/).map((l) => l.trim()).filter(Boolean);
  if (!lines.length) return null;
  const out = [];
  for (const l of lines) {
    const m = l.match(MARK_RE) || l.match(TBLFM_RE);
    if (!m) return null;
    try {
      out.push(l.startsWith(MARK) ? fromHex(m[1]) : m[1]);
    } catch {
      return null;
    }
  }
  return out;
};

function attachFormulas(json) {
  const walk = (node) => {
    if (!node || typeof node !== 'object' || !Array.isArray(node.content)) return node;
    const out = [];
    for (const child of node.content.map(walk)) {
      const prev = out[out.length - 1];
      const f = prev?.type === 'table' ? tblfmOf(child) : null;
      if (f) {
        const old = prev.attrs?.formulas ? prev.attrs.formulas.split('\n') : [];
        out[out.length - 1] = { ...prev, attrs: { ...(prev.attrs || {}), formulas: [...old, ...f].join('\n') } };
      } else out.push(child);
    }
    return { ...node, content: out };
  };
  return walk(json);
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
