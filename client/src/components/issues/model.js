// Elementos de seguimiento (issues): constantes compartidas por las vistas.
// El servidor valida en server/issues.js.

export const STATUSES = ['open', 'in_progress', 'blocked', 'resolved', 'closed'];
export const OPEN_STATUSES = new Set(['open', 'in_progress', 'blocked']);
export const STATUS_LABELS = { open: 'Abierto', in_progress: 'En curso', blocked: 'Bloqueado', resolved: 'Resuelto', closed: 'Cerrado' };
export const TYPES = ['blocker', 'problem', 'risk', 'task', 'decision', 'question'];
export const TYPE_LABELS = { blocker: 'Bloqueo', problem: 'Problema', risk: 'Riesgo', task: 'Tarea', decision: 'Decisión', question: 'Pregunta' };
export const TYPE_ICONS = { blocker: '🚧', problem: '🐞', risk: '⚠️', task: '✅', decision: '⚖️', question: '❓' };
export const PRIORITIES = ['low', 'medium', 'high', 'critical'];
export const PRIORITY_LABELS = { low: 'Baja', medium: 'Media', high: 'Alta', critical: 'Crítica' };
export const LINK_TYPES = ['blocks', 'relates', 'documents', 'origin'];
export const LINK_LABELS = { blocks: 'Bloquea a', relates: 'Relacionado con', documents: 'Documentado en', origin: 'Viene de' };
export const LINK_INVERSE = { blocks: 'Bloqueado por', relates: 'Relacionado con', documents: 'Documenta', origin: 'Originó' };
export const FIELD_LABELS = { status: 'estado', type: 'tipo', priority: 'prioridad', assignee: 'responsable', due_date: 'fecha límite', milestone: 'hito', title: 'título' };

export const valueLabel = (field, v) =>
  v == null || v === ''
    ? '—'
    : field === 'status'
      ? STATUS_LABELS[v] || v
      : field === 'type'
        ? TYPE_LABELS[v] || v
        : field === 'priority'
          ? PRIORITY_LABELS[v] || v
          : v;

export const today = () => new Date().toISOString().slice(0, 10);
export const overdue = (i) => i.due_date && OPEN_STATUSES.has(i.status) && i.due_date < today();

export function fmtWhen(at) {
  if (!at) return '';
  const d = new Date(at.includes('T') ? at : at.replace(' ', 'T') + 'Z');
  if (Number.isNaN(d.getTime())) return at.slice(0, 16);
  return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' }) + ' ' + d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}
