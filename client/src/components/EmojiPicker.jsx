import { useEffect, useMemo, useRef, useState } from 'react';

// Selector de emojis completo: ~1.900 emojis (Twemoji, en color) con nombres y
// palabras clave en español, categorías, recientes y tonos de piel. Los datos
// (src/emoji-data.json, generado con `npm run emoji-data`) se cargan al abrirlo
// por primera vez, así que no pesan en la carga inicial de la app.

const RECENT_KEY = 'nn-emoji-recent';
const SKIN_KEY = 'nn-emoji-skin';
const MAX_RECENT = 30;
const SKINS = ['👋', '👋🏻', '👋🏼', '👋🏽', '👋🏾', '👋🏿'];
const GROUP_ICONS = { 0: '😀', 1: '👋', 3: '🌿', 4: '🍕', 5: '✈️', 6: '⚽', 7: '💡', 8: '❤️', 9: '🏳️' };

let dataPromise = null;
const loadData = () => (dataPromise ||= import('../emoji-data.json').then((m) => m.default || m));

const store = {
  get(key, fallback) {
    try {
      const v = localStorage.getItem(key);
      return v == null ? fallback : JSON.parse(v);
    } catch {
      return fallback;
    }
  },
  set(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch {
      /* sin almacenamiento: los recientes no se recuerdan */
    }
  },
};

