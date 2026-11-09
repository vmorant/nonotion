import { useEffect, useRef, useState } from 'react';
import { Check, X } from 'lucide-react';
import { isOverdue } from './model.js';
import { safeHref } from '../../fileLinks.js';

// Editores en línea de los campos de un ticket (tabla, tablero y ficha):
// desplegables con opciones de color, varias opciones, texto, número, fecha,
// persona, casilla y enlace. Cada cambio llama a onChange(valor) al confirmar.

export function Pill({ name, color = 'gray', className = '' }) {
  if (!name) return null;
  return <span className={`opt-pill tag-${color} ${className}`}>{name}</span>;
}

export function StatusPill({ status }) {
  if (!status) return null;
  return <Pill name={status.name} color={status.color} className={`status-pill cat-${status.category}`} />;
}

// Menú desplegable con opciones de color (estado, desplegable, varias opciones)
export function OptionMenu({ options, value, multi = false, onChange, placeholder = '—', disabled, renderValue, align = 'left' }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  useEffect(() => {
    if (!open) return undefined;
    const close = (e) => {
      if (ref.current && !ref.current.contains(e.target)) setOpen(false);
    };
    const esc = (e) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', esc);
    return () => {
      document.removeEventListener('mousedown', close);
      document.removeEventListener('keydown', esc);
    };
  }, [open]);
  const selected = multi ? (Array.isArray(value) ? value : []) : value;
  const isOn = (id) => (multi ? selected.includes(id) : selected === id);
  const shown = multi ? options.filter((o) => selected.includes(o.id)) : options.filter((o) => o.id === selected);
  return (
    <span className="opt-menu" ref={ref} onClick={(e) => e.stopPropagation()}>
      <button
        type="button"
        className="opt-menu-btn"
        disabled={disabled}
        onClick={() => setOpen((v) => !v)}
        title={disabled ? undefined : 'Cambiar'}
      >
        {renderValue ? renderValue(shown) : shown.length ? shown.map((o) => <Pill key={o.id} name={o.name} color={o.color} />) : <span className="opt-empty">{placeholder}</span>}
      </button>
      {open && (
        <div className={`opt-menu-list align-${align}`}>
          {options.map((o) => (
            <button
              type="button"
              key={o.id}
              className={'opt-menu-item' + (isOn(o.id) ? ' on' : '')}
              onClick={() => {
                if (multi) onChange(isOn(o.id) ? selected.filter((x) => x !== o.id) : [...selected, o.id]);
                else {
                  onChange(o.id);
                  setOpen(false);
                }
              }}
            >
              <Pill name={o.name} color={o.color} />
              {isOn(o.id) && <Check size={13} />}
            </button>
          ))}
          {!options.length && <div className="opt-empty pad">Sin opciones: añádelas en ⚙ Campos</div>}
          {((multi && selected.length) || (!multi && selected && !renderValue)) && (
            <button
              type="button"
              className="opt-menu-item clear"
              onClick={() => {
                onChange(multi ? [] : null);
                setOpen(false);
              }}
            >
              <X size={13} /> Vaciar
            </button>
          )}
        </div>
      )}
    </span>
  );
}

// Texto/número/persona/enlace: se edita en el sitio y se guarda al salir o con Enter
function InlineInput({ value, type = 'text', placeholder, list, onCommit, disabled, className = '' }) {
  const [v, setV] = useState(value ?? '');
  useEffect(() => setV(value ?? ''), [value]);
  const commit = () => {
    const next = type === 'number' ? (v === '' ? null : Number(v)) : v.trim() === '' ? null : v.trim();
    if (next !== (value ?? null)) onCommit(next);
  };
  return (
    <input
      className={'field-input ' + className}
      type={type}
      value={v}
      list={list}
      placeholder={placeholder}
      disabled={disabled}
      onClick={(e) => e.stopPropagation()}
      onChange={(e) => setV(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') e.currentTarget.blur();
        if (e.key === 'Escape') {
          setV(value ?? '');
          setTimeout(() => e.target.blur());
        }
      }}
    />
  );
}

export function FieldEditor({ field, value, category, onChange, peopleListId, readOnly }) {
  switch (field.type) {
    case 'select':
      return <OptionMenu options={field.options} value={value ?? null} onChange={onChange} disabled={readOnly} />;
    case 'multi':
      return <OptionMenu multi options={field.options} value={value ?? []} onChange={onChange} disabled={readOnly} />;
    case 'checkbox':
      return (
        <input
          type="checkbox"
          className="field-check"
          checked={Boolean(value)}
          disabled={readOnly}
          onClick={(e) => e.stopPropagation()}
          onChange={(e) => onChange(e.target.checked)}
        />
      );
    case 'date':
      return (
        <input
          type="date"
          className={'field-input field-date' + (isOverdue(field, value, category) ? ' overdue' : '')}
          value={value || ''}
          disabled={readOnly}
          onClick={(e) => e.stopPropagation()}
          onChange={(e) => onChange(e.target.value || null)}
        />
      );
    case 'number':
      return <InlineInput type="number" value={value} placeholder="—" onCommit={onChange} disabled={readOnly} className="field-number" />;
    case 'person':
      return <InlineInput value={value} placeholder="—" list={peopleListId} onCommit={onChange} disabled={readOnly} className="field-person" />;
    case 'url':
      // Solo http(s)/mailto: un valor antiguo (p. ej. de un campo que era de texto) nunca es un enlace javascript:
      return readOnly && value && safeHref(value) ? (
        <a href={safeHref(value)} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()}>
          {value.replace(/^https?:\/\//, '').slice(0, 40)}
        </a>
      ) : (
        <InlineInput value={value} placeholder="https://…" onCommit={onChange} disabled={readOnly} className="field-url" />
      );
    default:
      return <InlineInput value={value} placeholder="—" onCommit={onChange} disabled={readOnly} />;
  }
}
