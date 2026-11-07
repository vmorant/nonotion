import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Lightbulb, Plus, Upload, Sparkles, Image as ImageIcon } from 'lucide-react';
import { api } from '../../api.js';
import { STATUSES, STATUS_LABELS, STATUS_HINTS, OUTCOME_ICONS, isUrl } from './model.js';

// Vista Ideas: tablero por estado, fuera del árbol de páginas. Aquí llegan las
// semillas (capturas, textos, listas de temas) y de aquí salen, ya
// desarrolladas, convertidas en páginas, diagramas, planning o documentos.

const ICON = { size: 15, strokeWidth: 1.9 };
const isImage = (f) => (f?.mime || f?.type || '').startsWith('image/');

function Capture({ onCreated }) {
  const [text, setText] = useState('');
  const [files, setFiles] = useState([]); // File[] pendientes de subir
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const input = useRef(null);

  const addFiles = (list) => {
    // copia inmediata: la FileList del <input> se vacía al resetearlo
    const arr = Array.from(list || []).map((f, i) =>
      f.name && f.name !== 'image.png' ? f : new File([f], `captura-${Date.now()}-${i + 1}.png`, { type: f.type })
    );
    if (arr.length) setFiles((prev) => [...prev, ...arr]);
  };

  const onPaste = (e) => {
    const items = Array.from(e.clipboardData?.items || []);
    const images = items.filter((it) => it.kind === 'file' && it.type.startsWith('image/')).map((it) => it.getAsFile());
    if (images.length) {
      e.preventDefault();
      addFiles(images);
    }
  };

  const save = async () => {
    const t = text.trim();
    if (!t && !files.length) return;
    setBusy(true);
    setError(null);
    try {
      const seeds = [];
      if (t) seeds.push(isUrl(t) ? { kind: 'link', url: t } : { kind: 'text', text });
      const created = await api.createIdea({
        title: t ? undefined : files[0]?.name?.replace(/\.[a-z0-9]+$/i, '') || 'Idea',
        content: { type: 'idea', seeds },
      });
      if (files.length) {
        const add = [];
        for (const f of files) {
          const meta = await api.uploadFile(f, created.id);
          add.push({ kind: isImage(meta) ? 'image' : 'file', file_id: meta.id, name: meta.name });
        }
        await api.patchIdea(created.id, { seeds_add: add });
      }
      setText('');
      setFiles([]);
      onCreated(created);
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      className="ideas-capture"
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes('Files')) e.preventDefault();
      }}
      onDrop={(e) => {
        e.preventDefault();
        addFiles(e.dataTransfer.files);
      }}
    >
      <textarea
        autoFocus
        className="idea-textarea"
        rows={4}
        placeholder="Pega la semilla: un texto, una lista de temas, un enlace o una captura (Ctrl+V). También puedes arrastrar archivos aquí."
        value={text}
        onChange={(e) => setText(e.target.value)}
        onPaste={onPaste}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) save();
        }}
      />
      {files.length > 0 && (
        <ul className="ideas-capture-files">
          {files.map((f, i) => (
            <li key={i}>
              {isImage(f) ? <ImageIcon {...ICON} /> : '📎'} {f.name}
              <button className="icon-btn" title="Quitar" onClick={() => setFiles(files.filter((_, j) => j !== i))}>
                ✕
              </button>
            </li>
          ))}
        </ul>
      )}
      {error && <div className="idea-error">⚠ {error}</div>}
      <div className="idea-add-actions">
        <button className="btn" onClick={() => input.current?.click()}>
          <Upload {...ICON} /> Captura / archivo
        </button>
        <button className="btn primary" onClick={save} disabled={busy || (!text.trim() && !files.length)}>
          <Plus {...ICON} /> {busy ? 'Guardando…' : 'Guardar idea'}
        </button>
        <span className="idea-hint">Ctrl+Enter</span>
      </div>
      <input
        ref={input}
        type="file"
        multiple
        hidden
        onChange={(e) => {
          addFiles(e.target.files);
          e.target.value = '';
        }}
      />
    </div>
  );
}

