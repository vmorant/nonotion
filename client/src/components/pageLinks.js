import { Extension } from '@tiptap/core';
import { PluginKey } from '@tiptap/pm/state';
import Suggestion from '@tiptap/suggestion';
import { createMenu } from './SlashCommands.js';

// Enlaces entre páginas: escribir [[ abre un buscador de páginas y al elegir
// una inserta un enlace /p/<id> con su icono y título.

const fold = (s) => (s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

export const PageLinkSuggest = Extension.create({
  name: 'pageLinkSuggest',

  addOptions() {
    return { getPages: () => [], currentId: null };
  },

  addProseMirrorPlugins() {
    const opts = this.options;
    return [
      Suggestion({
        editor: this.editor,
        pluginKey: new PluginKey('pageLinkSuggest'),
        char: '[[',
        allowSpaces: true,
        items: ({ query }) => {
          const pages = opts.getPages();
          const byId = new Map(pages.map((p) => [p.id, p]));
          const q = fold(query.replace(/\]+$/, '').trim());
          return pages
            .filter((p) => p.id !== opts.currentId && fold(p.title || 'Sin título').includes(q))
            .sort((a, b) => (b.updated_at || '').localeCompare(a.updated_at || ''))
            .slice(0, 12)
            .map((p) => {
              const parent = p.parent_id ? byId.get(p.parent_id) : null;
              return {
                icon: p.icon || '📄',
                title: p.title || 'Sin título',
                hint: parent ? `en ${parent.title || 'Sin título'}` : 'página raíz',
                page: p,
              };
            });
        },
        command: ({ editor, range, props }) => {
          const p = props.page;
          editor
            .chain()
            .focus()
            .deleteRange(range)
            .insertContent([
              {
                type: 'text',
                text: `${p.icon ? p.icon + ' ' : ''}${p.title || 'Sin título'}`,
                marks: [{ type: 'link', attrs: { href: `/p/${p.id}` } }],
              },
              { type: 'text', text: ' ' },
            ])
            .run();
        },
        render: createMenu,
      }),
    ];
  },
});
