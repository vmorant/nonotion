import { useEffect, useRef, useState } from 'react';
import { foldKey, foldsHiding, topHeadings } from './headingFold.js';

// Índice lateral de la página: encabezados H1-H3 para saltar a cada sección,
// con la sección visible resaltada y botones para plegar/desplegar todo.

const PREF_KEY = 'nn:outline';
const MIN_HEADINGS = 3;

function readPref() {
  try {
    return localStorage.getItem(PREF_KEY) !== 'off';
  } catch {
    return true;
  }
}

export default function PageOutline({ editor }) {
  const [items, setItems] = useState([]);
  const [active, setActive] = useState(null);
  const [open, setOpen] = useState(readPref);
  const sig = useRef('');

  useEffect(() => {
    if (!editor) return;
    const compute = () => {
      const folded = foldKey.getState(editor.state)?.folded || new Set();
      const next = topHeadings(editor.state.doc)
        .filter((h) => h.level <= 3 && h.text.trim())
        .map((h) => ({ ...h, folded: folded.has(h.pos) }));
      const s = JSON.stringify(next);
      if (s !== sig.current) {
        sig.current = s;
        setItems(next);
      }
    };
    compute();
    editor.on('transaction', compute);
    return () => editor.off('transaction', compute);
  }, [editor]);

  // Sección visible: el último encabezado que ya ha pasado por arriba
  useEffect(() => {
    if (!editor || !items.length) return;
    const scroller = document.querySelector('.main');
    if (!scroller) return;
    let frame = 0;
    const onScroll = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const top = scroller.getBoundingClientRect().top + 90;
        let current = items[0]?.pos ?? null;
        for (const it of items) {
          const dom = editor.view.nodeDOM(it.pos);
          if (!(dom instanceof HTMLElement) || !dom.offsetParent) continue;
          if (dom.getBoundingClientRect().top <= top) current = it.pos;
          else break;
        }
        setActive(current);
      });
    };
    onScroll();
    scroller.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      cancelAnimationFrame(frame);
      scroller.removeEventListener('scroll', onScroll);
    };
  }, [editor, items]);

  if (!editor || items.length < MIN_HEADINGS) return null;

  const setPref = (v) => {
    setOpen(v);
    try {
      localStorage.setItem(PREF_KEY, v ? 'on' : 'off');
    } catch {}
  };

  const jump = (pos) => {
    const folded = foldKey.getState(editor.state)?.folded || new Set();
    const hiding = foldsHiding(editor.state.doc, folded, pos);
    if (hiding.length) editor.view.dispatch(editor.state.tr.setMeta(foldKey, { remove: hiding }));
    requestAnimationFrame(() => {
      const dom = editor.view.nodeDOM(pos);
      if (dom instanceof HTMLElement) dom.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
  };

  const foldAll = (fold) => {
    const all = fold ? topHeadings(editor.state.doc).map((h) => h.pos) : [];
    editor.view.dispatch(editor.state.tr.setMeta(foldKey, { set: all }));
  };

  if (!open) {
    return (
      <aside className="page-outline collapsed">
        <button className="outline-show" onClick={() => setPref(true)} title="Mostrar índice de la página">
          ☰ Índice
        </button>
      </aside>
    );
  }

  const minLevel = Math.min(...items.map((i) => i.level));
  return (
    <aside className="page-outline">
      <div className="outline-head">
        <span>Índice</span>
        <span className="outline-actions">
          <button onClick={() => foldAll(true)} title="Plegar todas las secciones">
            ▸
          </button>
          <button onClick={() => foldAll(false)} title="Desplegar todas las secciones">
            ▾
          </button>
          <button onClick={() => setPref(false)} title="Ocultar índice">
            ✕
          </button>
        </span>
      </div>
      <nav className="outline-list">
        {items.map((it) => (
          <button
            key={it.pos}
            className={'outline-item' + (it.pos === active ? ' active' : '') + (it.folded ? ' folded' : '')}
            style={{ paddingLeft: 8 + (it.level - minLevel) * 12 }}
            onClick={() => jump(it.pos)}
            title={it.text}
          >
            {it.text}
            {it.folded ? ' ▸' : ''}
          </button>
        ))}
      </nav>
    </aside>
  );
}
