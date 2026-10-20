import { Extension } from '@tiptap/core';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';

// Plegar secciones: cada encabezado de primer nivel del documento tiene un
// triángulo que oculta todo lo que hay debajo hasta el siguiente encabezado de
// igual o mayor rango. Es solo visual (decoraciones): el contenido no cambia,
// se guarda y se exporta entero. Lo plegado se recuerda por página en este
// navegador (nivel + texto del encabezado).

export const foldKey = new PluginKey('headingFold');

// Encabezados de primer nivel: [{ pos, level, text }]
export function topHeadings(doc) {
  const out = [];
  doc.forEach((node, offset) => {
    if (node.type.name === 'heading') out.push({ pos: offset, level: node.attrs.level, text: node.textContent });
  });
  return out;
}

const keyOf = (h) => `${h.level}:${h.text}`;
const storageKey = (pageId) => `nn:folds:${pageId}`;

function loadKeys(pageId) {
  try {
    const v = JSON.parse(localStorage.getItem(storageKey(pageId)) || '[]');
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

function saveKeys(pageId, keys) {
  try {
    if (keys.length) localStorage.setItem(storageKey(pageId), JSON.stringify(keys));
    else localStorage.removeItem(storageKey(pageId));
  } catch {}
}

// Posiciones de los encabezados plegados que siguen existiendo
function cleanFolded(doc, folded) {
  const valid = new Set(topHeadings(doc).map((h) => h.pos));
  return new Set([...folded].filter((p) => valid.has(p)));
}

// Posiciones de los encabezados plegados que ocultan la posición pos
export function foldsHiding(doc, folded, pos) {
  const open = []; // pila de encabezados plegados activos
  let hit = null;
  doc.forEach((node, offset) => {
    if (hit !== null) return;
    if (node.type.name === 'heading') {
      while (open.length && open[open.length - 1].level >= node.attrs.level) open.pop();
      if (offset === pos || (pos > offset && pos < offset + node.nodeSize)) {
        hit = open.map((h) => h.pos);
        return;
      }
      if (folded.has(offset)) open.push({ pos: offset, level: node.attrs.level });
    } else if (pos >= offset && pos < offset + node.nodeSize) {
      hit = open.map((h) => h.pos);
    }
  });
  return hit || [];
}

function buildDecorations(doc, folded) {
  const decos = [];
  let hideLevel = null; // nivel del encabezado plegado que está ocultando
  doc.forEach((node, offset) => {
    const isHeading = node.type.name === 'heading';
    if (hideLevel !== null) {
      if (isHeading && node.attrs.level <= hideLevel) hideLevel = null;
      else {
        decos.push(Decoration.node(offset, offset + node.nodeSize, { class: 'nn-folded' }));
        return;
      }
    }
    if (!isHeading) return;
    const closed = folded.has(offset);
    decos.push(
      Decoration.widget(
        offset + 1,
        (view, getPos) => {
          const btn = document.createElement('span');
          btn.className = 'nn-fold-btn' + (closed ? ' closed' : '');
          btn.contentEditable = 'false';
          btn.title = closed ? 'Desplegar sección' : 'Plegar sección';
          btn.textContent = closed ? '▸' : '▾';
          btn.addEventListener('mousedown', (e) => {
            e.preventDefault();
            e.stopPropagation();
            const p = getPos();
            if (typeof p === 'number') view.dispatch(view.state.tr.setMeta(foldKey, { toggle: p - 1 }));
          });
          return btn;
        },
        { side: -1, ignoreSelection: true, key: `fold:${closed ? 'c' : 'o'}` }
      )
    );
    if (closed) {
      decos.push(Decoration.node(offset, offset + node.nodeSize, { class: 'nn-fold-closed' }));
      hideLevel = node.attrs.level;
    }
  });
  return DecorationSet.create(doc, decos);
}

export const HeadingFold = Extension.create({
  name: 'headingFold',
  addOptions() {
    return { pageId: null };
  },
  addProseMirrorPlugins() {
    const pageId = this.options.pageId;
    return [
      new Plugin({
        key: foldKey,
        state: {
          init: (_, state) => {
            const keys = new Set(pageId ? loadKeys(pageId) : []);
            const folded = new Set(topHeadings(state.doc).filter((h) => keys.has(keyOf(h))).map((h) => h.pos));
            return { folded, decos: buildDecorations(state.doc, folded) };
          },
          apply: (tr, value, _old, state) => {
            const meta = tr.getMeta(foldKey);
            if (!tr.docChanged && !meta) return value;
            let folded = value.folded;
            if (tr.docChanged) folded = new Set([...folded].map((p) => tr.mapping.map(p, 1)));
            if (meta?.toggle !== undefined) {
              folded = new Set(folded);
              if (folded.has(meta.toggle)) folded.delete(meta.toggle);
              else folded.add(meta.toggle);
            }
            if (meta?.set) folded = new Set(meta.set);
            if (meta?.remove) folded = new Set([...folded].filter((p) => !meta.remove.includes(p)));
            folded = cleanFolded(state.doc, folded);
            return { folded, decos: buildDecorations(state.doc, folded) };
          },
        },
        props: {
          decorations(state) {
            return foldKey.getState(state).decos;
          },
        },
        view: () => ({
          update(view, prev) {
            if (!pageId) return;
            const a = foldKey.getState(view.state).folded;
            const b = foldKey.getState(prev).folded;
            if (a === b && view.state.doc === prev.doc) return;
            if (!a.size && !b.size) return;
            const byPos = new Map(topHeadings(view.state.doc).map((h) => [h.pos, h]));
            saveKeys(pageId, [...a].map((p) => byPos.get(p)).filter(Boolean).map(keyOf));
          },
        }),
      }),
    ];
  },
});
