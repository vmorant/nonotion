import { useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';

// Etiqueta con su color. Con `to`, es un enlace a la vista de filtro.
export function TagChip({ name, color = 'gray', onRemove, to, active, onClick, count }) {
  const cls = `tag-chip tag-${color}${active ? ' active' : ''}${onClick ? ' clickable' : ''}`;
  const body = (
    <>
      <span className="tag-hash">#</span>
      {name}
      {count !== undefined && <span className="tag-count">{count}</span>}
    </>
  );
  return (
    <span className={cls} onClick={onClick} title={to ? `Ver todo lo etiquetado #${name}` : undefined}>
      {to ? <Link to={to}>{body}</Link> : body}
      {onRemove && (
        <button
          className="tag-remove"
          title={`Quitar #${name}`}
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            onRemove();
          }}
        >
          ×
        </button>
      )}
    </span>
  );
}

export const tagUrl = (tags) => `/tags?t=${tags.map(encodeURIComponent).join(',')}`;

// Etiquetas de una página: chips + campo con autocompletado de las existentes
export function TagEditor({ tags, allTags, onChange }) {
  const [adding, setAdding] = useState(false);
  const [value, setValue] = useState('');
  const [sel, setSel] = useState(0);
  const inputRef = useRef(null);
  const colorOf = useMemo(() => new Map(allTags.map((t) => [t.name.toLowerCase(), t.color])), [allTags]);

  const q = value.replace(/^#/, '').trim().toLowerCase();
  const suggestions = allTags
    .filter((t) => !tags.some((x) => x.toLowerCase() === t.name.toLowerCase()))
    .filter((t) => !q || t.name.toLowerCase().includes(q))
    .sort((a, b) => b.count - a.count)
    .slice(0, 8);
  const exact = allTags.some((t) => t.name.toLowerCase() === q) || tags.some((t) => t.toLowerCase() === q);
  // Opciones: coincidencias existentes y, al final, crear la nueva
  const options = [...suggestions.map((t) => t.name), ...(q && !exact ? [null] : [])];

  const add = (name) => {
    const n = name.replace(/^#+/, '').trim();
    if (!n) return;
    if (!tags.some((t) => t.toLowerCase() === n.toLowerCase())) onChange([...tags, n]);
    setValue('');
    setSel(0);
  };

  const onKey = (e) => {
    if (e.key === 'Enter' || e.key === ',' || e.key === 'Tab') {
      if (!value.trim() && e.key === 'Tab') return;
      e.preventDefault();
      if (!q) return;
      const opt = options[Math.min(sel, options.length - 1)];
      add(opt === null || opt === undefined ? value : opt);
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      setSel((s) => Math.min(s + 1, options.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setSel((s) => Math.max(s - 1, 0));
    } else if (e.key === 'Escape') {
      setAdding(false);
      setValue('');
    } else if (e.key === 'Backspace' && !value && tags.length) {
      onChange(tags.slice(0, -1));
    }
  };

  return (
    <div className="tag-editor">
      {tags.map((t) => (
        <TagChip
          key={t}
          name={t}
          color={colorOf.get(t.toLowerCase())}
          to={tagUrl([t])}
          onRemove={() => onChange(tags.filter((x) => x !== t))}
        />
      ))}
      {adding ? (
        <span className="tag-input-wrap">
          <input
            ref={inputRef}
            autoFocus
            className="tag-input"
            value={value}
            placeholder="etiqueta…"
            onChange={(e) => {
              setValue(e.target.value);
              setSel(0);
            }}
            onKeyDown={onKey}
            onBlur={() =>
              setTimeout(() => {
                if (value.trim()) add(value);
                setAdding(false);
              }, 150)
            }
          />
          {options.length > 0 && (
            <div className="tag-suggest">
              {suggestions.map((t, i) => (
                <button
                  key={t.name}
                  className={i === sel ? 'selected' : ''}
                  onMouseDown={(e) => {
                    e.preventDefault();
                    add(t.name);
                    inputRef.current?.focus();
                  }}
                >
                  <TagChip name={t.name} color={t.color} count={t.count} />
                </button>
              ))}
              {q && !exact && (
                <button
                  className={'tag-suggest-new' + (sel === options.length - 1 ? ' selected' : '')}
                  onMouseDown={(e) => {
                    e.preventDefault();
                    add(value);
                    inputRef.current?.focus();
                  }}
                >
                  Crear #{value.replace(/^#/, '').trim()}
                </button>
              )}
            </div>
          )}
        </span>
      ) : (
        <button className="tag-add" onClick={() => setAdding(true)} title="Añadir etiqueta">
          {tags.length ? '+' : '+ Etiqueta'}
        </button>
      )}
    </div>
  );
}
