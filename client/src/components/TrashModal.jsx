import { useEffect, useState } from 'react';
import { api, humanSize } from '../api.js';

export default function TrashModal({ onClose, onChanged }) {
  const [items, setItems] = useState(null);
  const [files, setFiles] = useState(null);

  const refresh = () => {
    api.trash().then(setItems);
    api.trashFiles().then(setFiles);
  };

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

  const restoreFile = async (id) => {
    await api.restoreTrashFile(id);
    refresh();
  };

  const removeFileForever = async (f) => {
    if (!confirm(`¿Eliminar definitivamente "${f.name}"? No se puede deshacer.`)) return;
    await api.deleteTrashFile(f.id);
    refresh();
  };

  const empty = async () => {
    if (!confirm('¿Vaciar toda la papelera (páginas y archivos)? No se puede deshacer.')) return;
    await api.emptyTrash();
    refresh();
  };

  const nothing = items?.length === 0 && files?.length === 0;

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="trash-modal" onClick={(e) => e.stopPropagation()}>
        <div className="trash-header">
          <span>🗑 Papelera</span>
          <div>
            {!nothing && items && files && (
              <button className="btn danger" onClick={empty}>
                Vaciar papelera
              </button>
            )}
            <button className="btn" onClick={onClose} style={{ marginLeft: 8 }}>
              Cerrar
            </button>
          </div>
        </div>
        <div className="trash-note">Las páginas y archivos se eliminan definitivamente tras 30 días en la papelera.</div>
        <div className="trash-list">
          {(items === null || files === null) && <div className="history-empty">Cargando…</div>}
          {nothing && <div className="history-empty">La papelera está vacía.</div>}
          {items?.length > 0 && <div className="trash-section">Páginas</div>}
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
          {files?.length > 0 && <div className="trash-section">Archivos adjuntos</div>}
          {files?.map((f) => (
            <div key={f.id} className="trash-item">
              <span className="trash-icon">📎</span>
              <span className="trash-title">
                {f.name}
                <span className="trash-children">
                  {' '}
                  · {humanSize(f.size)}
                  {f.page_title !== null && f.page_title !== undefined && ` · en ${f.page_icon || '📄'} ${f.page_title || 'Sin título'}`}
                </span>
              </span>
              <button className="btn" onClick={() => restoreFile(f.id)}>
                Restaurar
              </button>
              <button className="btn danger" onClick={() => removeFileForever(f)}>
                Eliminar
              </button>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