const fold = (s) =>
  (s || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase();

export default function EmojiPicker({ onPick, onClose, allowClear = true, className = '' }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(false);
  const [q, setQ] = useState('');
  const [skin, setSkin] = useState(() => store.get(SKIN_KEY, 0));
  const [recent, setRecent] = useState(() => store.get(RECENT_KEY, []));
  const [hover, setHover] = useState(null);
  const [active, setActive] = useState(null);
  const root = useRef(null);
  const scroller = useRef(null);
  const search = useRef(null);

  useEffect(() => {
    let alive = true;
    loadData()
      .then((d) => alive && setData(d))
      .catch(() => alive && setError(true));
    search.current?.focus();
    return () => {
      alive = false;
    };
  }, []);

  // Cerrar con un clic fuera o con Escape
  useEffect(() => {
    // el botón que abre el selector (data-emoji-anchor) ya lo cierra con su propio clic
    const down = (e) => root.current && !root.current.contains(e.target) && !e.target.closest?.('[data-emoji-anchor]') && onClose?.();
    const key = (e) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose?.();
      }
    };
    document.addEventListener('mousedown', down);
    document.addEventListener('keydown', key, true);
    return () => {
      document.removeEventListener('mousedown', down);
      document.removeEventListener('keydown', key, true);
    };
  }, [onClose]);

  const index = useMemo(() => (data ? data.emojis.map((e) => ({ ...e, fn: fold(e.n), fk: fold(e.k) })) : []), [data]);

  const withSkin = (e) => (skin && e.s ? e.s[skin - 1] : e.e);

  const results = useMemo(() => {
    const words = fold(q).split(/\s+/).filter(Boolean);
    if (!words.length) return null;
    // primero lo que se llama así, luego lo que lo contiene en el nombre y al final las palabras clave
    const score = (e) => {
      let total = 0;
      for (const w of words) {
        if (e.fn === w) total += 0;
        else if (e.fn.startsWith(w)) total += 1;
        else if (` ${e.fn}`.includes(` ${w}`)) total += 2;
        else if (e.fn.includes(w)) total += 3;
        else if (` ${e.fk}`.includes(` ${w}`)) total += 4;
        else if (e.fk.includes(w)) total += 5;
        else return -1;
      }
      return total;
    };
    return index
      .map((e, i) => ({ e, i, s: score(e) }))
      .filter((x) => x.s >= 0)
      .sort((a, b) => a.s - b.s || a.i - b.i)
      .slice(0, 300)
      .map((x) => x.e);
  }, [q, index]);

  const sections = useMemo(() => {
    if (!data) return [];
    const by = new Map(data.groups.map((g) => [g.id, { ...g, items: [] }]));
    for (const e of index) by.get(e.g)?.items.push(e);
    return [...by.values()].filter((g) => g.items.length);
  }, [data, index]);

  const recentItems = useMemo(() => {
    const byChar = new Map(index.map((e) => [e.e, e]));
    return recent.map((ch) => byChar.get(ch) || { e: ch, n: '' });
  }, [recent, index]);

  const pick = (e) => {
    const ch = withSkin(e);
    const next = [e.e, ...recent.filter((x) => x !== e.e)].slice(0, MAX_RECENT);
    setRecent(next);
    store.set(RECENT_KEY, next);
    onPick(ch);
  };

  const jump = (id) => {
    setQ('');
    setActive(id);
    requestAnimationFrame(() => {
      const el = scroller.current?.querySelector(`[data-group="${id}"]`);
      if (el && scroller.current) scroller.current.scrollTop = el.offsetTop - scroller.current.offsetTop;
    });
  };

  const onScroll = () => {
    const s = scroller.current;
    if (!s || results) return;
    let current = null;
    for (const el of s.querySelectorAll('[data-group]')) {
      if (el.offsetTop - s.offsetTop <= s.scrollTop + 8) current = el.dataset.group;
    }
    setActive(current);
  };

  const grid = (items) => (
    <div className="emoji-grid">
      {items.map((e) => (
        <button
          type="button"
          key={e.e}
          className="emoji-cell"
          title={e.n}
          onClick={() => pick(e)}
          onMouseEnter={() => setHover(e)}
          onFocus={() => setHover(e)}
        >
          {withSkin(e)}
        </button>
      ))}
    </div>
  );

  return (
    <div className={`emoji-picker ${className}`} ref={root}>
      <div className="emoji-top">
        <input
          ref={search}
          className="emoji-search"
          placeholder="Buscar emoji…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && results?.length) {
              e.preventDefault();
              pick(results[0]);
            }
          }}
        />
        <div className="emoji-skins" title="Tono de piel">
          {SKINS.map((s, i) => (
            <button
              type="button"
              key={s}
              className={'emoji-skin' + (skin === i ? ' active' : '')}
              onClick={() => {
                setSkin(i);
                store.set(SKIN_KEY, i);
              }}
            >
              {s}
            </button>
          ))}
        </div>
      </div>

      {sections.length > 0 && (
        <div className="emoji-tabs">
          {recentItems.length > 0 && (
            <button type="button" className={'emoji-tab' + (active === 'recent' ? ' active' : '')} title="Recientes" onClick={() => jump('recent')}>
              🕘
            </button>
          )}
          {sections.map((g) => (
            <button
              type="button"
              key={g.id}
              className={'emoji-tab' + (String(active) === String(g.id) ? ' active' : '')}
              title={g.name}
              onClick={() => jump(g.id)}
            >
              {GROUP_ICONS[g.id] || g.items[0].e}
            </button>
          ))}
        </div>
      )}

      <div className="emoji-scroll" ref={scroller} onScroll={onScroll}>
        {error && <div className="emoji-empty">No se pudieron cargar los emojis.</div>}
        {!data && !error && <div className="emoji-empty">Cargando emojis…</div>}
        {results && (results.length ? grid(results) : <div className="emoji-empty">Ningún emoji coincide con «{q}».</div>)}
        {!results && data && (
          <>
            {recentItems.length > 0 && (
              <section data-group="recent">
                <h4>Recientes</h4>
                {grid(recentItems)}
              </section>
            )}
            {sections.map((g) => (
              <section key={g.id} data-group={g.id}>
                <h4>{g.name}</h4>
                {grid(g.items)}
              </section>
            ))}
          </>
        )}
      </div>

      <div className="emoji-foot">
        <span className="emoji-preview">
          {hover ? (
            <>
              <span className="emoji-preview-char">{withSkin(hover)}</span>
              <span className="emoji-preview-name">{hover.n}</span>
            </>
          ) : (
            <span className="emoji-preview-name">Twemoji · {data ? data.emojis.length : '…'} emojis</span>
          )}
        </span>
        {allowClear && (
          <button type="button" className="emoji-clear" onClick={() => onPick('')}>
            Quitar icono
          </button>
        )}
      </div>
    </div>
  );
}

// Botón con el emoji actual que abre el selector debajo (espacios, diálogos…)
export function EmojiButton({ value, onChange, disabled, title = 'Elegir emoji', className = '' }) {
  const [open, setOpen] = useState(false);
  return (
    <span className="emoji-button-wrap">
      <button
        type="button"
        data-emoji-anchor
        className={`emoji-button ${className}`}
        title={title}
        disabled={disabled}
        onClick={() => setOpen((v) => !v)}
      >
        {value || '🗂️'}
      </button>
      {open && (
        <EmojiPicker
          allowClear={false}
          className="emoji-picker-pop"
          onPick={(e) => {
            onChange(e);
            setOpen(false);
          }}
          onClose={() => setOpen(false)}
        />
      )}
    </span>
  );
}
