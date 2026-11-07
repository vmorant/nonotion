import { useCallback, useEffect, useState } from 'react';
import { api } from '../api.js';

// Ajustes de un espacio: nombre e icono, miembros (cuentas de GitHub con su
// rol) y conectores de Claude (un token por persona y espacio).

const ROLE_LABEL = { admin: 'Administrador', editor: 'Editor' };

function Section({ title, children, hint }) {
  return (
    <section className="ws-section">
      <h3>{title}</h3>
      {hint && <p className="ws-hint">{hint}</p>}
      {children}
    </section>
  );
}

export default function WorkspaceSettings({ workspace, owner, me, onChanged, onDeleted, onClose }) {
  const isAdmin = workspace?.role === 'admin';
  const [name, setName] = useState(workspace?.name || '');
  const [icon, setIcon] = useState(workspace?.icon || '🗂️');
  const [prefix, setPrefix] = useState(workspace?.issue_prefix || '');
  const [members, setMembers] = useState({ owners: [], members: [] });
  const [tokens, setTokens] = useState([]);
  const [newLogin, setNewLogin] = useState('');
  const [newRole, setNewRole] = useState('editor');
  const [error, setError] = useState(null);
  const [copied, setCopied] = useState(null);
  const [fresh, setFresh] = useState(null); // token recién creado (se resalta)

  const load = useCallback(async () => {
    if (!workspace) return;
    try {
      const [m, t] = await Promise.all([api.members(workspace.id), api.tokens(workspace.id)]);
      setMembers(m);
      setTokens(t);
    } catch (e) {
      setError(e.message);
    }
  }, [workspace]);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    const onKey = (e) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  if (!workspace) return null;

  const run = async (fn) => {
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(e.message);
    }
  };

  const copy = (text, key) => {
    navigator.clipboard.writeText(text);
    setCopied(key);
    setTimeout(() => setCopied(null), 1500);
  };

  const connectorUrl = (token) => `${location.origin}/mcp/${token}`;
  const myLogin = me?.user?.login?.toLowerCase();

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="ws-modal" onClick={(e) => e.stopPropagation()}>
        <div className="ws-modal-head">
          <h2>
            {workspace.icon} {workspace.name}
          </h2>
          <button className="icon-btn" onClick={onClose} title="Cerrar">
            ✕
          </button>
        </div>
        {error && <div className="ws-error">⚠ {error}</div>}

        <Section title="General">
          <form
            className="ws-row"
            onSubmit={(e) => {
              e.preventDefault();
              run(async () => {
                await api.updateWorkspace(workspace.id, { name, icon, ...(prefix && prefix !== workspace.issue_prefix ? { issue_prefix: prefix } : {}) });
                await onChanged();
              });
            }}
          >
            <input className="ws-icon-input" value={icon} onChange={(e) => setIcon(e.target.value)} disabled={!isAdmin} maxLength={8} />
            <input className="ws-input" value={name} onChange={(e) => setName(e.target.value)} disabled={!isAdmin} maxLength={60} />
            {isAdmin && <button className="btn primary">Guardar</button>}
          </form>
          <label className="ws-prefix">
            <span>Prefijo de seguimiento</span>
            <input
              className="ws-input ws-prefix-input"
              value={prefix}
              placeholder="AXA"
              maxLength={10}
              disabled={!isAdmin}
              onChange={(e) => setPrefix(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ''))}
            />
            <span className="ws-hint">Claves de los elementos: {prefix || 'AXA'}-12. Si lo cambias, las menciones con el prefijo antiguo dejan de enlazarse.</span>
          </label>
        </Section>

        <Section
          title="Miembros"
          hint={`Cada persona entra con "Entrar con GitHub" en ${location.origin} y solo ve los espacios donde está. Los editores leen y escriben; los administradores además gestionan miembros.`}
        >
          {members.owners.length > 0 && (
            <div className="ws-owners">
              Propietarios de la instancia (acceso a todos los espacios): {members.owners.map((o) => `@${o}`).join(', ')}
            </div>
          )}
          <ul className="ws-members">
            {members.members.map((m) => (
              <li key={m.github_login}>
                <img src={`https://github.com/${encodeURIComponent(m.github_login)}.png?size=40`} alt="" className="ws-avatar" />
                <span className="ws-login">@{m.github_login}</span>
                {isAdmin ? (
                  <>
                    <select
                      value={m.role}
                      onChange={(e) => run(async () => (await api.setMember(workspace.id, m.github_login, e.target.value), load()))}
                    >
                      <option value="editor">{ROLE_LABEL.editor}</option>
                      <option value="admin">{ROLE_LABEL.admin}</option>
                    </select>
                    <button
                      className="icon-btn"
                      title="Quitar del espacio (pierde el acceso y sus conectores)"
                      onClick={() =>
                        confirm(`¿Quitar a @${m.github_login} de "${workspace.name}"?`) &&
                        run(async () => (await api.removeMember(workspace.id, m.github_login), load()))
                      }
                    >
                      ✕
                    </button>
                  </>
                ) : (
                  <span className="ws-role">{ROLE_LABEL[m.role] || m.role}</span>
                )}
              </li>
            ))}
            {!members.members.length && <li className="ws-hint">Nadie más todavía.</li>}
          </ul>
          {isAdmin && (
            <form
              className="ws-row"
              onSubmit={(e) => {
                e.preventDefault();
                const login = newLogin.trim().replace(/^@/, '');
                if (!login) return;
                run(async () => {
                  await api.setMember(workspace.id, login, newRole);
                  setNewLogin('');
                  await load();
                });
              }}
            >
              <input
                className="ws-input"
                placeholder="usuario de GitHub"
                value={newLogin}
                onChange={(e) => setNewLogin(e.target.value)}
              />
              <select value={newRole} onChange={(e) => setNewRole(e.target.value)}>
                <option value="editor">{ROLE_LABEL.editor}</option>
                <option value="admin">{ROLE_LABEL.admin}</option>
              </select>
              <button className="btn primary">Añadir</button>
            </form>
          )}
        </Section>

        <Section
          title="Conector de Claude"
          hint='Cada conector da acceso solo a este espacio. En claude.ai: Ajustes → Conectores → "Add custom connector" y pega la URL. Trátala como una contraseña.'
        >
          <ul className="ws-tokens">
            {tokens.map((t) => (
              <li key={t.id + t.owner} className={fresh && t.token === fresh ? 'fresh' : ''}>
                <div className="ws-token-main">
                  <span className="ws-token-label">
                    {t.label || 'Conector'} {!t.mine && <span className="ws-hint">· de @{t.owner}</span>}
                  </span>
                  {t.token ? (
                    <code className="ws-token-url">{connectorUrl(t.token)}</code>
                  ) : (
                    <code className="ws-token-url">{location.origin}/mcp/{t.id}••••••</code>
                  )}
                  <span className="ws-hint">
                    Creado {t.created_at?.slice(0, 10)} · {t.last_used_at ? `usado ${t.last_used_at.slice(0, 16)}` : 'sin usar'}
                  </span>
                </div>
                {t.token && (
                  <button className="btn" onClick={() => copy(connectorUrl(t.token), t.id)}>
                    {copied === t.id ? '✓ Copiada' : 'Copiar URL'}
                  </button>
                )}
                <button
                  className="btn danger"
                  title="Revocar: deja de funcionar al momento"
                  onClick={() =>
                    confirm('¿Revocar este conector? Claude dejará de poder usarlo.') &&
                    run(async () => (await api.revokeToken(workspace.id, t.id), load()))
                  }
                >
                  Revocar
                </button>
              </li>
            ))}
            {!tokens.length && <li className="ws-hint">Todavía no tienes conector para este espacio.</li>}
          </ul>
          <button
            className="btn primary"
            onClick={() =>
              run(async () => {
                const { token } = await api.createToken(workspace.id, `Claude de @${myLogin || 'local'}`);
                setFresh(token);
                await load();
              })
            }
          >
            + Crear conector
          </button>
        </Section>

        {owner && (
          <Section title="Zona peligrosa" hint="Solo se puede borrar un espacio vacío (sin páginas, ni en la papelera).">
            <button
              className="btn danger"
              onClick={() =>
                confirm(`¿Borrar el espacio "${workspace.name}"?`) &&
                run(async () => {
                  await api.deleteWorkspace(workspace.id);
                  await onDeleted();
                })
              }
            >
              Borrar espacio
            </button>
          </Section>
        )}
      </div>
    </div>
  );
}
