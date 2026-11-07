// Mover páginas en el árbol: la única función de dominio para hacerlo. La
// usan la interfaz (arrastrar en el árbol, "Mover a…") y el MCP (move_page,
// move_pages).
//
// El árbol se guarda solo con pages.parent_id; el orden entre hermanos, con
// pages.position (empates por created_at). No hay rutas ni profundidad
// guardadas: se calculan al vuelo. Mover una página arrastra su subárbol sin
// tocar a los hijos (siguen apuntando a ella), y sus ids, etiquetas, adjuntos e
// historial no cambian. Las versiones solo guardan contenido, así que un
// movimiento no crea versión (no cambia el contenido).
import db from './db.js';

export class MoveError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

const getPage = db.prepare('SELECT id, parent_id, title, workspace_id, trashed_at FROM pages WHERE id = ?');
const subtreeStmt = db.prepare(
  `WITH RECURSIVE sub(id) AS (
     SELECT id FROM pages WHERE id = ?
     UNION ALL
     SELECT p.id FROM pages p JOIN sub s ON p.parent_id = s.id
   ) SELECT id FROM sub`
);
const siblingsStmt = db.prepare(
  `SELECT id FROM pages WHERE parent_id IS ? AND workspace_id = ? AND trashed_at IS NULL AND id != ?
   ORDER BY position, created_at`
);
const setPosition = db.prepare('UPDATE pages SET position = ? WHERE id = ?');
const setParent = db.prepare(`UPDATE pages SET parent_id = ?, updated_at = datetime('now') WHERE id = ?`);

const label = (p) => `«${p.title || 'Sin título'}»`;

// "Inbox / Fails": títulos desde la raíz
export function pathOf(id) {
  const parts = [];
  const seen = new Set();
  for (let cur = getPage.get(id); cur && !seen.has(cur.id); cur = cur.parent_id ? getPage.get(cur.parent_id) : null) {
    seen.add(cur.id);
    parts.unshift(cur.title || 'Sin título');
  }
  return parts.join(' / ');
}

function renumber(ids) {
  ids.forEach((id, i) => setPosition.run(i, id));
}

// Una página de este espacio, viva: si no, error claro (sin revelar otros espacios)
function livePage(id, ws, role) {
  const p = typeof id === 'string' && id ? getPage.get(id) : null;
  if (!p || p.workspace_id !== ws) {
    throw new MoveError(
      role === 'destino'
        ? `La página destino "${id}" no existe en este espacio (no se puede mover entre espacios)`
        : `La página "${id}" no existe en este espacio`,
      404
    );
  }
  if (p.trashed_at) {
    throw new MoveError(
      role === 'destino' ? `La página destino ${label(p)} está en la papelera` : `La página ${label(p)} está en la papelera`
    );
  }
  return p;
}

// Mueve una página. move = { page_id, parent_id (null = raíz), index?, before_id?, after_id? }
function moveOne(ws, move) {
  const page = livePage(move.page_id, ws, 'origen');
  if (move.parent_id === undefined) {
    throw new MoveError('Falta el padre destino (usa null para mover a la raíz del espacio)');
  }
  const parentId = move.parent_id === null ? null : String(move.parent_id);

  if (parentId !== null) {
    const parent = livePage(parentId, ws, 'destino');
    if (parent.id === page.id) throw new MoveError(`Una página no puede moverse dentro de sí misma (${label(page)})`);
    const descendants = subtreeStmt.all(page.id).map((r) => r.id);
    if (descendants.includes(parent.id)) {
      throw new MoveError(`Movimiento inválido: ${label(parent)} es subpágina de ${label(page)} y crearía un ciclo`);
    }
  }

  const given = ['index', 'before_id', 'after_id'].filter((k) => move[k] !== undefined && move[k] !== null);
  if (given.length > 1) throw new MoveError('Indica solo una posición: index, before_id o after_id');
  const sameParent = (page.parent_id || null) === parentId;
  const subpages = subtreeStmt.all(page.id).length - 1;

  if (sameParent && !given.length) {
    const path = pathOf(page.id);
    return { noop: true, id: page.id, title: page.title, from: path, to: path, subpages };
  }

  const siblings = siblingsStmt.all(parentId, ws, page.id).map((r) => r.id);
  let at = siblings.length; // por defecto, al final
  if (given[0] === 'index') {
    const n = Number(move.index);
    if (!Number.isInteger(n) || n < 0) throw new MoveError('index debe ser un entero >= 0');
    at = Math.min(n, siblings.length);
  } else if (given.length) {
    const ref = String(move[given[0]]);
    const i = siblings.indexOf(ref);
    if (i < 0) throw new MoveError(`${given[0]} "${ref}" no es una página hermana en el destino`);
    at = given[0] === 'before_id' ? i : i + 1;
  }

  const from = pathOf(page.id);
  // Origen: los hermanos que quedan se renumeran sin huecos
  if (!sameParent) renumber(siblingsStmt.all(page.parent_id || null, ws, page.id).map((r) => r.id));
  // Destino: la página entra en su posición y se renumera
  siblings.splice(at, 0, page.id);
  renumber(siblings);
  if (!sameParent) setParent.run(parentId, page.id);
  else db.prepare(`UPDATE pages SET updated_at = datetime('now') WHERE id = ?`).run(page.id);

  return {
    noop: false,
    id: page.id,
    title: page.title,
    from,
    to: pathOf(page.id),
    subpages,
    old_parent_id: page.parent_id || null,
    new_parent_id: parentId,
    index: at,
  };
}

// Aplica uno o varios movimientos en una única transacción: si uno falla, no
// se aplica ninguno. Los movimientos se aplican en orden (cada uno ve el
// resultado del anterior).
export function movePages(ws, moves) {
  if (!Array.isArray(moves) || !moves.length) throw new MoveError('No hay movimientos');
  return db.transaction(() =>
    moves.map((m, i) => {
      try {
        return moveOne(ws, m || {});
      } catch (e) {
        if (moves.length > 1 && e instanceof MoveError) {
          throw new MoveError(`Movimiento ${i + 1} de ${moves.length} (${m?.page_id}): ${e.message}. No se ha aplicado ninguno.`, e.status);
        }
        throw e;
      }
    })
  )();
}

// Texto para la respuesta: "Inbox / Fails → ONYX / MVP / Fails (3 subpáginas)"
export function describeMove(r) {
  const sub = r.subpages ? ` (${r.subpages} subpágina${r.subpages === 1 ? '' : 's'})` : '';
  if (r.noop) return `Sin cambios: «${r.title || 'Sin título'}» ya está en ${r.to}${sub}`;
  return `«${r.title || 'Sin título'}»: ${r.from} → ${r.to}${sub}`;
}
