import Image from '@tiptap/extension-image';
import { withImageAttrs } from '../imageAttrs.js';
import { api } from '../api.js';
import { fileFromHref, viewFile } from '../fileLinks.js';

// Imagen con tamaño y alineación editables:
//  - tiradores laterales para redimensionar arrastrando (ancho en % de la página);
//  - barra al seleccionarla: 25/50/75/100 %, alinear, ver en grande, descargar, borrar;
//  - doble clic: visor a tamaño completo;
//  - al pegar o soltar, la imagen se ve al momento y la subida avanza encima.

// ---------- Subidas en curso (vista previa local + progreso) ----------

const uploads = new Map(); // uploadId → { preview, pct, error }
const listeners = new Map(); // uploadId → Set<fn>

function setUpload(id, patch) {
  uploads.set(id, { ...(uploads.get(id) || {}), ...patch });
  for (const fn of listeners.get(id) || []) fn(uploads.get(id));
}

function watchUpload(id, fn) {
  if (!listeners.has(id)) listeners.set(id, new Set());
  listeners.get(id).add(fn);
  return () => listeners.get(id)?.delete(fn);
}

function findUploadNode(doc, uploadId) {
  let found = null;
  doc.descendants((node, pos) => {
    if (found !== null) return false;
    if (node.type.name === 'image' && node.attrs.uploadId === uploadId) found = { node, pos };
    return true;
  });
  return found;
}

// Inserta las imágenes en pos (o en el cursor) y las sube en paralelo
export function insertImages(editor, files, pageId, pos, onUploaded) {
  const nodes = files.map((file) => {
    const uploadId = Math.random().toString(36).slice(2, 12);
    setUpload(uploadId, { preview: URL.createObjectURL(file), pct: 0, error: null });
    return { file, uploadId };
  });
  const content = nodes.map(({ file, uploadId }) => ({ type: 'image', attrs: { src: null, alt: file.name, uploadId } }));
  const chain = editor.chain().focus();
  if (typeof pos === 'number') chain.insertContentAt(pos, content);
  else chain.insertContent(content);
  chain.run();

  for (const { file, uploadId } of nodes) {
    api
      .uploadFile(file, pageId, (frac) => setUpload(uploadId, { pct: Math.round(frac * 100) }))
      .then((meta) => {
        onUploaded?.(meta);
        const hit = !editor.isDestroyed && findUploadNode(editor.state.doc, uploadId);
        if (hit) {
          editor.view.dispatch(
            editor.state.tr.setNodeMarkup(hit.pos, undefined, { ...hit.node.attrs, src: meta.url, alt: meta.name, uploadId: null })
          );
        }
        setTimeout(() => {
          URL.revokeObjectURL(uploads.get(uploadId)?.preview);
          uploads.delete(uploadId);
          listeners.delete(uploadId);
        }, 2000);
      })
      .catch((err) => setUpload(uploadId, { error: err.message || 'Error al subir' }));
  }
}

// ---------- Vista del nodo ----------

const SIZES = ['25%', '50%', '75%', '100%'];
const ALIGNS = [
  ['left', '⇤', 'Alinear a la izquierda'],
  ['center', '↔', 'Centrar'],
  ['right', '⇥', 'Alinear a la derecha'],
];

class ImageNodeView {
  constructor({ node, editor, getPos }) {
    this.node = node;
    this.editor = editor;
    this.getPos = getPos;
    this.editable = editor.isEditable;

    this.dom = document.createElement('div');
    this.dom.className = 'nn-image';
    this.frame = this.dom.appendChild(document.createElement('div'));
    this.frame.className = 'nn-image-frame';
    this.img = this.frame.appendChild(document.createElement('img'));
    this.img.draggable = false;
    this.status = this.frame.appendChild(document.createElement('div'));
    this.status.className = 'nn-image-status';

    this.img.addEventListener('dblclick', (e) => {
      e.preventDefault();
      this.openViewer();
    });

    if (this.editable) {
      for (const side of ['left', 'right']) {
        const h = this.frame.appendChild(document.createElement('span'));
        h.className = `nn-image-handle ${side}`;
        h.title = 'Arrastra para cambiar el tamaño';
        h.addEventListener('pointerdown', (e) => this.startResize(e, side));
      }
      this.toolbar = this.dom.appendChild(document.createElement('div'));
      this.toolbar.className = 'nn-image-toolbar';
      this.toolbar.contentEditable = 'false';
      this.buildToolbar();
    } else {
      this.img.addEventListener('click', () => this.openViewer());
      this.img.style.cursor = 'zoom-in';
    }
    this.render();
  }

