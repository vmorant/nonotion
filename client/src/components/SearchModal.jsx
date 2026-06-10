import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api.js';

export default function SearchModal({ onClose }) {
  const [q, setQ] = useState('');
  const [results, setResults] = useState([]);
  const [selected, setSelected] = useState(0);
  const inputRef = useRef(null);
  const timer = useRef(null);
  const navigate = useNavigate();

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    clearTimeout(timer.current);
    if (!q.trim()) {
      setResults([]);
      return;
    }
    timer.current = setTimeout(async () => {
      const rows = await api.search(q);
      setResults(rows);
      setSelected(0);
    }, 200);
    return () => clearTimeout(timer.current);
  }, [q]);

  const open = (id) => {
    onClose();
    navigate(`/p/${id}`);
  };

  const onKey = (e) => {
    if (e.key === 'Escape') onClose();
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setSelected((s) => Math.min(s + 1, results.length - 1));
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      setSelected((s) => Math.max(s - 1, 0));
    }
    if (e.key === 'Enter' && results[selected]) open(results[selected].id);
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="search-modal" onClick={(e) => e.stopPropagation()} onKeyDown={onKey}>
        <input
          ref={inputRef}
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Buscar en todas las páginas…"
        />
        <div className="search-results">
          {results.map((r, i) => (
            <button
              key={r.id}
              className={'search-result' + (i === selected ? ' selected' : '')}
              onClick={() => open(r.id)}
              onMouseEnter={() => setSelected(i)}
            >
              <span className="result-title">
                {r.icon || '📄'} {r.title || 'Sin título'}
              </span>
              {r.snippet && <span className="result-snippet" dangerouslySetInnerHTML={{ __html: r.snippet }} />}
            </button>
          ))}
          {q.trim() && results.length === 0 && <div className="search-empty">Sin resultados</div>}
        </div>
      </div>
    </div>
  );
}
