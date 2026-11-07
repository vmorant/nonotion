import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import MarkdownIt from 'markdown-it';
import { Sparkles, Plus, Trash2, Upload, Copy, Check, ExternalLink, FileText, LayoutDashboard, CalendarDays, Pencil, ListChecks } from 'lucide-react';
import NewIssueDialog from '../issues/NewIssueDialog.jsx';
import { api, markBusy, clearBusy } from '../../api.js';
import { viewFile, safeHref } from '../../fileLinks.js';
import {
  parseIdea,
  STATUSES,
  STATUS_LABELS,
  STATUS_HINTS,
  STEP_KINDS,
  STEP_LABELS,
  OUTCOME_TYPES,
  OUTCOME_LABELS,
  OUTCOME_ICONS,
  claudePrompt,
  fmtDate,
  isUrl,
} from './model.js';

// Vista de una idea: tres partes que no se mezclan.
//   Semilla   → lo que llegó (texto, captura, archivo, enlace, fragmento de página); no se reescribe
//   Desarrollo → pasos fechados (preguntas, hipótesis, decisiones…), de la persona o de Claude
//   Resultado → dónde se ha materializado (páginas, canvas, planning, archivos, documentos externos)

const md = new MarkdownIt({ html: false, linkify: true, breaks: true });
const Md = ({ text, className = '' }) => (
  <div className={'idea-md ' + className} dangerouslySetInnerHTML={{ __html: md.render(text || '') }} />
);

const ICON = { size: 14, strokeWidth: 1.9 };
const isImage = (f) => (f?.mime || '').startsWith('image/') && f.mime !== 'image/svg+xml';

function Seed({ seed, files, pages, readOnly, onRemove, onNote }) {
  const file = seed.file_id ? files.find((f) => f.id === seed.file_id) : null;
  const page = seed.page_id ? pages.find((p) => p.id === seed.page_id) : null;
  const [noteOpen, setNoteOpen] = useState(false);
  const [note, setNote] = useState(seed.note || '');
  const kindLabel = { text: 'Texto', image: 'Captura', file: 'Archivo', link: 'Enlace', page: 'Fragmento de página' }[seed.kind];
  return (
    <li className={`idea-seed kind-${seed.kind}`}>
      <div className="idea-item-head">
        <span className="idea-badge">{kindLabel}</span>
        <span className="idea-when">{fmtDate(seed.at)}</span>
        {!readOnly && (
          <span className="idea-item-actions">
            <button className="icon-btn" title="Anotar la semilla (no la cambia)" onClick={() => setNoteOpen((v) => !v)}>
              <Pencil {...ICON} />
            </button>
            <button className="icon-btn danger" title="Quitar semilla" onClick={onRemove}>
              <Trash2 {...ICON} />
            </button>
          </span>
        )}
      </div>
      {seed.kind === 'text' && <pre className="idea-seed-text">{seed.text}</pre>}
      {seed.kind === 'image' && (
        <>
          <img
            className="idea-seed-img"
            src={`/files/${seed.file_id}/${encodeURIComponent(seed.name || file?.name || 'captura')}`}
            alt={seed.name || 'captura'}
            onClick={() => file && viewFile(file)}
            title="Ver a tamaño completo"
          />
          {seed.ocr ? (
            <details className="idea-ocr">
              <summary>Texto reconocido (OCR)</summary>
              <pre className="idea-seed-text">{seed.ocr}</pre>
            </details>
          ) : (
            <div className="idea-hint">Sin texto reconocido (OCR no disponible en el servidor o imagen sin texto)</div>
          )}
        </>
      )}
      {seed.kind === 'file' && (
        <button className="idea-seed-file" onClick={() => file && viewFile(file)}>
          📎 {seed.name || file?.name || seed.file_id}
        </button>
      )}
      {seed.kind === 'link' && (
        <a className="idea-seed-link" href={safeHref(seed.url) || undefined} target="_blank" rel="noreferrer">
          <ExternalLink {...ICON} /> {seed.url}
        </a>
      )}
      {seed.kind === 'page' && (
        <>
          <Link className="idea-seed-page" to={`/p/${seed.page_id}`}>
            {page?.icon || '📄'} {page?.title || 'Página'}
          </Link>
          {seed.text && <blockquote className="idea-seed-quote">{seed.text}</blockquote>}
        </>
      )}
      {(noteOpen || seed.note) && (
        <div className="idea-seed-note">
          {noteOpen && !readOnly ? (
            <input
              autoFocus
              value={note}
              placeholder="Nota sobre esta semilla (de dónde viene, qué te llamó la atención…)"
              onChange={(e) => setNote(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  onNote(note);
                  setNoteOpen(false);
                }
                if (e.key === 'Escape') setNoteOpen(false);
              }}
              onBlur={() => {
                if (note !== (seed.note || '')) onNote(note);
                setNoteOpen(false);
              }}
            />
          ) : (
            <span>📝 {seed.note}</span>
          )}
        </div>
      )}
    </li>
  );
}

