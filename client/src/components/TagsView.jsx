import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { api, humanSize } from '../api.js';
import { TagChip, tagUrl } from './Tags.jsx';
import { viewFile } from '../fileLinks.js';

const COLORS = ['gray', 'red', 'orange', 'yellow', 'green', 'teal', 'blue', 'purple', 'pink'];
const UNTAGGED = '__sin__';

function pathOf(page, byId) {
  const parts = [];
  let cur = page.parent_id ? byId.get(page.parent_id) : null;
  while (cur) {
    parts.unshift(cur.title || 'Sin título');
    cur = cur.parent_id ? byId.get(cur.parent_id) : null;
  }
  return parts.join(' / ');
}

// Gestión de una etiqueta: color, renombrar, borrar
function TagMenu({ tag, onDone }) {
  const [name, setName] = useState(tag.name);
  const navigate = useNavigate();
  const run = async (fn) => {
    try {
      await fn();
    } finally {
      onDone();
    }
  };
  return (
    <div className="tag-menu" onClick={(e) => e.stopPropagation()}>
      <div className="tag-colors">
        {COLORS.map((c) => (
          <button
            key={c}
            className={`tag-color-dot tag-${c}` + (c === tag.color ? ' active' : '')}
            title={c}
            onClick={() => run(() => api.updateTag(tag.name, { color: c }))}
          />
        ))}
      </div>
      <form
        className="tag-rename"
        onSubmit={(e) => {
          e.preventDefault();
          if (name.trim() && name.trim() !== tag.name)
            run(async () => {
              const r = await api.updateTag(tag.name, { name: name.trim() });
              navigate(tagUrl([r.name]), { replace: true });
            });
        }}
      >
        <input value={name} onChange={(e) => setName(e.target.value)} title="Renombrar (si ya existe, se fusionan)" />
        <button className="btn">Renombrar</button>
      </form>
      <button
        className="btn danger"
        onClick={() => {
          if (confirm(`¿Borrar la etiqueta #${tag.name}? Se quitará de ${tag.count} página(s); las páginas no se tocan.`))
            run(async () => {
              await api.deleteTag(tag.name);
              navigate('/tags', { replace: true });
            });
        }}
      >
        Borrar etiqueta
      </button>
    </div>
  );
}

