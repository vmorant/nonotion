// Ideas: desarrollo de ideas fuera del árbol de notas. Una idea es una página
// con kind = 'idea' y este JSON como contenido:
//
//   { type: 'idea', status, summary, seeds: [...], steps: [...], outcomes: [...] }
//
// - seeds (semilla): lo que llegó en bruto (texto pegado, captura, archivo,
//   enlace, fragmento de una página). Se conserva tal cual, como origen; si es
//   una imagen, el servidor le añade el texto reconocido (OCR) para buscarla.
// - steps (desarrollo): pasos fechados del trabajo sobre la semilla (preguntas,
//   hipótesis, decisiones, descartes, esquemas), de la persona o de Claude.
// - outcomes (resultado): dónde se ha materializado (páginas, canvas, archivos,
//   documentos externos), con enlace en ambos sentidos vía grafo y backlinks.
// - status: seed → developing → documented → archived.
import crypto from 'crypto';

export const STATUSES = ['seed', 'developing', 'documented', 'archived'];
export const STATUS_LABELS = { seed: 'Semilla', developing: 'En desarrollo', documented: 'Documentada', archived: 'Archivada' };
export const SEED_KINDS = ['text', 'image', 'file', 'link', 'page'];
export const STEP_KINDS = ['note', 'question', 'answer', 'hypothesis', 'decision', 'discarded', 'outline'];
export const STEP_LABELS = {
  note: 'Nota',
  question: 'Pregunta',
  answer: 'Respuesta',
  hypothesis: 'Hipótesis',
  decision: 'Decisión',
  discarded: 'Descartado',
  outline: 'Esquema',
};
export const OUTCOME_TYPES = ['page', 'canvas', 'plan', 'file', 'external'];
export const OUTCOME_LABELS = { page: 'Página', canvas: 'Canvas', plan: 'Planning', file: 'Archivo', external: 'Externo' };
export const EMPTY_IDEA = { type: 'idea', status: 'seed', summary: '', seeds: [], steps: [], outcomes: [] };

const MAX_ITEMS = 2000;
const MAX_TEXT = 200000;
const ID_RE = /^[A-Za-z0-9_-]{6,64}$/;

export class IdeaError extends Error {}

export const newId = () => crypto.randomBytes(5).toString('hex');
const now = () => new Date().toISOString().slice(0, 19).replace('T', ' ');
const str = (v, max = 2000) => (typeof v === 'string' ? v.slice(0, max) : undefined);
const stamp = (v) => (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}/.test(v) ? v.slice(0, 19) : now());

// ¿Es una idea este contenido (objeto o JSON)?
export function parseIdea(content) {
  let c = content;
  if (typeof c === 'string') {
    if (!c.trim().startsWith('{')) return null;
    try {
      c = JSON.parse(c);
    } catch {
      return null;
    }
  }
  if (!c || typeof c !== 'object' || c.type !== 'idea') return null;
  return c;
}

function normalizeSeed(s, i) {
  if (!s || typeof s !== 'object') throw new IdeaError(`Semilla ${i + 1}: no es un objeto`);
  if (!SEED_KINDS.includes(s.kind)) throw new IdeaError(`Semilla ${i + 1}: tipo "${s.kind}" no válido (${SEED_KINDS.join(', ')})`);
  const out = { id: str(s.id, 64) || newId(), at: stamp(s.at), kind: s.kind };
  if (s.text !== undefined) out.text = str(s.text, MAX_TEXT);
  if (s.note !== undefined) out.note = str(s.note, 5000);
  if (s.kind === 'image' || s.kind === 'file') {
    if (!ID_RE.test(s.file_id || '')) throw new IdeaError(`Semilla ${i + 1}: falta file_id (sube antes el archivo)`);
    out.file_id = s.file_id;
    if (s.name !== undefined) out.name = str(s.name, 300);
    if (s.ocr !== undefined) out.ocr = str(s.ocr, MAX_TEXT);
  }
  if (s.kind === 'link') {
    out.url = str(s.url, 2000);
    if (!out.url) throw new IdeaError(`Semilla ${i + 1}: falta url`);
  }
  if (s.kind === 'page') {
    if (!ID_RE.test(s.page_id || '')) throw new IdeaError(`Semilla ${i + 1}: falta page_id`);
    out.page_id = s.page_id;
  }
  if (s.kind === 'text' && !out.text?.trim()) throw new IdeaError(`Semilla ${i + 1}: el texto está vacío`);
  return out;
}