function Step({ step, readOnly, onEdit, onRemove }) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(step.text);
  const save = () => {
    setEditing(false);
    if (text.trim() && text !== step.text) onEdit({ text });
  };
  return (
    <li className={`idea-step kind-${step.kind} by-${step.by}`}>
      <div className="idea-item-head">
        <span className={`idea-badge step-${step.kind}`}>{STEP_LABELS[step.kind] || step.kind}</span>
        <span className={'idea-by ' + step.by}>{step.by === 'claude' ? '✦ Claude' : 'Tú'}</span>
        <span className="idea-when">{fmtDate(step.at)}</span>
        {!readOnly && (
          <span className="idea-item-actions">
            <select value={step.kind} title="Tipo de paso" onChange={(e) => onEdit({ kind: e.target.value })}>
              {STEP_KINDS.map((k) => (
                <option key={k} value={k}>
                  {STEP_LABELS[k]}
                </option>
              ))}
            </select>
            <button className="icon-btn" title="Editar" onClick={() => setEditing(true)}>
              <Pencil {...ICON} />
            </button>
            <button className="icon-btn danger" title="Quitar paso" onClick={onRemove}>
              <Trash2 {...ICON} />
            </button>
          </span>
        )}
      </div>
      {editing ? (
        <textarea
          autoFocus
          className="idea-textarea"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') setEditing(false);
            if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) save();
          }}
          onBlur={save}
        />
      ) : (
        <div onDoubleClick={() => !readOnly && setEditing(true)}>
          <Md text={step.text} />
        </div>
      )}
    </li>
  );
}

function Outcome({ outcome, pages, files, readOnly, onRemove }) {
  const page = outcome.page_id ? pages.find((p) => p.id === outcome.page_id) : null;
  const file = outcome.file_id ? files.find((f) => f.id === outcome.file_id) : null;
  let body;
  if (outcome.page_id) {
    body = (
      <Link to={`/p/${outcome.page_id}`} className="idea-outcome-link">
        {page?.icon || OUTCOME_ICONS[outcome.type]} {page?.title || outcome.label || 'Página'}
      </Link>
    );
  } else if (outcome.file_id) {
    body = (
      <button className="idea-outcome-link as-link" onClick={() => file && viewFile(file)}>
        📎 {file?.name || outcome.label || outcome.file_id}
      </button>
    );
  } else {
    let host = outcome.url;
    try {
      host = new URL(outcome.url).hostname;
    } catch {}
    body = (
      <a className="idea-outcome-link" href={safeHref(outcome.url) || undefined} target="_blank" rel="noreferrer">
        <ExternalLink {...ICON} /> {outcome.label || host}
      </a>
    );
  }
  return (
    <li className={`idea-outcome type-${outcome.type}`}>
      <div className="idea-item-head">
        <span className="idea-badge">{OUTCOME_LABELS[outcome.type] || outcome.type}</span>
        <span className="idea-when">{fmtDate(outcome.at)}</span>
        {!readOnly && (
          <span className="idea-item-actions">
            <button className="icon-btn danger" title="Quitar de los resultados (no borra la página)" onClick={onRemove}>
              <Trash2 {...ICON} />
            </button>
          </span>
        )}
      </div>
      {body}
      {outcome.label && outcome.page_id && <div className="idea-outcome-label">{outcome.label}</div>}
      {outcome.note && <div className="idea-hint">{outcome.note}</div>}
    </li>
  );
}

