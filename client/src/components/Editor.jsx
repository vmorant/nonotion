import { useEffect, useRef } from 'react';
import { useEditor, EditorContent } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import Link from '@tiptap/extension-link';
import Image from '@tiptap/extension-image';
import Placeholder from '@tiptap/extension-placeholder';
import TaskList from '@tiptap/extension-task-list';
import TaskItem from '@tiptap/extension-task-item';
import Table from '@tiptap/extension-table';
import TableRow from '@tiptap/extension-table-row';
import TableHeader from '@tiptap/extension-table-header';
import TableCell from '@tiptap/extension-table-cell';
import CodeBlockLowlight from '@tiptap/extension-code-block-lowlight';
import { createLowlight, common } from 'lowlight';
import { Markdown } from 'tiptap-markdown';
import SlashCommands from './SlashCommands.js';
import { api } from '../api.js';

const lowlight = createLowlight(common);

export const baseExtensions = [
  StarterKit.configure({ codeBlock: false }),
  CodeBlockLowlight.configure({ lowlight }),
  Link.configure({ openOnClick: false, autolink: true }),
  Image.configure({ allowBase64: false }),
  TaskList,
  TaskItem.configure({ nested: true }),
  Table.configure({ resizable: false }),
  TableRow,
  TableHeader,
  TableCell,
  Markdown.configure({
    html: false,
    linkify: true,
    transformPastedText: true,
    transformCopiedText: true,
  }),
];

export default function Editor({ initialContent, onChange, onFileUploaded, pageId, onReady }) {
  const fileInputRef = useRef(null);

  const uploadAndInsert = async (editor, files) => {
    for (const file of files) {
      try {
        const meta = await api.uploadFile(file, pageId);
        if (file.type.startsWith('image/')) {
          editor.chain().focus().setImage({ src: meta.url, alt: meta.name }).run();
        } else {
          editor
            .chain()
            .focus()
            .insertContent({
              type: 'paragraph',
              content: [
                {
                  type: 'text',
                  text: `📎 ${meta.name}`,
                  marks: [{ type: 'link', attrs: { href: meta.url } }],
                },
              ],
            })
            .run();
        }
        onFileUploaded?.(meta);
      } catch (err) {
        console.error('Error subiendo archivo', err);
      }
    }
  };

  const editor = useEditor({
    extensions: [
      ...baseExtensions,
      SlashCommands,
      Placeholder.configure({
        placeholder: "Escribe algo, pega Markdown de Claude, o usa '/' para comandos…",
      }),
    ],
    content: initialContent || '',
    editorProps: {
      handlePaste: (view, event) => {
        const files = Array.from(event.clipboardData?.files || []);
        if (files.length > 0) {
          event.preventDefault();
          uploadAndInsert(editorRef.current, files);
          return true;
        }
        return false;
      },
      handleDrop: (view, event, slice, moved) => {
        if (moved) return false;
        const files = Array.from(event.dataTransfer?.files || []);
        if (files.length > 0) {
          event.preventDefault();
          uploadAndInsert(editorRef.current, files);
          return true;
        }
        return false;
      },
    },
    onUpdate: ({ editor }) => {
      onChange?.({ json: editor.getJSON(), text: editor.getText() });
    },
  });

  const editorRef = useRef(null);
  editorRef.current = editor;

  useEffect(() => {
    onReady?.(editor);
  }, [editor, onReady]);

  useEffect(() => {
    const handler = () => fileInputRef.current?.click();
    document.addEventListener('nonotion:insert-image', handler);
    return () => document.removeEventListener('nonotion:insert-image', handler);
  }, []);

  return (
    <>
      <EditorContent editor={editor} className="editor" />
      <input
        ref={fileInputRef}
        type="file"
        accept="image/*"
        multiple
        hidden
        onChange={(e) => {
          const files = Array.from(e.target.files || []);
          if (files.length && editorRef.current) uploadAndInsert(editorRef.current, files);
          e.target.value = '';
        }}
      />
    </>
  );
}