function normalizeStep(s, i) {
  if (!s || typeof s !== 'object') throw new IdeaError(`Paso ${i + 1}: no es un objeto`);
  const kind = STEP_KINDS.includes(s.kind) ? s.kind : 'note';
  const text = str(s.text, MAX_TEXT);
  if (!text?.trim()) throw new IdeaError(`Paso ${i + 1}: el texto está vacío`);
  return { id: str(s.id, 64) || newId(), at: stamp(s.at), kind, text, by: s.by === 'claude' ? 'claude' : 'user' };
}

function normalizeOutcome(o, i) {
  if (!o || typeof o !== 'object') throw new IdeaError(`Resultado ${i + 1}: no es un objeto`);
  if (!OUTCOME_TYPES.includes(o.type)) throw new IdeaError(`Resultado ${i + 1}: tipo "${o.type}" no válido (${OUTCOME_TYPES.join(', ')})`);
  const out = { id: str(o.id, 64) || newId(), at: stamp(o.at), type: o.type };
  if (o.label !== undefined) out.label = str(o.label, 300);
  if (o.note !== undefined) out.note = str(o.note, 5000);
  if (o.type === 'page' || o.type === 'canvas' || o.type === 'plan') {
    if (!ID_RE.test(o.page_id || '')) throw new IdeaError(`Resultado ${i + 1}: falta page_id`);
    out.page_id = o.page_id;
  } else if (o.type === 'file') {
    if (!ID_RE.test(o.file_id || '')) throw new IdeaError(`Resultado ${i + 1}: falta file_id`);
    out.file_id = o.file_id;
  } else {
    out.url = str(o.url, 2000);
    if (!out.url) throw new IdeaError(`Resultado ${i + 1}: falta url`);
  }
  return out;
}

// Valida y limpia una idea entera
export function normalizeIdea(input) {
  const c = input === null || input === undefined || input === '' ? EMPTY_IDEA : parseIdea(input);
  if (!c) throw new IdeaError('El contenido no es una idea válida (se espera { type: "idea", seeds, steps, outcomes })');
  for (const k of ['seeds', 'steps', 'outcomes']) {
    if (c[k] !== undefined && !Array.isArray(c[k])) throw new IdeaError(`"${k}" debe ser una lista`);
    if ((c[k] || []).length > MAX_ITEMS) throw new IdeaError(`Demasiados elementos en "${k}" (máx. ${MAX_ITEMS})`);
  }
  const dedupe = (list) => {
    const seen = new Set();
    return list.map((x) => {
      let id = x.id;
      while (seen.has(id)) id = `${id}-${newId().slice(0, 3)}`;
      seen.add(id);
      return { ...x, id };
    });
  };
  return {
    type: 'idea',
    status: STATUSES.includes(c.status) ? c.status : 'seed',
    summary: str(c.summary, 20000) || '',
    seeds: dedupe((c.seeds || []).map(normalizeSeed)),
    steps: dedupe((c.steps || []).map(normalizeStep)),
    outcomes: dedupe((c.outcomes || []).map(normalizeOutcome)),
  };
}

