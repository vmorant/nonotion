import { Extension } from '@tiptap/core';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';

// Claves de elementos de seguimiento (AXA-12) en cualquier texto: se pintan
// como enlace con su estado y un clic abre el elemento. No cambian el
// documento (son decoraciones), así que el Markdown y Claude siguen viendo
// texto normal.

export const issueRefsKey = new PluginKey('issueRefs');
const KEY_RE = /(^|[^A-Za-z0-9_-])([A-Z][A-Z0-9]{0,9}-\d+)(?![0-9])/g;

function build(doc, index) {
  const decos = [];
  if (!index || !index.size) return DecorationSet.empty;
  doc.descendants((node, pos) => {
    if (!node.isText) return;
    // dentro de un enlace o de código, se deja tal cual
    if (node.marks.some((m) => m.type.name === 'link' || m.type.name === 'code')) return;
    KEY_RE.lastIndex = 0;
    let m;
    while ((m = KEY_RE.exec(node.text))) {
      const issue = index.get(m[2].toUpperCase());
      if (!issue) continue;
      const from = pos + m.index + m[1].length;
      decos.push(
        Decoration.inline(from, from + m[2].length, {
          class: `issue-ref status-${issue.issue_status || 'open'}`,
          'data-issue-id': issue.id,
          title: `${issue.title || 'Sin título'} · clic para abrir`,
        })
      );
    }
  });
  return DecorationSet.create(doc, decos);
}

export const IssueRefs = Extension.create({
  name: 'issueRefs',

  addOptions() {
    return { getIndex: () => null };
  },

  addProseMirrorPlugins() {
    const opts = this.options;
    return [
      new Plugin({
        key: issueRefsKey,
        state: {
          init: (_, { doc }) => build(doc, opts.getIndex()),
          // se recalcula al cambiar el texto o cuando llega un índice nuevo
          apply: (tr, old) => (tr.docChanged || tr.getMeta(issueRefsKey) ? build(tr.doc, opts.getIndex()) : old),
        },
        props: {
          decorations(state) {
            return issueRefsKey.getState(state);
          },
        },
      }),
    ];
  },
});

// Índice clave → página a partir de la lista de páginas del espacio
export function issueIndexFrom(pages) {
  const m = new Map();
  for (const p of pages || []) if (p.issue_key) m.set(p.issue_key.toUpperCase(), p);
  return m;
}
