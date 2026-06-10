import { useEffect, useState } from 'react';
import { api } from '../api.js';

export default function TrashModal({ onClose, onChanged }) {
  const [items, setItems] = useState(null);

  const refresh = () => api.trash().then(setItems);

  useEffect(() => {
    refresh();
  }, []);

  const restore = async (id) => {
    await api.restoreTrash(id);
    refresh();
    onChanged();
  };

  const removeForever = async (id) => {
    if (!confirm('¿Eliminar definitivamente? Esto borra la página, sus subpáginas y archivos. No se puede deshacer.'))
      return;
    await api.deleteTrashItem(id);
    refresh();
  };

  const empty = async () => {
    if (!confirm('¿Vaciar toda la papelera? No se puede deshacer.')) return;
    await api.emptyTrash();
    refresh();
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="trash-modal" onClick={(e) => e.stopPropagation()}>
        <div className="trash-header">
          <span>🗑 Papelera</span>
          <div>
            {items?.length > 0 && (
              <button className="btn danger" onClick={empty}>
                Vaciar papelera
              </button>
            )}
            <button className="btn" onClick={onClose} style={{ marginLeft: 8 }}>
              Cerrar
            </button>
          </div>
        </div>
        <div className="trash-note">Las páginas se eliminan definitivamente tras 30 días en la papelera.</div>
        <div className="trash-list">
          {items === null && <div className="history-empty">Cargando…</div>}
          {items?.length === 0 && <div className="history-empty">La papelera está vacía.</div>}
          {items?.map((it) => (
            <div key={it.id} className="trash-item">
              <span className="trash-icon">{it.icon || '📄'}</span>
              <span className="trash-title">
                {it.title || 'Sin título'}
                {it.children > 0 && <span className="trash-children"> · {it.children} subpágina(s)</span>}
              </span>
              <button className="btn" onClick={() => restore(it.id)}>
                Restaurar
              </button>
              <button className="btn danger" onClick={() => removeForever(it.id)}>
                Eliminar
              </button>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
