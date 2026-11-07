import { useEffect, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { api } from '../../api.js';
import GraphView, { readGraphSettings, saveGraphSettings } from './GraphView.jsx';

// Vista de grafo a pantalla completa: global, o local si llega ?focus=<id>
export default function GraphPage({ pages }) {
  const [params] = useSearchParams();
  const focus = params.get('focus');
  const key = focus ? 'nn:graph:local' : 'nn:graph:global';
  const navigate = useNavigate();
  const [data, setData] = useState(null);
  const [settings, setSettings] = useState(() => readGraphSettings(key));

  useEffect(() => setSettings(readGraphSettings(key)), [key]);
  useEffect(() => {
    let cancelled = false;
    api
      .graph()
      .then((d) => !cancelled && setData(d))
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [pages]);

  const update = (s) => {
    setSettings(s);
    saveGraphSettings(key, s);
  };
  const focusPage = focus && pages.find((p) => p.id === focus);

  return (
    <div className="graph-page">
      <div className="graph-page-head">
        <h2>{focus ? `Grafo local · ${focusPage?.title || 'Sin título'}` : 'Grafo'}</h2>
        {focus && (
          <>
            <Link to={`/p/${focus}`}>Abrir la página</Link>
            <Link to="/graph">Ver grafo global</Link>
          </>
        )}
      </div>
      <GraphView
        data={data}
        settings={settings}
        onSettings={update}
        focusId={focus || null}
        onOpen={(id, newTab, mode) => {
          if (mode === 'local') navigate(`/graph?focus=${id}`);
          else if (newTab) window.open(`/p/${id}`, '_blank', 'noopener');
          else navigate(`/p/${id}`);
        }}
      />
    </div>
  );
}