// Aplica un parche parcial (lo que usan la interfaz y el MCP): cambios de
// estado y resumen, altas, bajas y ediciones de semillas/pasos/resultados.
export function patchIdea(current, patch = {}) {
  const idea = normalizeIdea(current);
  const p = patch || {};
  if (p.status !== undefined) {
    if (!STATUSES.includes(p.status)) throw new IdeaError(`Estado "${p.status}" no válido (${STATUSES.join(', ')})`);
    idea.status = p.status;
  }
  if (p.summary !== undefined) idea.summary = str(p.summary, 20000) || '';
  const rm = p.remove || {};
  for (const k of ['seeds', 'steps', 'outcomes']) {
    if (Array.isArray(rm[k]) && rm[k].length) {
      const gone = new Set(rm[k]);
      idea[k] = idea[k].filter((x) => !gone.has(x.id));
    }
  }
  if (Array.isArray(p.steps_update)) {
    for (const u of p.steps_update) {
      const s = idea.steps.find((x) => x.id === u?.id);
      if (!s) throw new IdeaError(`Paso "${u?.id}" no existe`);
      if (u.text !== undefined) s.text = str(u.text, MAX_TEXT) || s.text;
      if (u.kind !== undefined && STEP_KINDS.includes(u.kind)) s.kind = u.kind;
    }
  }
  if (Array.isArray(p.outcomes_update)) {
    for (const u of p.outcomes_update) {
      const o = idea.outcomes.find((x) => x.id === u?.id);
      if (!o) throw new IdeaError(`Resultado "${u?.id}" no existe`);
      if (u.label !== undefined) o.label = str(u.label, 300);
      if (u.note !== undefined) o.note = str(u.note, 5000);
    }
  }
  if (Array.isArray(p.seeds_update)) {
    for (const u of p.seeds_update) {
      const s = idea.seeds.find((x) => x.id === u?.id);
      if (!s) throw new IdeaError(`Semilla "${u?.id}" no existe`);
      if (u.note !== undefined) s.note = str(u.note, 5000);
      if (u.text !== undefined && s.kind === 'text') s.text = str(u.text, MAX_TEXT) || s.text;
    }
  }
  const add = (k, list, fn) => {
    if (!Array.isArray(list) || !list.length) return;
    idea[k] = idea[k].concat(list.map((x, i) => fn({ ...x, id: undefined, at: undefined }, i)));
  };
  add('seeds', p.seeds_add, normalizeSeed);
  add('steps', p.steps_add, normalizeStep);
  add('outcomes', p.outcomes_add, normalizeOutcome);
  // Transiciones automáticas: trabajar sobre una semilla la pone en desarrollo;
  // un resultado la da por documentada (salvo que el parche fije otro estado)
  if (p.status === undefined) {
    if (idea.status === 'seed' && idea.steps.length) idea.status = 'developing';
    if ((idea.status === 'seed' || idea.status === 'developing') && Array.isArray(p.outcomes_add) && p.outcomes_add.length) {
      idea.status = 'documented';
    }
  }
  return normalizeIdea(idea);
}

// Texto buscable: resumen, semillas (incluido el OCR), pasos y resultados
export function ideaText(content) {
  const c = parseIdea(content);
  if (!c) return '';
  const parts = [];
  if (c.summary) parts.push(c.summary);
  for (const s of c.seeds || []) {
    if (s.text) parts.push(s.text);
    if (s.ocr) parts.push(s.ocr);
    if (s.note) parts.push(s.note);
    if (s.url) parts.push(s.url);
    if (s.name) parts.push(s.name);
  }
  for (const s of c.steps || []) if (s.text) parts.push(s.text);
  for (const o of c.outcomes || []) {
    if (o.label) parts.push(o.label);
    if (o.note) parts.push(o.note);
    if (o.url) parts.push(o.url);
  }
  return parts.join('\n');
}

// Páginas a las que apunta la idea (semillas de página, resultados y enlaces
// /p/<id> en los textos): para el grafo y los backlinks
export function ideaLinkedPageIds(content) {
  const out = new Set();
  const c = parseIdea(content);
  if (!c) return out;
  const scan = (s) => {
    for (const m of String(s || '').matchAll(/\/p\/([A-Za-z0-9_-]{6,})/g)) out.add(m[1]);
  };
  for (const s of c.seeds || []) {
    if (s.page_id) out.add(s.page_id);
    scan(s.text);
    scan(s.note);
  }
  for (const s of c.steps || []) scan(s.text);
  for (const o of c.outcomes || []) {
    if (o.page_id) out.add(o.page_id);
    scan(o.note);
  }
  scan(c.summary);
  return out;
}

const firstLine = (t) => (t || '').split('\n').find((l) => l.trim())?.trim() || '';