export default function TagsView({ pages, tags, onChanged }) {
  const [params, setParams] = useSearchParams();
  const selected = (params.get('t') || '').split(',').filter(Boolean);
  const mode = params.get('mode') === 'any' ? 'any' : 'all';
  const [filter, setFilter] = useState('');
  const [result, setResult] = useState({ pages: [], files: [] });
  const [menu, setMenu] = useState(null);
  const byId = useMemo(() => new Map(pages.map((p) => [p.id, p])), [pages]);
  const colorOf = useMemo(() => new Map(tags.map((t) => [t.name.toLowerCase(), t.color])), [tags]);
  const untagged = useMemo(
    () => pages.filter((p) => !p.tags?.length).sort((a, b) => (b.updated_at || '').localeCompare(a.updated_at || '')),
    [pages]
  );
  const showUntagged = selected.includes(UNTAGGED);
  const realSelected = selected.filter((t) => t !== UNTAGGED);
  const key = realSelected.join(',') + '|' + mode + '|' + pages.length;

  useEffect(() => {
    if (!realSelected.length) return setResult({ pages: [], files: [] });
    let cancelled = false;
    api.tagged(realSelected, mode).then((r) => !cancelled && setResult(r));
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  const setSel = (list, m = mode) => {
    const next = {};
    if (list.length) next.t = list.join(',');
    if (m === 'any') next.mode = 'any';
    setParams(next);
  };
  const toggle = (name) => {
    if (name === UNTAGGED) return setSel(showUntagged ? [] : [UNTAGGED]);
    const has = realSelected.some((t) => t.toLowerCase() === name.toLowerCase());
    setSel(has ? realSelected.filter((t) => t.toLowerCase() !== name.toLowerCase()) : [...realSelected, name]);
  };

  const visibleTags = tags.filter((t) => t.name.toLowerCase().includes(filter.trim().toLowerCase().replace(/^#/, '')));
  const resultPages = showUntagged ? untagged : result.pages;
  const resultFiles = showUntagged ? [] : result.files;

  return (
    <div className="tags-view">
      <aside className="tags-list">
        <h2>🏷 Etiquetas</h2>
        <input
          className="tags-filter"
          placeholder="Filtrar etiquetas…"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
        {tags.length === 0 && (
          <p className="tags-empty">
            Aún no hay etiquetas. Añádelas bajo el título de cualquier página con "+ Etiqueta", o pídeselo a Claude.
          </p>
        )}
        {visibleTags.map((t) => (
          <div key={t.name} className="tags-row">
            <TagChip
              name={t.name}
              color={t.color}
              count={t.count}
              active={realSelected.some((x) => x.toLowerCase() === t.name.toLowerCase())}
              onClick={() => toggle(t.name)}
            />
            <button className="icon-btn tags-row-menu" title="Color, renombrar, borrar" onClick={() => setMenu(menu === t.name ? null : t.name)}>
              ⋯
            </button>
            {menu === t.name && (
              <TagMenu
                tag={t}
                onDone={() => {
                  setMenu(null);
                  onChanged();
                }}
              />
            )}
          </div>
        ))}
        <div className="tags-row">
          <span className={'tag-chip tag-gray clickable untagged' + (showUntagged ? ' active' : '')} onClick={() => toggle(UNTAGGED)}>
            Sin etiquetar <span className="tag-count">{untagged.length}</span>
          </span>
        </div>
      </aside>

      <section className="tags-results">
        <div className="tags-results-head">
          {selected.length === 0 ? (
            <span className="tags-hint">Elige una o varias etiquetas para ver sus páginas y archivos.</span>
          ) : (
            <>
              {realSelected.map((t) => (
                <TagChip key={t} name={t} color={colorOf.get(t.toLowerCase())} onRemove={() => toggle(t)} />
              ))}
              {showUntagged && <span className="tag-chip tag-gray">Sin etiquetar</span>}
              {realSelected.length > 1 && (
                <span className="tags-mode">
                  <button className={mode === 'all' ? 'active' : ''} onClick={() => setSel(realSelected, 'all')} title="Páginas con TODAS las etiquetas">
                    Todas
                  </button>
                  <button className={mode === 'any' ? 'active' : ''} onClick={() => setSel(realSelected, 'any')} title="Páginas con ALGUNA de las etiquetas">
                    Alguna
                  </button>
                </span>
              )}
              <button className="btn" onClick={() => setSel([])}>
                Limpiar
              </button>
            </>
          )}
        </div>

        {selected.length > 0 && (
          <>
            <h3>
              Páginas <span className="tags-n">{resultPages.length}</span>
            </h3>
            {resultPages.length === 0 && <p className="tags-hint">Ninguna página coincide.</p>}
            <ul className="tags-pages">
              {resultPages.map((p) => (
                <li key={p.id}>
                  <Link to={`/p/${p.id}`} className="tags-page">
                    <span className="tags-page-icon">{p.icon || '📄'}</span>
                    <span className="tags-page-main">
                      <span className="tags-page-title">{p.title || 'Sin título'}</span>
                      <span className="tags-page-path">{pathOf(p, byId) || 'Raíz'}</span>
                    </span>
                    <span className="tags-page-tags">
                      {(p.tags || []).map((t) => (
                        <TagChip key={t} name={t} color={colorOf.get(t.toLowerCase())} />
                      ))}
                    </span>
                    <span className="tags-page-date">{(p.updated_at || '').slice(0, 10)}</span>
                  </Link>
                </li>
              ))}
            </ul>
            {resultFiles.length > 0 && (
              <>
                <h3>
                  Archivos de estas páginas <span className="tags-n">{resultFiles.length}</span>
                </h3>
                <ul className="tags-files">
                  {resultFiles.map((f) => (
                    <li key={f.id}>
                      <button className="tags-file" onClick={() => viewFile(f)}>
                        📎 {f.name}
                      </button>
                      <span className="tags-file-meta">
                        {humanSize(f.size)} · {byId.get(f.page_id)?.title || ''}
                      </span>
                    </li>
                  ))}
                </ul>
              </>
            )}
          </>
        )}
      </section>
    </div>
  );
}