  button(label, title, fn, cls = '') {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = label;
    b.title = title;
    if (cls) b.className = cls;
    b.addEventListener('mousedown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      fn();
    });
    this.toolbar.appendChild(b);
    return b;
  }

  buildToolbar() {
    this.sizeButtons = SIZES.map((s) => this.button(s, `Ancho ${s} de la página`, () => this.update_({ width: s === '100%' ? '100%' : s })));
    this.button('Original', 'Tamaño original', () => this.update_({ width: null }));
    this.toolbar.appendChild(document.createElement('span')).className = 'sep';
    this.alignButtons = ALIGNS.map(([a, label, title]) => this.button(label, title, () => this.update_({ align: a })));
    this.toolbar.appendChild(document.createElement('span')).className = 'sep';
    this.button('🔍', 'Ver en grande (o doble clic)', () => this.openViewer());
    this.button('⬇', 'Descargar', () => {
      if (!this.node.attrs.src) return;
      const a = document.createElement('a');
      a.href = this.node.attrs.src;
      a.download = this.node.attrs.alt || '';
      a.click();
    });
    this.button('🗑', 'Quitar imagen de la página (el archivo sigue en adjuntos)', () => {
      const pos = this.getPos();
      if (typeof pos === 'number') this.editor.chain().focus().deleteRange({ from: pos, to: pos + this.node.nodeSize }).run();
    }, 'danger');
  }

  update_(attrs) {
    const pos = this.getPos();
    if (typeof pos !== 'number') return;
    this.editor.view.dispatch(this.editor.state.tr.setNodeMarkup(pos, undefined, { ...this.node.attrs, ...attrs }));
  }

  openViewer() {
    const src = this.node.attrs.src;
    if (!src) return;
    const file = fileFromHref(src) || { id: null, name: this.node.attrs.alt || 'imagen', mime: 'image/*', url: src };
    viewFile({ ...file, mime: file.mime.startsWith('image/') ? file.mime : 'image/png', url: file.id ? undefined : src });
  }

  startResize(e, side) {
    e.preventDefault();
    e.stopPropagation();
    const container = this.dom.parentElement || this.dom;
    const total = container.getBoundingClientRect().width;
    const startW = this.frame.getBoundingClientRect().width;
    const startX = e.clientX;
    // centrada: cada lado crece a la vez, el movimiento cuenta doble
    const factor = (this.node.attrs.align || 'center') === 'center' ? 2 : 1;
    let pct = null;
    const move = (ev) => {
      const dx = (ev.clientX - startX) * (side === 'right' ? 1 : -1) * factor;
      pct = Math.max(10, Math.min(100, Math.round(((startW + dx) / total) * 100)));
      this.frame.style.width = `${pct}%`;
      this.dom.classList.add('resizing');
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      this.dom.classList.remove('resizing');
      if (pct !== null) this.update_({ width: `${pct}%` });
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  }

  render() {
    const { src, alt, width, align, uploadId } = this.node.attrs;
    this.dom.dataset.align = align || 'center';
    this.frame.style.width = width || '';
    this.img.alt = alt || '';

    this.unwatch?.();
    this.unwatch = null;
    if (!src && uploadId) {
      const show = (u) => {
        if (!u) {
          this.img.removeAttribute('src');
          this.status.textContent = '⚠ Subida interrumpida';
          this.status.className = 'nn-image-status error';
          return;
        }
        if (u.preview && this.img.getAttribute('src') !== u.preview) this.img.src = u.preview;
        this.status.textContent = u.error ? `⚠ ${u.error}` : `Subiendo… ${u.pct || 0}%`;
        this.status.className = 'nn-image-status' + (u.error ? ' error' : ' busy');
        this.status.style.setProperty('--pct', `${u.pct || 0}%`);
      };
      show(uploads.get(uploadId));
      this.unwatch = watchUpload(uploadId, show);
    } else {
      if (src && this.img.getAttribute('src') !== src) this.img.src = src;
      this.status.textContent = '';
      this.status.className = 'nn-image-status';
    }

    if (this.sizeButtons) {
      this.sizeButtons.forEach((b, i) => b.classList.toggle('active', width === SIZES[i]));
      this.alignButtons.forEach((b, i) => b.classList.toggle('active', (align || 'center') === ALIGNS[i][0]));
    }
  }

  update(node) {
    if (node.type !== this.node.type) return false;
    this.node = node;
    this.render();
    return true;
  }

  selectNode() {
    this.dom.classList.add('selected');
  }

  deselectNode() {
    this.dom.classList.remove('selected');
  }

  // La barra y los tiradores son de la vista: ProseMirror no debe procesarlos
  stopEvent(event) {
    return !!(event.target.closest?.('.nn-image-toolbar') || event.target.closest?.('.nn-image-handle'));
  }

  ignoreMutation() {
    return true;
  }

  destroy() {
    this.unwatch?.();
  }
}

export const ResizableImage = withImageAttrs(Image).extend({
  draggable: true,
  addNodeView() {
    return (props) => new ImageNodeView(props);
  },
});
