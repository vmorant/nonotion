import { useEffect, useRef, useState } from 'react';
import { api, humanSize } from '../api.js';

const PRESETS = {
  audio: {
    label: '🎙 Solo audio',
    desc: 'Opus 48 kbps · ~20 MB/h',
    kind: 'audio',
    audioBits: 48000,
  },
  light: {
    label: '📺 Ligero',
    desc: '720p · 5 fps · ~90 MB/h',
    kind: 'video',
    fps: 5,
    videoBits: 220000,
    audioBits: 48000,
  },
  sharp: {
    label: '🎬 Nítido',
    desc: '720p · 15 fps · ~200 MB/h',
    kind: 'video',
    fps: 15,
    videoBits: 450000,
    audioBits: 64000,
  },
};

function pickMime(kind) {
  const candidates =
    kind === 'audio'
      ? ['audio/webm;codecs=opus', 'audio/webm']
      : ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm'];
  return candidates.find((m) => window.MediaRecorder && MediaRecorder.isTypeSupported(m));
}

export default function Recorder({ pageId, pageTitle, onSaved }) {
  const [phase, setPhase] = useState('idle'); // idle | setup | recording | saving
  const [preset, setPreset] = useState('audio');
  const [withMic, setWithMic] = useState(true);
  const [elapsed, setElapsed] = useState(0);
  const [bytes, setBytes] = useState(0);
  const [noSysAudio, setNoSysAudio] = useState(false);
  const [error, setError] = useState(null);

  const session = useRef(null); // { id, recorder, streams, audioCtx, chain, kind }
  const timerRef = useRef(null);

  useEffect(() => {
    const warn = (e) => {
      if (session.current) {
        e.preventDefault();
        e.returnValue = '';
      }
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, []);

  // Si se navega a otra página de la app con una grabación en curso, se detiene
  // y se guarda (nunca se descarta en silencio)
  useEffect(() => () => {
    if (session.current) stop();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const cleanup = (s) => {
    clearInterval(timerRef.current);
    s?.streams.forEach((st) => st.getTracks().forEach((t) => t.stop()));
    s?.audioCtx?.close().catch(() => {});
    session.current = null;
    setElapsed(0);
    setBytes(0);
    setNoSysAudio(false);
  };

  const start = async () => {
    setError(null);
    const cfg = PRESETS[preset];
    let display, micStream;
    try {
      // Incluso en solo-audio se pide pantalla: es la única vía al audio del sistema
      display = await navigator.mediaDevices.getDisplayMedia({
        video: cfg.kind === 'video' ? { frameRate: cfg.fps, height: { ideal: 720 } } : true,
        audio: true,
      });
    } catch {
      return; // usuario canceló el selector
    }
    try {
      if (withMic) micStream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true } });
    } catch {
      micStream = null;
    }

    const sysAudio = display.getAudioTracks()[0] || null;
    const micAudio = micStream?.getAudioTracks()[0] || null;
    setNoSysAudio(!sysAudio);
    if (!sysAudio && !micAudio) {
      display.getTracks().forEach((t) => t.stop());
      setError('Sin ninguna pista de audio. Comparte pantalla completa con "Compartir audio del sistema" o activa el micrófono.');
      return;
    }

    // Mezcla audio del sistema + micrófono
    let audioTrack = sysAudio || micAudio;
    let audioCtx = null;
    if (sysAudio && micAudio) {
      audioCtx = new AudioContext();
      const dest = audioCtx.createMediaStreamDestination();
      audioCtx.createMediaStreamSource(new MediaStream([sysAudio])).connect(dest);
      audioCtx.createMediaStreamSource(new MediaStream([micAudio])).connect(dest);
      audioTrack = dest.stream.getAudioTracks()[0];
    }

    const tracks = [...(cfg.kind === 'video' ? display.getVideoTracks() : []), audioTrack];
    const mimeType = pickMime(cfg.kind);
    if (!mimeType) {
      display.getTracks().forEach((t) => t.stop());
      micStream?.getTracks().forEach((t) => t.stop());
      setError('Este navegador no soporta MediaRecorder con WebM (usa Chrome o Edge).');
      return;
    }

    let id;
    try {
      ({ id } = await api.startRecording(pageId));
    } catch (e) {
      display.getTracks().forEach((t) => t.stop());
      micStream?.getTracks().forEach((t) => t.stop());
      setError(e.message);
      return;
    }

    const recorder = new MediaRecorder(new MediaStream(tracks), {
      mimeType,
      videoBitsPerSecond: cfg.videoBits,
      audioBitsPerSecond: cfg.audioBits,
    });

    const s = {
      id,
      recorder,
      streams: [display, micStream].filter(Boolean),
      audioCtx,
      chain: Promise.resolve(),
      kind: cfg.kind,
    };
    session.current = s;

    recorder.ondataavailable = (e) => {
      if (!e.data?.size) return;
      // Subida secuencial: el orden de los chunks es parte del contenedor WebM
      s.chain = s.chain
        .then(() => api.uploadChunk(s.id, e.data))
        .then((r) => setBytes(r.bytes))
        .catch(() => {});
    };

    // Si el usuario corta la compartición desde la barra del navegador
    display.getVideoTracks()[0]?.addEventListener('ended', () => stop());

    recorder.start(5000);
    const t0 = Date.now();
    timerRef.current = setInterval(() => setElapsed(Math.floor((Date.now() - t0) / 1000)), 1000);
    setPhase('recording');
  };

  const stop = async () => {
    const s = session.current;
    if (!s || s.stopping) return;
    s.stopping = true;
    setPhase('saving');
    await new Promise((resolve) => {
      s.recorder.addEventListener('stop', resolve, { once: true });
      if (s.recorder.state !== 'inactive') s.recorder.stop();
      else resolve();
    });
    await s.chain; // espera a que suba el último chunk
    try {
      const file = await api.finishRecording(s.id, {
        page_id: pageId,
        kind: s.kind,
        name: `${s.kind === 'audio' ? '🎙' : '🎥'} ${pageTitle || 'Reunión'}`,
      });
      onSaved?.(file, s.kind);
    } catch (e) {
      setError(`No se pudo guardar la grabación: ${e.message}`);
    }
    cleanup(s);
    setPhase('idle');
  };

  const cancel = async (silent = false) => {
    const s = session.current;
    if (!s) return;
    if (!silent && !confirm('¿Descartar la grabación en curso?')) return;
    if (s.recorder.state !== 'inactive') s.recorder.stop();
    const id = s.id;
    cleanup(s);
    setPhase('idle');
    api.cancelRecording(id).catch(() => {});
  };

  const fmtTime = (sec) =>
    `${String(Math.floor(sec / 3600)).padStart(2, '0')}:${String(Math.floor((sec % 3600) / 60)).padStart(2, '0')}:${String(sec % 60).padStart(2, '0')}`;

  const rate = elapsed > 30 ? (bytes / 1048576) / (elapsed / 3600) : null;

  return (
    <>
      <button className="btn" title="Grabar reunión (pantalla + audio)" onClick={() => setPhase('setup')}>
        ⏺ Grabar
      </button>

      {phase === 'setup' && (
        <div className="modal-backdrop" onClick={() => setPhase('idle')}>
          <div className="recorder-modal" onClick={(e) => e.stopPropagation()}>
            <h3>⏺ Grabar reunión</h3>
            <div className="recorder-presets">
              {Object.entries(PRESETS).map(([key, p]) => (
                <label key={key} className={'preset-card' + (preset === key ? ' selected' : '')}>
                  <input type="radio" name="preset" checked={preset === key} onChange={() => setPreset(key)} />
                  <span className="preset-label">{p.label}</span>
                  <span className="preset-desc">{p.desc}</span>
                </label>
              ))}
            </div>
            <label className="recorder-mic">
              <input type="checkbox" checked={withMic} onChange={(e) => setWithMic(e.target.checked)} />
              Incluir mi micrófono (tu voz en la reunión)
            </label>
            <p className="recorder-help">
              En el selector del navegador elige <b>Pantalla completa</b> y marca{' '}
              <b>"Compartir también el audio del sistema"</b>: así se captura la app de escritorio de
              Teams. Compartir una ventana suelta no incluye audio.
            </p>
            {error && <p className="recorder-error">⚠ {error}</p>}
            <div className="recorder-actions">
              <button className="btn" onClick={() => setPhase('idle')}>Cancelar</button>
              <button className="btn primary" onClick={start}>Elegir pantalla y grabar</button>
            </div>
          </div>
        </div>
      )}

      {(phase === 'recording' || phase === 'saving') && (
        <div className="rec-widget">
          <span className="rec-dot" />
          <span className="rec-time">{fmtTime(elapsed)}</span>
          <span className="rec-size">
            {humanSize(bytes)}
            {rate ? ` · ~${Math.round(rate)} MB/h` : ''}
          </span>
          {noSysAudio && <span className="rec-warn" title="Comparte pantalla completa o pestaña para capturar el audio del sistema">⚠ sin audio del sistema</span>}
          {phase === 'saving' ? (
            <span className="rec-size">Guardando…</span>
          ) : (
            <>
              <button className="btn" onClick={stop}>■ Detener</button>
              <button className="icon-btn danger" title="Descartar" onClick={() => cancel()}>✕</button>
            </>
          )}
        </div>
      )}
    </>
  );
}