// Resumen en Markdown para Claude (read_page), compartir y exportar
export function ideaToMarkdown(content, { titleOf = () => null, fileOf = () => null } = {}) {
  const c = normalizeIdea(content);
  const pageRef = (pid) => `página «${titleOf(pid) || pid}» (/p/${pid})`;
  const fileRef = (fid) => {
    const f = fileOf(fid);
    return f ? `${f.name} (file_id: ${fid})` : `archivo ${fid}`;
  };
  const lines = [`Idea · estado: ${STATUS_LABELS[c.status]}`, ''];
  if (c.summary) lines.push('## Resumen', '', c.summary, '');
  lines.push(`## Semilla (${c.seeds.length})`, '');
  if (!c.seeds.length) lines.push('_(sin semillas todavía)_');
  for (const s of c.seeds) {
    const head = `- [${s.id}] ${s.at.slice(0, 10)} · `;
    if (s.kind === 'text') {
      lines.push(head + 'texto:');
      lines.push(...(s.text || '').split('\n').map((l) => '    ' + l));
    } else if (s.kind === 'image') {
      lines.push(head + `captura ${fileRef(s.file_id)}${s.ocr ? ' · texto reconocido (OCR):' : ' · (mírala con read_attachment)'}`);
      if (s.ocr) lines.push(...s.ocr.split('\n').map((l) => '    ' + l));
    } else if (s.kind === 'file') lines.push(head + `archivo ${fileRef(s.file_id)} (léelo con read_attachment)`);
    else if (s.kind === 'link') lines.push(head + `enlace ${s.url}`);
    else if (s.kind === 'page') {
      lines.push(head + `fragmento de la ${pageRef(s.page_id)}${s.text ? ':' : ''}`);
      if (s.text) lines.push(...s.text.split('\n').map((l) => '    ' + l));
    }
    if (s.note) lines.push(`    _Nota: ${s.note}_`);
  }
  lines.push('', `## Desarrollo (${c.steps.length})`, '');
  if (!c.steps.length) lines.push('_(sin pasos todavía)_');
  for (const s of c.steps) {
    lines.push(`- [${s.id}] ${s.at.slice(0, 16)} · ${STEP_LABELS[s.kind]} (${s.by === 'claude' ? 'Claude' : 'persona'}):`);
    lines.push(...s.text.split('\n').map((l) => '    ' + l));
  }
  lines.push('', `## Resultado (${c.outcomes.length})`, '');
  if (!c.outcomes.length) lines.push('_(todavía no se ha materializado)_');
  for (const o of c.outcomes) {
    let where;
    if (o.page_id) where = pageRef(o.page_id);
    else if (o.file_id) where = fileRef(o.file_id);
    else where = o.url;
    lines.push(`- [${o.id}] ${o.at.slice(0, 10)} · ${OUTCOME_LABELS[o.type]}${o.label ? ` «${o.label}»` : ''}: ${where}${o.note ? ` — ${o.note}` : ''}`);
  }
  return lines.join('\n');
}

// Título sugerido a partir de la primera semilla
export function ideaTitleFrom(seedText, fallback = 'Idea') {
  const line = firstLine(seedText).replace(/^#+\s*/, '').replace(/[*_`>\[\]]/g, '').trim();
  return line ? (line.length > 80 ? line.slice(0, 77) + '…' : line) : fallback;
}

// Resumen corto de una idea para listados (vista Ideas, list_ideas)
export function ideaDigest(content) {
  const c = normalizeIdea(content);
  const first = c.seeds[0];
  let preview = c.summary ? firstLine(c.summary) : '';
  if (!preview && first) {
    preview = first.text ? firstLine(first.text) : first.ocr ? firstLine(first.ocr) : first.url || first.name || '';
  }
  return {
    status: c.status,
    summary: c.summary,
    preview: preview.slice(0, 200),
    seeds: c.seeds.length,
    steps: c.steps.length,
    outcomes: c.outcomes.map(({ id, type, label, page_id, file_id, url }) => ({ id, type, label, page_id, file_id, url })),
    has_image: c.seeds.some((s) => s.kind === 'image'),
    last_step_at: c.steps.length ? c.steps[c.steps.length - 1].at : null,
  };
}