function IdeaCard({ idea, onOpen }) {
  return (
    <button className={`idea-card status-${idea.status}`} onClick={onOpen}>
      <div className="idea-card-title">
        <span className="idea-card-icon">{idea.icon || '💡'}</span>
        <span>{idea.title || 'Sin título'}</span>
      </div>
      {idea.preview && <div className="idea-card-preview">{idea.preview}</div>}
      <div className="idea-card-meta">
        {idea.has_image && <span title="Tiene capturas">🖼</span>}
        <span title="Semillas">🌱 {idea.seeds}</span>
        <span title="Pasos de desarrollo">🔧 {idea.steps}</span>
        {idea.outcomes.length > 0 && (
          <span className="idea-card-outcomes" title="Resultados">
            {idea.outcomes.map((o) => (
              <span key={o.id}>{OUTCOME_ICONS[o.type] || '📦'}</span>
            ))}
          </span>
        )}
        <span className="idea-card-date">{(idea.updated_at || '').slice(0, 10)}</span>
      </div>
      {idea.tags?.length > 0 && <div className="idea-card-tags">{idea.tags.map((t) => `#${t}`).join(' ')}</div>}
    </button>
  );
}

export default function IdeasView({ pages, onChanged }) {
  const [ideas, setIdeas] = useState(null);
  const [capture, setCapture] = useState(false);
  const [filter, setFilter] = useState('');
  const [showArchived, setShowArchived] = useState(false);
  const navigate = useNavigate();

  // Se recarga con cada cambio del árbol: el servidor avisa también de las ideas
  useEffect(() => {
    let cancelled = false;
    api
      .ideas()
      .then((r) => !cancelled && setIdeas(r))
      .catch(() => !cancelled && setIdeas([]));
    return () => {
      cancelled = true;
    };
  }, [pages]);

  const shown = useMemo(() => {
    const t = filter.trim().toLowerCase();
    const list = (ideas || []).filter(
      (i) => !t || (i.title || '').toLowerCase().includes(t) || (i.preview || '').toLowerCase().includes(t) || (i.tags || []).some((x) => x.includes(t))
    );
    const by = Object.fromEntries(STATUSES.map((s) => [s, []]));
    for (const i of list) (by[i.status] || by.seed).push(i);
    return by;
  }, [ideas, filter]);

  const total = ideas?.length || 0;

  return (
    <div className="ideas-view">
      <div className="ideas-head">
        <h2>
          <Lightbulb size={20} strokeWidth={1.9} /> Ideas
        </h2>
        <p className="ideas-intro">
          Desarrollo de ideas, fuera de las notas: aquí llega lo que todavía no sabe dónde vive (una captura, un texto, una lista de
          temas), se trabaja con Claude y acaba convertido en páginas, diagramas, planning o documentos.
        </p>
        <div className="ideas-actions">
          <input className="ideas-filter" placeholder="Filtrar ideas…" value={filter} onChange={(e) => setFilter(e.target.value)} />
          <button className={'btn primary' + (capture ? ' active' : '')} onClick={() => setCapture((v) => !v)}>
            <Plus {...ICON} /> Nueva idea
          </button>
        </div>
      </div>
      {capture && (
        <Capture
          onCreated={async (created) => {
            setCapture(false);
            await onChanged?.(); // el servidor no nos reenvía nuestros propios cambios por SSE
            navigate(`/p/${created.id}`);
          }}
        />
      )}

      {ideas && total === 0 && !capture && (
        <div className="ideas-empty">
          <Lightbulb size={40} strokeWidth={1.4} />
          <p>Todavía no hay ideas. Pega una captura o un texto con «Nueva idea», o pídele a Claude «guárdalo como idea».</p>
          <p className="idea-hint">
            <Sparkles size={13} /> Cada idea separa la <strong>semilla</strong> (lo que llegó), el <strong>desarrollo</strong> (el
            razonamiento) y el <strong>resultado</strong> (dónde se documentó).
          </p>
        </div>
      )}

      {total > 0 && (
        <div className="ideas-board">
          {STATUSES.filter((s) => s !== 'archived' || showArchived).map((s) => (
            <section key={s} className={`ideas-column status-${s}`}>
              <h3 title={STATUS_HINTS[s]}>
                {STATUS_LABELS[s]} <span className="idea-n">{shown[s].length}</span>
              </h3>
              {shown[s].map((i) => (
                <IdeaCard key={i.id} idea={i} onOpen={() => navigate(`/p/${i.id}`)} />
              ))}
              {!shown[s].length && <div className="ideas-column-empty">—</div>}
            </section>
          ))}
          {shown.archived.length > 0 && !showArchived && (
            <button className="ideas-archived-toggle" onClick={() => setShowArchived(true)}>
              Archivadas ({shown.archived.length})
            </button>
          )}
        </div>
      )}
    </div>
  );
}
