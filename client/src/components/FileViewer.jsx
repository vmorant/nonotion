import { useEffect, useMemo, useState } from 'react';
import { api } from '../api.js';

const SHEET_EXTS = ['.xlsx', '.xlsm', '.xls', '.ods', '.csv', '.tsv'];
const OFFICE_EXTS = ['.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx', '.odt', '.ods', '.odp', '.rtf'];
const TEXT_LIMIT = 500 * 1024;

const ext = (name = '') => name.slice(name.lastIndexOf('.')).toLowerCase();

// Qué visor usar para un archivo, o null si no hay vista previa
export function previewKind(file) {
  const mime = file.mime || '';
  if (mime === 'application/pdf') return 'pdf';
  if (mime.startsWith('image/')) return 'image';
  if (mime.startsWith('video/')) return 'video';
  if (mime.startsWith('audio/')) return 'audio';
  if (SHEET_EXTS.includes(ext(file.name))) return 'sheet';
  if (OFFICE_EXTS.includes(ext(file.name))) return 'office';
  if (mime.startsWith('text/') || /json|javascript|xml|yaml|x-sh/.test(mime)) return 'text';
  return null;
}

function OfficeFrame({ file }) {
  const [state, setState] = useState({ status: 'loading' });

  useEffect(() => {
    let url = null;
    let cancelled = false;
    setState({ status: 'loading' });
    fetch(`/files/${file.id}/preview`)
      .then(async (res) => {
        if (!res.ok) {
          const err = await res.json().catch(() => ({}));
          throw new Error(err.error || `Error ${res.status}`);
        }
        return res.blob();
      })
      .then((blob) => {
        if (cancelled) return;
        url = URL.createObjectURL(blob);
        setState({ status: 'ready', url });
      })
      .catch((e) => !cancelled && setState({ status: 'error', message: e.message }));
    return () => {
      cancelled = true;
      if (url) URL.revokeObjectURL(url);
    };
  }, [file.id]);

  if (state.status === 'loading')
    return <div className="viewer-status">Convirtiendo documento… (la primera vez tarda unos segundos)</div>;
  if (state.status === 'error') return <div className="viewer-status error">⚠ {state.message}</div>;
  return <iframe className="viewer-frame" src={state.url} title={file.name} />;
}

function TextView({ url }) {
  const [text, setText] = useState(null);
  useEffect(() => {
    fetch(url)
      .then((r) => r.text())
      .then((t) => setText(t.length > TEXT_LIMIT ? t.slice(0, TEXT_LIMIT) + '\n\n… (truncado)' : t))
      .catch(() => setText('No se pudo cargar el archivo.'));
  }, [url]);
  if (text === null) return <div className="viewer-status">Cargando…</div>;
  return <pre className="viewer-text">{text}</pre>;
}


// ---------- Visor de hojas de cálculo ----------

const ROWS_STEP = 500; // filas que se pintan de golpe (el resto con "Mostrar más")

