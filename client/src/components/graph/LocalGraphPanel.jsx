import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Maximize2, X } from 'lucide-react';
import { api } from '../../api.js';
import GraphView, { readGraphSettings, saveGraphSettings } from './GraphView.jsx';

// Grafo local de la página abierta (como "Open local graph" de Obsidian)
const KEY = 'nn:graph:local';

export default function LocalGraphPanel({ pageId, pages, onClose }) {
  const navigate = useNavigate();
  const [data, setData] = useState(null);
  const [settings, setSettings] = useState(() => readGraphSettings(KEY));

  // se recarga cuando cambia el árbol (títulos, páginas nuevas o enlaces)
  useEffect(() => {
    let cancelled = false;
    api
      .graph()
      .then((d) => !cancelled && setData(d))
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [pages, pageId]);

  const update = (s) => {
    setSettings(s);
    saveGraphSettings(KEY, s);
  };

  return (
    <div className="local-graph">
      <div className="local-graph-head">
        <span>Grafo local</span>
        <label className="local-graph-depth" title="Profundidad">
          <input
            type="range"
            min={1}
            max={5}
            step={1}
            value={settings.depth}
            onChange={(e) => update({ ...settings, depth: Number(e.target.value) })}
          />
          {settings.depth}
        </label>
        <button className="icon-btn" title="Abrir en grande" onClick={() => navigate(`/graph?focus=${pageId}`)}>
          <Maximize2 size={14} />
        </button>
        <button className="icon-btn" title="Cerrar" onClick={onClose}>
          <X size={14} />
        </button>
      </div>
      <GraphView
        data={data}
        settings={settings}
        onSettings={update}
        focusId={pageId}
        compact
        onOpen={(id, newTab, mode) => {
          if (mode === 'local') navigate(`/graph?focus=${id}`);
          else if (newTab) window.open(`/p/${id}`, '_blank', 'noopener');
          else navigate(`/p/${id}`);
        }}
      />
    </div>
  );
}