// Selector de página destino (para resultados que ya existen)
function PagePicker({ pages, onPick }) {
  const [q, setQ] = useState('');
  const list = useMemo(() => {
    const t = q.trim().toLowerCase();
    return pages.filter((p) => p.kind !== 'idea' && (!t || (p.title || '').toLowerCase().includes(t))).slice(0, 8);
  }, [pages, q]);
  return (
    <div className="idea-picker">
      <input autoFocus placeholder="Buscar página o canvas existente…" value={q} onChange={(e) => setQ(e.target.value)} />
      <div className="idea-picker-list">
        {list.map((p) => (
          <button key={p.id} onClick={() => onPick(p)}>
            {p.icon || (p.kind === 'canvas' ? '🧩' : '📄')} {p.title || 'Sin título'}
          </button>
        ))}
        {!list.length && <div className="idea-hint">Sin coincidencias</div>}
      </div>
    </div>
  );
}

export default function IdeaView({ pageId, title, initialContent, pages = [], files = [], readOnly = false, onPatched, onFilesChange, onTreeChanged }) {
  const [idea, setIdea] = useState(() => parseIdea(initialContent));
  const [summary, setSummary] = useState(idea.summary || '');
  const [seedText, setSeedText] = useState('');
  const [stepText, setStepText] = useState('');
  const [stepKind, setStepKind] = useState('note');
  const [outcomeMode, setOutcomeMode] = useState(null); // 'pick' | 'external' | 'file' | null
  const [outcomeType, setOutcomeType] = useState('page');
  const [outcomeUrl, setOutcomeUrl] = useState('');
  const [outcomeLabel, setOutcomeLabel] = useState('');
  const [claudeOpen, setClaudeOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [dragOver, setDragOver] = useState(false);
  const [issueOpen, setIssueOpen] = useState(false); // "Crear elemento" desde la idea
  const fileInput = useRef(null);
  const summaryTimer = useRef(null);

  // Cambios remotos (Claude, otra pestaña): se actualizan las listas sin
  // remontar, así no se pierde lo que se está escribiendo en los cuadros de texto.
  // El enunciado solo se sobrescribe si no hay una edición propia pendiente.
  useEffect(() => {
    const next = parseIdea(initialContent);
    setIdea(next);
    if (!summaryTimer.current) setSummary(next.summary || '');
  }, [initialContent]);

  const patch = async (body) => {
    if (readOnly) return null;
    setBusy(true);
    setError(null);
    try {
      const r = await api.patchIdea(pageId, body);
      setIdea(r.idea);
      onPatched?.(r);
      return r;
    } catch (e) {
      setError(e.message);
      return null;
    } finally {
      setBusy(false);
    }
  };

  // Resumen: se guarda al dejar de teclear; si se sale antes, se envía al salir
  const pendingSummary = useRef(null);
  const changeSummary = (v) => {
    setSummary(v);
    pendingSummary.current = v;
    markBusy(`idea-summary:${pageId}`);
    clearTimeout(summaryTimer.current);
    summaryTimer.current = setTimeout(async () => {
      summaryTimer.current = null;
      const value = pendingSummary.current;
      pendingSummary.current = null;
      await patch({ summary: value });
      if (pendingSummary.current === null) clearBusy(`idea-summary:${pageId}`);
    }, 900);
  };
  useEffect(
    () => () => {
      clearTimeout(summaryTimer.current);
      summaryTimer.current = null;
      if (pendingSummary.current !== null && !readOnly) {
        const value = pendingSummary.current;
        pendingSummary.current = null;
        api
          .patchIdea(pageId, { summary: value })
          .catch(() => {})
          .finally(() => clearBusy(`idea-summary:${pageId}`));
      }
    },
    [pageId, readOnly]
  );

  // ---------- Semilla ----------
  const addFiles = async (list) => {
    const arr = Array.from(list || []).filter(Boolean);
    if (!arr.length) return;
    setBusy(true);
    setError(null);
    try {
      const seeds = [];
      for (const f of arr) {
        const meta = await api.uploadFile(f, pageId);
        onFilesChange?.((prev) => [...prev, meta]);
        seeds.push({ kind: isImage(meta) ? 'image' : 'file', file_id: meta.id, name: meta.name });
      }
      await patch({ seeds_add: seeds });
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };

  const addSeedText = async () => {
    const t = seedText.trim();
    if (!t) return;
    const r = await patch({ seeds_add: [isUrl(t) ? { kind: 'link', url: t } : { kind: 'text', text: seedText }] });
    if (r) setSeedText('');
  };

  const onPaste = (e) => {
    const items = Array.from(e.clipboardData?.items || []);
    const images = items.filter((it) => it.kind === 'file' && it.type.startsWith('image/')).map((it) => it.getAsFile());
    if (images.length) {
      e.preventDefault();
      addFiles(images.map((f, i) => new File([f], f.name && f.name !== 'image.png' ? f.name : `captura-${Date.now()}-${i + 1}.png`, { type: f.type })));
    }
  };

  // ---------- Desarrollo ----------
  const addStep = async () => {
    const t = stepText.trim();
    if (!t) return;
    const r = await patch({ steps_add: [{ kind: stepKind, text: stepText, by: 'user' }] });
    if (r) setStepText('');
  };

  // ---------- Resultado ----------
  const seedsAsMarkdown = () =>
    idea.seeds
      .map((s) => {
        if (s.kind === 'text') return s.text;
        if (s.kind === 'image') return `![${s.name || 'captura'}](/files/${s.file_id}/${encodeURIComponent(s.name || 'captura.png')})${s.ocr ? `\n\n> ${s.ocr.split('\n').join('\n> ')}` : ''}`;
        if (s.kind === 'file') return `[${s.name || 'archivo'}](/files/${s.file_id}/${encodeURIComponent(s.name || 'archivo')})`;
        if (s.kind === 'link') return `<${s.url}>`;
        if (s.kind === 'page') return `De [${pages.find((p) => p.id === s.page_id)?.title || 'página'}](/p/${s.page_id})${s.text ? `:\n\n> ${s.text.split('\n').join('\n> ')}` : ''}`;
        return '';
      })
      .filter(Boolean)
      .join('\n\n');

  const decisions = () => idea.steps.filter((s) => s.kind === 'decision').map((s) => `- ${s.text.split('\n').join('\n  ')}`).join('\n');
  const outline = () => idea.steps.filter((s) => s.kind === 'outline').map((s) => s.text).join('\n\n');
  const backlink = `[💡 ${title || 'Idea'}](/p/${pageId})`;

  // Crea desde la idea un documento, un canvas o un planning y lo registra como resultado
  const createOutcome = async (type) => {
    setBusy(true);
    setError(null);
    try {
      let created;
      const name = title || 'Idea';
      if (type === 'canvas') {
        created = await api.createPage({
          kind: 'canvas',
          title: `Mapa: ${name}`,
          icon: '🧩',
          content: {
            nodes: [
              { id: 'idea', type: 'file', file: `/p/${pageId}`, x: 0, y: 0, width: 360, height: 280 },
              { id: 'c1', type: 'text', text: `# ${name}\n\n${summary || 'Enunciado de la idea'}`, x: 440, y: 0, width: 320, height: 160, color: '3' },
              { id: 'c2', type: 'text', text: '## Partes\n- …', x: 440, y: 220, width: 320, height: 140 },
            ],
            edges: [
              { id: 'e1', fromNode: 'idea', fromSide: 'right', toNode: 'c1', toSide: 'left', label: 'enuncia' },
              { id: 'e2', fromNode: 'c1', fromSide: 'bottom', toNode: 'c2', toSide: 'top' },
            ],
          },
        });
      } else if (type === 'plan') {
        const today = new Date().toISOString().slice(0, 10);
        const markdown = [
          `# 🗓 Plan: ${name}`,
          '',
          `Idea de origen: ${backlink}`,
          '',
          summary ? `> ${summary}` : '',
          '',
          '## Hitos',
          '',
          '| Hito | Responsable | Fecha | Estado |',
          '| --- | --- | --- | --- |',
          `| Arranque | | ${today} | ⏳ |`,
          '| | | | |',
          '',
          '## Tareas',
          '',
          '- [ ] …',
          '',
          decisions() ? `## Decisiones ya tomadas\n\n${decisions()}` : '',
        ].join('\n');
        created = await api.capture({ title: `Plan: ${name}`, icon: '🗓', markdown, page_date: today });
      } else {
        const markdown = [
          `# ${name}`,
          '',
          `Idea de origen: ${backlink}`,
          '',
          summary ? `## Resumen\n\n${summary}` : '## Resumen\n\n…',
          '',
          outline() ? `## Esquema\n\n${outline()}` : '',
          decisions() ? `## Decisiones\n\n${decisions()}` : '',
          '## Origen',
          '',
          seedsAsMarkdown() || '_(sin semilla)_',
        ]
          .filter((l) => l !== null)
          .join('\n');
        created = await api.capture({ title: name, icon: '📄', markdown });
      }
      await patch({ outcomes_add: [{ type, page_id: created.id, label: outcomeLabel.trim() || undefined }] });
      setOutcomeLabel('');
      setOutcomeMode(null);
      onTreeChanged?.(); // la página nueva no llega por SSE (es nuestra): se pide el árbol
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };

  const addExistingOutcome = async (page) => {
    const type = page.kind === 'canvas' ? 'canvas' : outcomeType === 'plan' ? 'plan' : 'page';
    const r = await patch({ outcomes_add: [{ type, page_id: page.id, label: outcomeLabel.trim() || undefined }] });
    if (r) {
      setOutcomeMode(null);
      setOutcomeLabel('');
    }
  };

  const addExternal = async () => {
    const u = outcomeUrl.trim();
    if (!isUrl(u)) return setError('Escribe una URL completa (https://…)');
    const r = await patch({ outcomes_add: [{ type: 'external', url: u, label: outcomeLabel.trim() || undefined }] });
    if (r) {
      setOutcomeMode(null);
      setOutcomeUrl('');
      setOutcomeLabel('');
    }
  };

  const addFileOutcome = async (f) => {
    const r = await patch({ outcomes_add: [{ type: 'file', file_id: f.id, label: outcomeLabel.trim() || f.name }] });
    if (r) {
      setOutcomeMode(null);
      setOutcomeLabel('');
    }
  };

  const prompt = claudePrompt(idea, title, pageId);
  const copyPrompt = async () => {
    try {
      await navigator.clipboard.writeText(prompt);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {}
  };

  const seedFiles = new Set(idea.seeds.map((s) => s.file_id).filter(Boolean));
  const outcomeFiles = new Set(idea.outcomes.map((o) => o.file_id).filter(Boolean));
  const spareFiles = files.filter((f) => !seedFiles.has(f.id) && !outcomeFiles.has(f.id));

  return (
    <div
      className={'idea-view' + (readOnly ? ' readonly' : '') + (dragOver ? ' dragover' : '')}
      onDragOver={(e) => {
        if (readOnly || !e.dataTransfer.types.includes('Files')) return;
        e.preventDefault();
        setDragOver(true);
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={(e) => {
        if (readOnly) return;
        e.preventDefault();
        setDragOver(false);
        addFiles(e.dataTransfer.files);
      }}
    >
      <div className="idea-statusbar">
        <div className="idea-steps-status" role="tablist">
          {STATUSES.map((s, i) => (
            <button
              key={s}
              className={'idea-status' + (idea.status === s ? ' active' : '') + (STATUSES.indexOf(idea.status) > i ? ' done' : '')}
              title={STATUS_HINTS[s]}
              disabled={readOnly}
              onClick={() => idea.status !== s && patch({ status: s })}
            >
              <span className="idea-status-n">{i + 1}</span> {STATUS_LABELS[s]}
            </button>
          ))}
        </div>
        {!readOnly && (
          <div className="idea-claude-wrap">
            <button className={'btn primary idea-claude' + (claudeOpen ? ' active' : '')} onClick={() => setClaudeOpen((v) => !v)}>
              <Sparkles {...ICON} /> Desarrollar con Claude
            </button>
            {claudeOpen && (
              <div className="idea-claude-pop" onMouseLeave={() => setClaudeOpen(false)}>
                <p>
                  Abre <strong>claude.ai</strong> con el conector de NoNotion de este espacio y pégale esto. Claude leerá la semilla
                  (también las capturas), te hará preguntas y dejará aquí los pasos y el resultado <em>solo cuando tú se lo pidas</em>.
                </p>
                <pre className="idea-prompt">{prompt}</pre>
                <button className="btn primary" onClick={copyPrompt}>
                  {copied ? <Check {...ICON} /> : <Copy {...ICON} />} {copied ? 'Copiado' : 'Copiar'}
                </button>
              </div>
            )}
          </div>
        )}
      </div>

      <label className="idea-summary">
        <span className="idea-col-title">Enunciado</span>
        {readOnly ? (
          summary ? <Md text={summary} /> : <div className="idea-hint">Sin enunciado</div>
        ) : (
          <textarea
            className="idea-textarea idea-summary-input"
            placeholder="¿Qué es la idea, en una o dos frases? Se irá afinando con el desarrollo."
            value={summary}
            onChange={(e) => changeSummary(e.target.value)}
            rows={2}
          />
        )}
      </label>

      {error && <div className="idea-error">⚠ {error}</div>}

      <div className="idea-columns">
        <section className="idea-col idea-col-seed">
          <h3 className="idea-col-title">
            🌱 Semilla <span className="idea-n">{idea.seeds.length}</span>
          </h3>
          <p className="idea-col-hint">Lo que llegó, tal cual. No se reescribe: es el origen.</p>
          <ul className="idea-list">
            {idea.seeds.map((s) => (
              <Seed
                key={s.id}
                seed={s}
                files={files}
                pages={pages}
                readOnly={readOnly}
                onRemove={() => confirm('¿Quitar esta semilla de la idea?') && patch({ remove: { seeds: [s.id] } })}
                onNote={(note) => patch({ seeds_update: [{ id: s.id, note }] })}
              />
            ))}
          </ul>
          {!readOnly && (
            <div className="idea-add">
              <textarea
                className="idea-textarea"
                placeholder="Pega aquí texto, una lista de temas, un enlace… o una captura (Ctrl+V). También puedes arrastrar archivos."
                value={seedText}
                rows={3}
                onChange={(e) => setSeedText(e.target.value)}
                onPaste={onPaste}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) addSeedText();
                }}
              />
              <div className="idea-add-actions">
                <button className="btn" onClick={() => fileInput.current?.click()} title="Subir captura o archivo">
                  <Upload {...ICON} /> Captura / archivo
                </button>
                <button className="btn primary" onClick={addSeedText} disabled={!seedText.trim() || busy}>
                  <Plus {...ICON} /> Añadir semilla
                </button>
              </div>
              <input
                ref={fileInput}
                type="file"
                multiple
                hidden
                onChange={(e) => {
                  addFiles(e.target.files);
                  e.target.value = '';
                }}
              />
            </div>
          )}
        </section>

        <section className="idea-col idea-col-dev">
          <h3 className="idea-col-title">
            🔧 Desarrollo <span className="idea-n">{idea.steps.length}</span>
          </h3>
          <p className="idea-col-hint">El razonamiento, paso a paso: qué se pregunta, qué se decide y qué se descarta.</p>
          <ul className="idea-list idea-timeline">
            {idea.steps.map((s) => (
              <Step
                key={s.id}
                step={s}
                readOnly={readOnly}
                onEdit={(u) => patch({ steps_update: [{ id: s.id, ...u }] })}
                onRemove={() => confirm('¿Quitar este paso?') && patch({ remove: { steps: [s.id] } })}
              />
            ))}
            {!idea.steps.length && <li className="idea-empty">Todavía sin pasos. Escribe el primero o pídeselo a Claude.</li>}
          </ul>
          {!readOnly && (
            <div className="idea-add">
              <div className="idea-add-row">
                <select value={stepKind} onChange={(e) => setStepKind(e.target.value)} title="Tipo de paso">
                  {STEP_KINDS.map((k) => (
                    <option key={k} value={k}>
                      {STEP_LABELS[k]}
                    </option>
                  ))}
                </select>
              </div>
              <textarea
                className="idea-textarea"
                placeholder="Nuevo paso (Markdown). Ctrl+Enter para añadir."
                value={stepText}
                rows={3}
                onChange={(e) => setStepText(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) addStep();
                }}
              />
              <div className="idea-add-actions">
                <button className="btn primary" onClick={addStep} disabled={!stepText.trim() || busy}>
                  <Plus {...ICON} /> Añadir paso
                </button>
              </div>
            </div>
          )}
        </section>

        <section className="idea-col idea-col-out">
          <h3 className="idea-col-title">
            📦 Resultado <span className="idea-n">{idea.outcomes.length}</span>
          </h3>
          <p className="idea-col-hint">Dónde ha acabado: páginas, diagramas, planning, archivos o documentos fuera de NoNotion.</p>
          <ul className="idea-list">
            {idea.outcomes.map((o) => (
              <Outcome
                key={o.id}
                outcome={o}
                pages={pages}
                files={files}
                readOnly={readOnly}
                onRemove={() => patch({ remove: { outcomes: [o.id] } })}
              />
            ))}
            {!idea.outcomes.length && <li className="idea-empty">Aún no se ha materializado.</li>}
          </ul>
          {!readOnly && (
            <div className="idea-add idea-outcome-add">
              <input
                className="idea-label-input"
                placeholder="Etiqueta del resultado (p. ej. «Documento de diseño»)"
                value={outcomeLabel}
                onChange={(e) => setOutcomeLabel(e.target.value)}
              />
              <div className="idea-create-row">
                <button className="btn" onClick={() => createOutcome('page')} disabled={busy} title="Crea una página con el enunciado, el esquema, las decisiones y la semilla">
                  <FileText {...ICON} /> Crear documento
                </button>
                <button className="btn" onClick={() => createOutcome('canvas')} disabled={busy} title="Crea un canvas con la idea enlazada para dibujar el diagrama">
                  <LayoutDashboard {...ICON} /> Crear diagrama
                </button>
                <button className="btn" onClick={() => createOutcome('plan')} disabled={busy} title="Crea una página de planificación con hitos y tareas, fijada a hoy en el calendario">
                  <CalendarDays {...ICON} /> Crear planning
                </button>
                <button className="btn" onClick={() => setIssueOpen(true)} disabled={busy} title="Convierte la idea en un elemento de seguimiento (tarea, riesgo, decisión…) enlazado a ella">
                  <ListChecks {...ICON} /> Crear elemento
                </button>
              </div>
              <div className="idea-create-row">
                <button
                  className={'btn' + (outcomeMode === 'pick' ? ' active' : '')}
                  onClick={() => {
                    setOutcomeType('page');
                    setOutcomeMode(outcomeMode === 'pick' ? null : 'pick');
                  }}
                >
                  Enlazar página existente
                </button>
                <button className={'btn' + (outcomeMode === 'external' ? ' active' : '')} onClick={() => setOutcomeMode(outcomeMode === 'external' ? null : 'external')}>
                  Documento externo
                </button>
                {spareFiles.length > 0 && (
                  <button className={'btn' + (outcomeMode === 'file' ? ' active' : '')} onClick={() => setOutcomeMode(outcomeMode === 'file' ? null : 'file')}>
                    Archivo adjunto
                  </button>
                )}
              </div>
              {outcomeMode === 'pick' && (
                <>
                  <div className="idea-add-row">
                    <label className="idea-inline">
                      <input type="radio" checked={outcomeType === 'page'} onChange={() => setOutcomeType('page')} /> Documento
                    </label>
                    <label className="idea-inline">
                      <input type="radio" checked={outcomeType === 'plan'} onChange={() => setOutcomeType('plan')} /> Planning
                    </label>
                  </div>
                  <PagePicker pages={pages} onPick={addExistingOutcome} />
                </>
              )}
              {outcomeMode === 'external' && (
                <div className="idea-add-row">
                  <input
                    autoFocus
                    placeholder="https://docs.google.com/…"
                    value={outcomeUrl}
                    onChange={(e) => setOutcomeUrl(e.target.value)}
                    onKeyDown={(e) => e.key === 'Enter' && addExternal()}
                  />
                  <button className="btn primary" onClick={addExternal} disabled={busy}>
                    Añadir
                  </button>
                </div>
              )}
              {outcomeMode === 'file' && (
                <div className="idea-picker-list">
                  {spareFiles.map((f) => (
                    <button key={f.id} onClick={() => addFileOutcome(f)}>
                      📎 {f.name}
                    </button>
                  ))}
                </div>
              )}
              <p className="idea-hint">
                Lo creado aquí va al Inbox del espacio: muévelo después con «Mover a…». Para que Claude lo haga por ti, usa «Desarrollar
                con Claude» y pídele que lo documente.
              </p>
            </div>
          )}
        </section>
      </div>
      {issueOpen && (
        <NewIssueDialog
          initial={{ title: summary || title || '', description: summary ? `Sale de la idea «${title}».` : '', extra: { from_idea_id: pageId } }}
          onClose={() => setIssueOpen(false)}
          onCreate={async (body) => {
            await api.createIssue(body);
            setIssueOpen(false);
            // el servidor ya registró el resultado en la idea: se relee
            const p = await api.page(pageId);
            setIdea(parseIdea(p.content));
            onTreeChanged?.();
          }}
        />
      )}
    </div>
  );
}