function colName(i) {
  let s = '';
  for (let n = i + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return s;
}

function SheetTable({ sheet, query }) {
  const [limit, setLimit] = useState(ROWS_STEP);
  useEffect(() => setLimit(ROWS_STEP), [sheet, query]);

  const cols = useMemo(() => Math.max(0, ...sheet.rows.map((r) => r.length)), [sheet]);
  // Celdas combinadas: la de arriba a la izquierda se expande; el resto no se pinta
  const { spans, covered } = useMemo(() => {
    const spans = new Map();
    const covered = new Set();
    for (const m of sheet.merges || []) {
      spans.set(`${m.r}:${m.c}`, m);
      for (let r = m.r; r < m.r + m.rs; r++)
        for (let c = m.c; c < m.c + m.cs; c++) if (r !== m.r || c !== m.c) covered.add(`${r}:${c}`);
    }
    return { spans, covered };
  }, [sheet]);

  const q = query.trim().toLowerCase();
  const rowIdx = useMemo(() => {
    const all = sheet.rows.map((_, i) => i);
    if (!q) return all;
    return all.filter((i) => sheet.rows[i].some((v) => String(v).toLowerCase().includes(q)));
  }, [sheet, q]);

  if (!sheet.rows.length) return <div className="viewer-status">Hoja vacía</div>;
  const shown = rowIdx.slice(0, limit);
  const filtering = !!q; // al filtrar se ignoran las combinaciones verticales

  return (
    <div className="sheet-scroll">
      <table className="sheet-table">
        <colgroup>
          <col style={{ width: 44 }} />
          {Array.from({ length: cols }, (_, c) => (
            <col key={c} style={{ width: sheet.widths?.[c] === 0 ? 0 : sheet.widths?.[c] || 110 }} />
          ))}
        </colgroup>
        <thead>
          <tr>
            <th className="sheet-corner" />
            {Array.from({ length: cols }, (_, c) => (
              <th key={c}>{colName(c)}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {shown.map((r) => (
            <tr key={r}>
              <th className="sheet-rownum">{r + 1}</th>
              {Array.from({ length: cols }, (_, c) => {
                const key = `${r}:${c}`;
                if (covered.has(key) && !filtering) return null;
                const span = filtering ? null : spans.get(key);
                const v = sheet.rows[r][c] ?? '';
                const hit = q && String(v).toLowerCase().includes(q);
                return (
                  <td
                    key={c}
                    rowSpan={span?.rs > 1 ? span.rs : undefined}
                    colSpan={span?.cs > 1 ? span.cs : undefined}
                    className={(hit ? 'hit ' : '') + (/^-?[\d.,]+\s?[%€$]?$/.test(v) ? 'num' : '')}
                    title={String(v).length > 40 ? String(v) : undefined}
                  >
                    {v}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
      {rowIdx.length > limit && (
        <button className="btn sheet-more" onClick={() => setLimit((l) => l + ROWS_STEP * 2)}>
          Mostrar más filas ({rowIdx.length - limit} restantes)
        </button>
      )}
    </div>
  );
}

function SheetView({ file, onFallback }) {
  const [state, setState] = useState({ status: 'loading' });
  const [active, setActive] = useState(0);
  const [query, setQuery] = useState('');

  useEffect(() => {
    let cancelled = false;
    setState({ status: 'loading' });
    api
      .sheets(file.id)
      .then((data) => {
        if (cancelled) return;
        setState({ status: 'ready', sheets: data.sheets });
        const firstVisible = data.sheets.findIndex((s) => !s.hidden);
        setActive(firstVisible >= 0 ? firstVisible : 0);
      })
      .catch((e) => !cancelled && setState({ status: 'error', message: e.message }));
    return () => {
      cancelled = true;
    };
  }, [file.id]);

  if (state.status === 'loading') return <div className="viewer-status">Leyendo hoja de cálculo…</div>;
  if (state.status === 'error')
    return (
      <div className="viewer-status error">
        ⚠ {state.message}
        {onFallback && (
          <div>
            <button className="btn" onClick={onFallback}>
              Ver como PDF
            </button>
          </div>
        )}
      </div>
    );

  const sheet = state.sheets[active];
  const matches = query.trim()
    ? sheet.rows.filter((r) => r.some((v) => String(v).toLowerCase().includes(query.trim().toLowerCase()))).length
    : null;
  return (
    <div className="sheet-view">
      <div className="sheet-toolbar">
        <input
          className="sheet-search"
          placeholder="Buscar en esta hoja…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <span className="sheet-info">
          {matches !== null ? `${matches} filas coinciden · ` : ''}
          {sheet.totalRows} filas × {sheet.totalCols} columnas
          {sheet.truncatedRows || sheet.truncatedCols ? ` (se muestran ${sheet.rows.length} filas; descarga el archivo para ver el resto)` : ''}
        </span>
        {onFallback && (
          <button className="btn" onClick={onFallback} title="Ver con el formato de impresión (convertido a PDF)">
            Ver como PDF
          </button>
        )}
      </div>
      <SheetTable sheet={sheet} query={query} />
      {state.sheets.length > 1 && (
        <div className="sheet-tabs">
          {state.sheets.map((s, i) => (
            <button
              key={i}
              className={'sheet-tab' + (i === active ? ' active' : '') + (s.hidden ? ' hidden-sheet' : '')}
              onClick={() => setActive(i)}
              title={s.hidden ? 'Hoja oculta en el Excel' : undefined}
            >
              {s.name}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export default function FileViewer({ file, onClose }) {
  const url = file.url || `/files/${file.id}/${encodeURIComponent(file.name)}`;
  const [asPdf, setAsPdf] = useState(false);
  const detected = previewKind(file);
  const kind = detected === 'sheet' && asPdf ? 'office' : detected;
  const canPdf = OFFICE_EXTS.includes(ext(file.name));

  useEffect(() => {
    const onKey = (e) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className={'viewer-modal' + (kind === 'sheet' ? ' wide' : '')} onClick={(e) => e.stopPropagation()}>
        <div className="viewer-bar">
          <span className="viewer-title">{file.name}</span>
          <div className="viewer-actions">
            <a className="btn" href={url} target="_blank" rel="noreferrer">
              Abrir en pestaña
            </a>
            <a className="btn" href={url} download={file.name}>
              ⬇ Descargar
            </a>
            <button className="btn" onClick={onClose}>
              Cerrar
            </button>
          </div>
        </div>
        <div className="viewer-body">
          {kind === 'pdf' && <iframe className="viewer-frame" src={url} title={file.name} />}
          {kind === 'office' && <OfficeFrame file={file} />}
          {kind === 'sheet' && <SheetView file={file} onFallback={canPdf ? () => setAsPdf(true) : null} />}
          {kind === 'image' && <img className="viewer-image" src={url} alt={file.name} />}
          {kind === 'video' && <video className="viewer-media" src={url} controls autoPlay />}
          {kind === 'audio' && (
            <div className="viewer-status">
              <audio src={url} controls autoPlay style={{ width: '100%' }} />
            </div>
          )}
          {kind === 'text' && <TextView url={url} />}
          {kind === null && (
            <div className="viewer-status">Sin vista previa para este tipo de archivo. Usa "Descargar".</div>
          )}
        </div>
      </div>
    </div>
  );
}
