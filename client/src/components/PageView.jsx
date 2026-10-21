import { useCallback, useEffect, useRef, useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import { api, parseContent, markBusy, clearBusy } from '../api.js';
import Editor from './Editor.jsx';
import Attachments from './Attachments.jsx';
import EmojiPicker from './EmojiPicker.jsx';
import HistoryModal from './HistoryModal.jsx';
import PageOutline from './PageOutline.jsx';
import { TagEditor } from './Tags.jsx';

function breadcrumb(pages, id) {
  const byId = new Map(pages.map((p) => [p.id, p]));
  const chain = [];
  let cur = byId.get(id);
  while (cur) {
    chain.unshift(cur);
    cur = cur.parent_id ? byId.get(cur.parent_id) : null;
  }
  return chain;
}

// ---------- Borrador local ----------
// Todo cambio no confirmado por el servidor se guarda también en el navegador.
// Si se cae la red, se cierra la pestaña o caduca la sesión, al volver a abrir
// la página se ofrece recuperarlo.
const draftKey = (pid) => `nn:draft:${pid}`;
function readDraft(pid) {
  try {
    return JSON.parse(localStorage.getItem(draftKey(pid)) || 'null');
  } catch {
    return null;
  }
}
function writeDraft(pid, fields, baseRev) {
  try {
    localStorage.setItem(draftKey(pid), JSON.stringify({ fields, base_rev: baseRev, ts: Date.now() }));
  } catch {}
}
function removeDraft(pid) {
  try {
    localStorage.removeItem(draftKey(pid));
  } catch {}
}

// ¿El borrador contiene algo distinto de lo que hay en el servidor?
function draftDiffers(draft, page) {
  const f = draft?.fields || {};
  if (f.content !== undefined && JSON.stringify(f.content) !== page.content) return true;
  if (f.title !== undefined && f.title !== page.title) return true;
  if (f.icon !== undefined && f.icon !== page.icon) return true;
  if (f.page_date !== undefined && (f.page_date || null) !== (page.page_date || null)) return true;
  return false;
}

export default function PageView({ pages, pageEvent, onTreeChange, onDelete, onCreateChild, onDuplicate, onFavorite, allTags = [] }) {
  const { id } = useParams();
  const [page, setPage] = useState(null);
  const [files, setFiles] = useState([]);
  const [status, setStatus] = useState('saved'); // saved | saving | retrying | error
  const [emojiOpen, setEmojiOpen] = useState(false);
  const [shareOpen, setShareOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [shareToken, setShareToken] = useState(null);
  const [copied, setCopied] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const [remoteChange, setRemoteChange] = useState(false); // aviso de cambio remoto mientras editas
  const [conflictSaved, setConflictSaved] = useState(false); // la versión ajena quedó en el historial
  const [draftOffer, setDraftOffer] = useState(null); // borrador local pendiente de recuperar
  const [editor, setEditor] = useState(null);
  const [prefsOverride, setPrefsOverride] = useState({}); // cambio local hasta que llegue el árbol
  const [tagsOverride, setTagsOverride] = useState(null);
  const [backlinks, setBacklinks] = useState([]);
  const editorRef = useRef(null);
  const focusedRef = useRef(false);
  const saveTimer = useRef(null);
  const liveTimer = useRef(null);
  const pending = useRef({}); // cambios aún no enviados
  const unconfirmed = useRef({}); // cambios aún no confirmados por el servidor (= borrador)
  const draftBaseRev = useRef(null); // revisión sobre la que se empezó el borrador
  const revRef = useRef(0); // última revisión del servidor conocida por esta pestaña
  const inFlight = useRef(false);
  const again = useRef(false);
  const retries = useRef(0);
  const gen = useRef(0); // cambia al cambiar de página: invalida guardados en vuelo

  const persistDraft = useCallback((pid) => {
    if (Object.keys(unconfirmed.current).length) {
      writeDraft(pid, unconfirmed.current, draftBaseRev.current);
      markBusy(`page:${pid}`);
    } else {
      removeDraft(pid);
      clearBusy(`page:${pid}`);
      draftBaseRev.current = null;
    }
  }, []);

  const loadPage = useCallback(() => {
    return api.page(id).then((p) => {
      revRef.current = p.rev ?? 0;
      setPage(p);
      setFiles(p.files || []);
      setShareToken(p.share_token);
      const draft = readDraft(id);
      if (draft && draftDiffers(draft, p)) setDraftOffer(draft);
      else if (draft) removeDraft(id);
    });
  }, [id]);

  const flush = useCallback(async () => {
    if (inFlight.current) {
      again.current = true; // al terminar el guardado en curso se vuelve a lanzar
      return;
    }
    const data = pending.current;
    if (Object.keys(data).length === 0) return;
    pending.current = {};
    inFlight.current = true;
    const myGen = gen.current;
    setStatus('saving');
    try {
      const res = await api.updatePage(id, { ...data, base_rev: revRef.current });
      if (myGen !== gen.current) return; // ya estamos en otra página
      revRef.current = res.rev;
      if (res.conflict) setConflictSaved(true);
      // Solo se confirma lo enviado; lo tecleado mientras tanto sigue pendiente
      for (const k of Object.keys(data)) {
        if (unconfirmed.current[k] === data[k]) delete unconfirmed.current[k];
      }
      persistDraft(id);
      retries.current = 0;
      setStatus(Object.keys(pending.current).length ? 'saving' : 'saved');
      if (data.title !== undefined || data.icon !== undefined) onTreeChange();
    } catch (e) {
      if (myGen !== gen.current) return;
      pending.current = { ...data, ...pending.current }; // se devuelve a la cola sin pisar lo nuevo
      if (e.status === 404) {
        setStatus('error'); // la página ya no existe; el borrador queda en el navegador
        return;
      }
      if (e.status === 401) return; // redirigiendo al login; el borrador sobrevive
      retries.current += 1;
      setStatus('retrying');
      clearTimeout(saveTimer.current);
      saveTimer.current = setTimeout(flush, Math.min(30000, 1000 * 2 ** retries.current));
    } finally {
      if (myGen === gen.current) {
        inFlight.current = false;
        if ((again.current || Object.keys(pending.current).length) && retries.current === 0) {
          again.current = false;
          clearTimeout(saveTimer.current);
          saveTimer.current = setTimeout(flush, 0);
        }
      }
    }
  }, [id, onTreeChange, persistDraft]);

  const queueSave = useCallback(
    (data) => {
      if (!Object.keys(unconfirmed.current).length) draftBaseRev.current = revRef.current;
      pending.current = { ...pending.current, ...data };
      unconfirmed.current = { ...unconfirmed.current, ...data };
      persistDraft(id);
      if (retries.current === 0) setStatus('saving');
      clearTimeout(saveTimer.current);
      saveTimer.current = setTimeout(flush, 700);
    },
    [flush, id, persistDraft]
  );

  // Recarga el contenido desde el servidor y remonta el editor. Si había
  // cambios sin guardar, quedan en el borrador local y se ofrecen al cargar.
  const reloadContent = useCallback(async () => {
    clearTimeout(saveTimer.current);
    pending.current = {};
    unconfirmed.current = {};
    await loadPage();
    setReloadKey((k) => k + 1);
    setRemoteChange(false);
    setStatus('saved');
  }, [loadPage]);

  useEffect(() => {
    gen.current += 1;
    setPage(null);
    setShareOpen(false);
    setEmojiOpen(false);
    setHistoryOpen(false);
    setRemoteChange(false);
    setConflictSaved(false);
    setDraftOffer(null);
    setPrefsOverride({});
    setTagsOverride(null);
    setEditor(null);
    setStatus('saved');
    inFlight.current = false;
    again.current = false;
    retries.current = 0;
    loadPage();
    const pid = id;
    return () => {
      clearTimeout(saveTimer.current);
      clearTimeout(liveTimer.current);
      // Al salir de la página se envía lo que quedara pendiente, sin esperar.
      // Si falla, el borrador local de esta página lo conserva.
      const leftover = { ...unconfirmed.current };
      if (Object.keys(leftover).length) {
        api
          .updatePage(pid, { ...leftover, base_rev: revRef.current })
          .then(() => {
            removeDraft(pid);
            clearBusy(`page:${pid}`);
          })
          .catch(() => {});
      }
      pending.current = {};
      unconfirmed.current = {};
      draftBaseRev.current = null;
    };
  }, [id, loadPage]);

  // Páginas que enlazan a esta (se refresca cuando cambia el árbol)
  useEffect(() => {
    let cancelled = false;
    api
      .backlinks(id)
      .then((r) => !cancelled && setBacklinks(r))
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [id, pages]);

  // Si la pestaña pasa a segundo plano (cambio de app, bloqueo del móvil),
  // se guarda ya en vez de esperar al temporizador
  useEffect(() => {
    const onHide = () => {
      if (document.visibilityState === 'hidden' && Object.keys(pending.current).length) {
        clearTimeout(saveTimer.current);
        flush();
      }
    };
    const onOnline = () => {
      if (Object.keys(pending.current).length) {
        retries.current = 0;
        clearTimeout(saveTimer.current);
        flush();
      }
    };
    document.addEventListener('visibilitychange', onHide);
    window.addEventListener('online', onOnline);
    return () => {
      document.removeEventListener('visibilitychange', onHide);
      window.removeEventListener('online', onOnline);
    };
  }, [flush]);

  // Sincronización en vivo: alguien (o el MCP) cambió esta página
  useEffect(() => {
    if (!pageEvent || pageEvent.id !== id) return;
    const busy = () =>
      focusedRef.current || inFlight.current || Object.keys(unconfirmed.current).length > 0;
    if (busy()) {
      setRemoteChange(true); // estás escribiendo: no te pisamos, te avisamos
    } else {
      clearTimeout(liveTimer.current);
      liveTimer.current = setTimeout(() => {
        if (!busy()) reloadContent();
      }, 600);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pageEvent]);

  const restoreDraft = () => {
    const d = draftOffer;
    setDraftOffer(null);
    const f = d.fields || {};
    setPage((p) => ({
      ...p,
      ...(f.title !== undefined ? { title: f.title } : {}),
      ...(f.icon !== undefined ? { icon: f.icon } : {}),
      ...(f.page_date !== undefined ? { page_date: f.page_date } : {}),
      ...(f.content !== undefined ? { content: JSON.stringify(f.content) } : {}),
    }));
    setReloadKey((k) => k + 1);
    // Base del borrador: si la página cambió desde entonces, el servidor guarda
    // antes la versión actual en el historial (nada se pisa sin copia)
    revRef.current = typeof d.base_rev === 'number' ? d.base_rev : revRef.current;
    queueSave(f);
  };

  const discardDraft = () => {
    removeDraft(id);
    clearBusy(`page:${id}`);
    setDraftOffer(null);
  };

  if (!page) return <div className="page-loading">Cargando…</div>;

  const crumbs = breadcrumb(pages, id);
  const meta = pages.find((p) => p.id === id) || page;
  const fullWidth = prefsOverride.full_width ?? !!meta.full_width;
  const favorite = prefsOverride.favorite ?? !!meta.favorite_at;
  const pageTags = tagsOverride ?? meta.tags ?? page.tags ?? [];

  const changeTags = async (list) => {
    setTagsOverride(list);
    try {
      await api.setPageTags(id, list);
      await onTreeChange();
    } finally {
      setTagsOverride(null);
    }
  };

  const setPref = async (key, value) => {
    setPrefsOverride((o) => ({ ...o, [key]: value }));
    try {
      if (key === 'favorite') await onFavorite(id, value);
      else {
        await api.pagePrefs(id, { [key]: value });
        await onTreeChange();
      }
    } finally {
      setPrefsOverride((o) => {
        const { [key]: _, ...rest } = o;
        return rest;
      });
    }
  };

  const toggleShare = async () => {
    if (shareToken) {
      await api.unshare(id);
      setShareToken(null);
    } else {
      const { token } = await api.share(id);
      setShareToken(token);
    }
    onTreeChange();
  };

  const copyShareLink = () => {
    navigator.clipboard.writeText(`${location.origin}/share/${shareToken}`);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  const exportMarkdown = () => {
    const md = editorRef.current?.storage?.markdown?.getMarkdown() || '';
    const blob = new Blob([`# ${page.title || 'Sin título'}\n\n${md}`], {
      type: 'text/markdown;charset=utf-8',
    });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${page.title || 'pagina'}.md`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  const onVersionRestored = async () => {
    setHistoryOpen(false);
    await reloadContent();
    onTreeChange();
  };

  return (
    <div className="page">
      {draftOffer && (
        <div className="remote-banner draft-banner">
          <span>
            💾 Hay cambios de esta página que no llegaron a guardarse (
            {new Date(draftOffer.ts).toLocaleString()}). ¿Los recuperas?
          </span>
          <button className="btn primary" onClick={restoreDraft}>
            Recuperar
          </button>
          <button className="btn" onClick={discardDraft}>
            Descartar
          </button>
        </div>
      )}
      {conflictSaved && (
        <div className="remote-banner">
          <span>
            🛟 Otro dispositivo (o Claude) había cambiado esta página. Su versión se ha guardado en el historial antes
            de guardar la tuya: no se ha perdido nada.
          </span>
          <button
            className="btn"
            onClick={() => {
              setConflictSaved(false);
              setHistoryOpen(true);
            }}
          >
            Ver historial
          </button>
          <button className="btn" onClick={() => setConflictSaved(false)}>
            Entendido
          </button>
        </div>
      )}
      {remoteChange && (
        <div className="remote-banner">
          <span>🔄 Esta página ha cambiado en otro sitio mientras editabas.</span>
          <button className="btn" onClick={reloadContent}>
            Recargar
          </button>
          <button className="btn" onClick={() => setRemoteChange(false)}>
            Seguir editando
          </button>
        </div>
      )}
      <div className="page-topbar">
        <nav className="breadcrumbs">
          {crumbs.map((c, i) => (
            <span key={c.id}>
              {i > 0 && <span className="crumb-sep">/</span>}
              <Link to={`/p/${c.id}`}>
                {c.icon ? c.icon + ' ' : ''}
                {c.title || 'Sin título'}
              </Link>
            </span>
          ))}
        </nav>
        <div className="topbar-actions">
          <span className={`save-status ${status}`}>
            {status === 'saving'
              ? 'Guardando…'
              : status === 'retrying'
                ? '⚠ Sin conexión: reintentando (guardado en este navegador)'
                : status === 'error'
                  ? '⚠ No se pudo guardar (copia en este navegador)'
                  : 'Guardado'}
          </span>
          <input
            type="date"
            className={'page-date' + (page.page_date ? ' set' : '')}
            value={page.page_date || ''}
            title="Fecha asignada: la página aparece fijada ese día en el calendario"
            onChange={(e) => {
              const v = e.target.value || null;
              setPage({ ...page, page_date: v });
              queueSave({ page_date: v });
            }}
          />
          <button
            className={'btn' + (favorite ? ' favorite' : '')}
            onClick={() => setPref('favorite', !favorite)}
            title={favorite ? 'Quitar de favoritas' : 'Añadir a favoritas (aparece arriba en la barra lateral)'}
          >
            {favorite ? '★' : '☆'}
          </button>
          <button
            className={'btn' + (fullWidth ? ' active' : '')}
            onClick={() => setPref('full_width', !fullWidth)}
            title={fullWidth ? 'Volver al ancho normal' : 'Usar todo el ancho de la pantalla'}
          >
            ↔
          </button>
          <button className="btn" onClick={() => setHistoryOpen(true)} title="Historial de versiones">
            🕘
          </button>
          <button className="btn" onClick={exportMarkdown} title="Exportar como Markdown">
            ⬇ MD
          </button>
          <div className="share-wrap">
            <button className={'btn' + (shareToken ? ' shared' : '')} onClick={() => setShareOpen((v) => !v)}>
              Compartir
            </button>
            {shareOpen && (
              <div className="share-popover">
                <label className="share-toggle">
                  <input type="checkbox" checked={!!shareToken} onChange={toggleShare} />
                  Enlace público activo
                </label>
                {shareToken ? (
                  <>
                    <div className="share-url">{`${location.origin}/share/${shareToken}`}</div>
                    <button className="btn primary" onClick={copyShareLink}>
                      {copied ? '✓ Copiado' : 'Copiar enlace'}
                    </button>
                    <p className="share-note">
                      Cualquiera con el enlace podrá ver esta página y sus adjuntos en solo lectura.
                    </p>
                  </>
                ) : (
                  <p className="share-note">Activa el enlace para compartir esta página en solo lectura.</p>
                )}
              </div>
            )}
          </div>
          <button className="btn" onClick={() => onCreateChild(id)} title="Añadir subpágina">
            + Sub
          </button>
          <button className="btn" onClick={() => onDuplicate(id)} title="Duplicar página">
            ⧉
          </button>
          <button className="btn danger" onClick={() => onDelete(id)} title="Mover a la papelera">
            🗑
          </button>
        </div>
      </div>

      <div className="page-columns">
      <div className={'page-body' + (fullWidth ? ' full' : '')}>
        <div className="page-head">
          <button className="page-icon" onClick={() => setEmojiOpen((v) => !v)} title="Cambiar icono">
            {page.icon || '📄'}
          </button>
          {emojiOpen && (
            <EmojiPicker
              onPick={(emoji) => {
                setPage({ ...page, icon: emoji });
                queueSave({ icon: emoji });
                setEmojiOpen(false);
              }}
              onClose={() => setEmojiOpen(false)}
            />
          )}
          <input
            className="page-title"
            value={page.title}
            placeholder="Sin título"
            onChange={(e) => {
              setPage({ ...page, title: e.target.value });
              queueSave({ title: e.target.value });
            }}
          />
        </div>

        <TagEditor tags={pageTags} allTags={allTags} onChange={changeTags} />

        <Editor
          key={`${id}:${reloadKey}`}
          pageId={id}
          pages={pages}
          initialContent={parseContent(page.content)}
          onReady={(ed) => {
            editorRef.current = ed;
            setEditor(ed);
          }}
          onChange={({ json, text }) => queueSave({ content: json, content_text: text })}
          onFocusChange={(f) => (focusedRef.current = f)}
          onFileUploaded={(f) => setFiles((prev) => [...prev, f])}
        />

        <Attachments pageId={id} files={files} onChange={setFiles} />

        {backlinks.length > 0 && (
          <section className="backlinks">
            <div className="backlinks-title">↩ Enlazada desde</div>
            {backlinks.map((b) => (
              <Link key={b.id} to={`/p/${b.id}`} className="backlink">
                {b.icon || '📄'} {b.title || 'Sin título'}
              </Link>
            ))}
          </section>
        )}
      </div>
      <PageOutline editor={editor} />
      </div>

      {historyOpen && <HistoryModal pageId={id} onClose={() => setHistoryOpen(false)} onRestored={onVersionRestored} />}
    </div>
  );
}
