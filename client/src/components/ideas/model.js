// Modelo de las ideas en el cliente (el servidor valida en server/idea.js).
// Una idea tiene tres partes que no se mezclan: semilla (lo que llegó),
// desarrollo (el trabajo sobre ella) y resultado (dónde se materializó).

export const STATUSES = ['seed', 'developing', 'documented', 'archived'];
export const STATUS_LABELS = { seed: 'Semilla', developing: 'En desarrollo', documented: 'Documentada', archived: 'Archivada' };
export const STATUS_HINTS = {
  seed: 'Llegó pero nadie la ha trabajado todavía',
  developing: 'Se está dando forma: preguntas, hipótesis, decisiones',
  documented: 'Ya tiene resultado: páginas, diagramas, planning o documentos',
  archived: 'Descartada o aparcada; se conserva el razonamiento',
};
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
export const OUTCOME_TYPES = ['page', 'canvas', 'plan', 'issue', 'file', 'external'];
export const OUTCOME_LABELS = { page: 'Página', canvas: 'Diagrama / canvas', plan: 'Planning', issue: 'Elemento de seguimiento', file: 'Archivo', external: 'Documento externo' };
export const OUTCOME_ICONS = { page: '📄', canvas: '🧩', plan: '🗓', issue: '📋', file: '📎', external: '🔗' };

export const EMPTY_IDEA = { type: 'idea', status: 'seed', summary: '', seeds: [], steps: [], outcomes: [] };

export function parseIdea(content) {
  let c = content;
  if (typeof c === 'string') {
    try {
      c = JSON.parse(c);
    } catch {
      c = null;
    }
  }
  if (!c || typeof c !== 'object' || c.type !== 'idea') return { ...EMPTY_IDEA };
  return {
    ...EMPTY_IDEA,
    ...c,
    seeds: Array.isArray(c.seeds) ? c.seeds : [],
    steps: Array.isArray(c.steps) ? c.steps : [],
    outcomes: Array.isArray(c.outcomes) ? c.outcomes : [],
  };
}

export const isUrl = (t) => /^https?:\/\/\S+$/i.test((t || '').trim());

// Texto del prompt que se le pega a Claude (claude.ai con el conector de NoNotion)
export function claudePrompt(idea, title, id) {
  const base = `Desarrolla conmigo la idea «${title || 'Sin título'}» (id: ${id}) de NoNotion.`;
  if (idea.status === 'seed') return `${base} Léela con read_page (mira sus capturas con read_attachment), hazme las preguntas que falten y, cuando yo te lo diga, deja los pasos con develop_idea.`;
  if (idea.status === 'developing') return `${base} Lee su desarrollo con read_page y sigamos desde el último paso (deja los nuevos con develop_idea cuando te lo diga); cuando esté clara, propón cómo documentarla (páginas, diagrama, planning) y materialízala con materialize_idea cuando te lo pida.`;
  return `${base} Lee con read_page lo que ya tiene y dime qué falta o qué actualizar.`;
}

export function fmtDate(at) {
  if (!at) return '';
  const d = new Date(at.includes('T') ? at : at.replace(' ', 'T') + (at.length <= 19 ? 'Z' : ''));
  if (Number.isNaN(d.getTime())) return at.slice(0, 10);
  return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' }) + ' ' + d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}
