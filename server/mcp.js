// MCP remoto de NoNotion (Streamable HTTP, stateless) montado en el propio
// Express en POST /mcp/<token>. El token va en la URL (capability URL) porque
// los conectores de claude.ai/Claude Desktop solo aceptan una URL sin headers.
// Las tools llaman a la API local para reutilizar toda la lógica existente.
import fs from 'fs';
import path from 'path';
import { nanoid } from 'nanoid';
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import db, { DATA_DIR } from './db.js';
import { lookupToken, tokenWorkspaceName } from './workspaces.js';
import { normalizeTag } from './tags.js';
import { markdownToDoc } from './markdown.js';
import { issueHeaderMarkdown, issueRelationsMarkdown, issueTimelineMarkdown } from './issues.js';
import { minutesHeaderMarkdown, minutesItemsMarkdown } from './minutes.js';

const TEXT_LIMIT = 200 * 1024; // 200 KB para adjuntos de texto
const IMAGE_LIMIT = 4 * 1024 * 1024; // 4 MB para imágenes
const TEXT_EXTRACT_LIMIT_LABEL = '600 KB'; // coincide con TEXT_EXTRACT_LIMIT del servidor
const MAX_RENDER_PAGES = 10;

const EXT_MIME = {
  '.md': 'text/markdown', '.txt': 'text/plain', '.json': 'application/json',
  '.js': 'text/javascript', '.ts': 'text/plain', '.py': 'text/x-python',
  '.sh': 'text/x-shellscript', '.yaml': 'text/yaml', '.yml': 'text/yaml',
  '.csv': 'text/csv', '.html': 'text/html', '.css': 'text/css',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml',
  '.pdf': 'application/pdf', '.zip': 'application/zip',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
};

// Cada token da acceso a UN espacio y sirve tanto para el conector MCP (en la
// URL) como de token de API (Authorization: Bearer) para scripts CLI y para las
// llamadas internas del MCP. Este es el token histórico del archivo mcp_token,
// que queda asociado al espacio inicial.
export function getOrCreateToken() {
  const tokenFile = path.join(DATA_DIR, 'mcp_token');
  try {
    const existing = fs.readFileSync(tokenFile, 'utf8').trim();
    if (existing) return existing;
  } catch {}
  const token = nanoid(32);
  fs.writeFileSync(tokenFile, token + '\n', { mode: 0o600 });
  return token;
}

const isTextMime = (m = '') =>
  m.startsWith('text/') || /json|javascript|xml|x-sh|yaml|markdown/.test(m);

// Formatos que son un ZIP por dentro: sin el registro final (EOCD) el archivo
// está cortado y ningún programa lo abre
const ZIP_EXT = new Set(['.zip', '.xlsx', '.xlsm', '.docx', '.pptx', '.odt', '.ods', '.odp', '.jar', '.epub']);

function hasZipEnd(buf) {
  const min = Math.max(0, buf.length - 22 - 65535);
  for (let i = buf.length - 22; i >= min; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50 && i + 22 + buf.readUInt16LE(i + 20) === buf.length) return true;
  }
  return false;
}

// Comprueba que un archivo binario recibido por el MCP está completo. Claude
// envía el binario en base64 dentro de la llamada y, si la respuesta se corta,
// llegaría un archivo truncado que se guardaría roto sin avisar.
export function checkAttachment(filename, content, encoding) {
  const ext = path.extname(filename).toLowerCase();
  const binary = ZIP_EXT.has(ext) || ['.pdf', '.png', '.jpg', '.jpeg', '.xls', '.doc', '.ppt'].includes(ext);
  if (encoding !== 'base64') {
    return binary ? `"${ext}" es un formato binario: envíalo con encoding "base64".` : null;
  }
  const clean = content.replace(/\s+/g, '');
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(clean) || clean.length % 4 === 1) {
    return 'El contenido base64 no es válido o está cortado.';
  }
  const buf = Buffer.from(clean, 'base64');
  if (!buf.length) return 'El archivo está vacío.';
  const cut = 'El archivo llegó incompleto (parece que el base64 se cortó): no se ha guardado. Vuelve a generarlo y envíalo entero; si es muy grande, guarda los datos en la página como tabla o divídelo en varios archivos.';
  if (ZIP_EXT.has(ext) && (buf.readUInt32LE(0) !== 0x04034b50 || !hasZipEnd(buf))) return cut;
  if (ext === '.pdf' && (!buf.subarray(0, 5).equals(Buffer.from('%PDF-')) || !buf.subarray(-2048).includes('%%EOF'))) return cut;
  if (ext === '.png' && !buf.subarray(-12).includes('IEND')) return cut;
  if ((ext === '.jpg' || ext === '.jpeg') && !(buf[buf.length - 2] === 0xff && buf[buf.length - 1] === 0xd9)) return cut;
  return null;
}

export function mountMcp(app, port) {
  const legacyToken = getOrCreateToken();
  const base = `http://127.0.0.1:${port}`;

  // Las herramientas llaman a la API con el token de la conexión: el servidor
  // aplica así el mismo control de espacios que a cualquier otra petición
  async function apiWith(token, p, options = {}) {
    // Los ids que llegan de Claude van dentro de la ruta: nada de "..", "%" ni "\\"
    // que pudiera cambiar a qué recurso se llama
    if (/\.\.|%|\\/.test(p.split('?')[0])) {
      const err = new Error('Identificador no válido');
      err.status = 400;
      throw err;
    }
    const headers = { Authorization: `Bearer ${token}`, ...(options.headers || {}) };
    if (options.body && typeof options.body === 'string') headers['Content-Type'] = 'application/json';
    const res = await fetch(base + p, { ...options, headers });
    if (!res.ok) {
      let msg = `Error HTTP ${res.status}`;
      try {
        msg = (await res.json()).error || msg;
      } catch {}
      const err = new Error(msg);
      err.status = res.status;
      throw err;
    }
    return res;
  }

  const ok = (text) => ({ content: [{ type: 'text', text }] });
  const fail = (err) => ({ content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true });

  function buildServer(token) {
    const api = (p, options) => apiWith(token, p, options);
    const server = new McpServer({ name: 'nonotion', version: '1.0.0' });

    server.registerTool(
      'search_pages',
      {
        title: 'Buscar páginas',
        description:
          'Busca páginas en NoNotion por texto (títulos y contenido) y/o etiquetas. Úsala SIEMPRE antes de crear una página nueva, para comprobar si ya existe una sobre el tema. Con solo tags (query vacío) lista las páginas que tienen todas esas etiquetas.',
        inputSchema: {
          query: z.string().describe('Texto a buscar (puede ser vacío si filtras por etiquetas)'),
          tags: z.array(z.string()).optional().describe('Etiquetas que deben tener todas las páginas devueltas'),
        },
      },
      async ({ query, tags }) => {
        try {
          const qs = `q=${encodeURIComponent(query || '')}${tags?.length ? `&tags=${encodeURIComponent(tags.join(','))}` : ''}`;
          const rows = await (await api(`/api/search?${qs}`)).json();
          if (!rows.length) return ok('Sin resultados.');
          return ok(
            rows
              .map((r) => `- ${r.icon || '📄'} ${r.title || 'Sin título'} (id: ${r.id})${r.tags?.length ? ` [${r.tags.map((t) => '#' + t).join(' ')}]` : ''}${r.snippet ? `\n  …${r.snippet.replace(/<\/?mark>/g, '**')}…` : ''}`)
              .join('\n')
          );
        } catch (e) {
          return fail(e);
        }
      }
    );

    server.registerTool(
      'list_pages',
      {
        title: 'Listar páginas',
        description: 'Devuelve el árbol completo de páginas de NoNotion (id, icono, título, fecha asignada, etiquetas).',
        inputSchema: {},
      },
      async () => {
        try {
          const all = await (await api('/api/pages')).json();
          const ideas = all.filter((p) => p.kind === 'idea');
          const issues = all.filter((p) => p.kind === 'issue');
          const trackersN = all.filter((p) => p.kind === 'tracker').length;
          // las listas sin página no están en el árbol (solo en Seguimiento: list_trackers)
          const minutesN = all.filter((p) => p.kind === 'minutes').length;
          const pages = all.filter((p) => !['idea', 'issue', 'minutes'].includes(p.kind) && !(p.kind === 'tracker' && !p.parent_id));
          const ws = (await (await api('/api/workspaces')).json()).workspaces?.[0];
          let head = ws ? `Espacio: ${ws.icon || ''} ${ws.name} (este conector solo ve este espacio)\n` : '';
          head += ideas.length ? `Ideas en desarrollo (fuera del árbol): ${ideas.length} → list_ideas\n` : '';
          head += trackersN ? `Listas de seguimiento: ${trackersN} (marcadas en el árbol) con ${issues.length} ticket(s) → list_trackers / list_issues\n` : '';
          head += minutesN ? `Actas de reunión: ${minutesN} → list_minutes\n` : '';
          head += '\n';
          if (!pages.length) return ok(head + 'No hay páginas todavía.');
          const children = new Map();
          for (const p of pages) {
            const k = p.parent_id || null;
            if (!children.has(k)) children.set(k, []);
            children.get(k).push(p);
          }
          const lines = [];
          const walk = (parentId, depth) => {
            for (const p of children.get(parentId) || []) {
              lines.push(
                `${'  '.repeat(depth)}- ${p.icon || '📄'} ${p.title || 'Sin título'} (id: ${p.id}${p.kind === 'canvas' ? ', canvas' : p.kind === 'tracker' ? ', lista de seguimiento' : ''}${p.page_date ? `, fecha: ${p.page_date}` : ''})${p.tags?.length ? ` [${p.tags.map((t) => '#' + t).join(' ')}]` : ''}`
              );
              walk(p.id, depth + 1);
            }
          };
          walk(null, 0);
          return ok(head + lines.join('\n'));
        } catch (e) {
          return fail(e);
        }
      }
    );

    server.registerTool(
      'read_page',
      {
        title: 'Leer página',
        description:
          'Lee una página de NoNotion: devuelve su contenido en Markdown y la lista de archivos adjuntos (con file_id para read_attachment). Si la página es un canvas, devuelve un resumen de tarjetas y conexiones y su JSON Canvas (para editarlo con update_canvas). Si es una idea, devuelve su semilla (con el texto OCR de las capturas; mira las imágenes con read_attachment), su desarrollo y sus resultados.',
        inputSchema: { page_id: z.string().describe('Id de la página') },
      },
      async ({ page_id }) => {
        try {
          const p = await (await api(`/api/pages/${page_id}/markdown`)).json();
          let out = `# ${p.icon ? p.icon + ' ' : ''}${p.title || 'Sin título'}\n`;
          out += `(id: ${p.id}${p.page_date ? ` · fecha: ${p.page_date}` : ''} · actualizada: ${p.updated_at}${p.trashed ? ' · EN PAPELERA' : ''})\n`;
          out += p.tags?.length ? `Etiquetas: ${p.tags.map((t) => '#' + t).join(' ')}\n\n` : '\n';
          if (p.kind === 'canvas') out += '(Esta página es un CANVAS: edítala con update_canvas, no con append/edit/update_page)\n\n';
          if (p.kind === 'idea') out += '(Esta página es una IDEA: trabájala con develop_idea y materialize_idea, no con append/edit/update_page)\n\n';
          if (p.kind === 'tracker') out += '(Esta página es una LISTA DE SEGUIMIENTO: crea tickets con create_issue, configúrala con update_tracker)\n\n';
          let minutes = null;
          if (p.kind === 'minutes') {
            minutes = await (await api(`/api/pages/${page_id}/minutes`)).json();
            out += `(Esta página es un ACTA DE REUNIÓN: su texto admite append/edit/update_page; propón lo que salga de ella con propose_from_minutes — la persona lo aprueba en la app)\n${minutesHeaderMarkdown(minutes)}\n\n`;
          }
          let issue = null;
          if (p.kind === 'issue') {
            issue = await (await api(`/api/pages/${page_id}/issue`)).json();
            out +=
              `(Esta página es un TICKET DE SEGUIMIENTO: cambia estado y campos o comenta con update_issue, relaciónalo con link_issue; la descripción es Markdown normal y admite append/edit/update_page)\n\n` +
              issueHeaderMarkdown(issue) +
              '\n\n## Descripción\n\n';
          }
          out += p.markdown || '(página vacía)';
          if (p.kind === 'canvas') out += `\n\n---\nJSON Canvas:\n\`\`\`json\n${JSON.stringify(p.canvas)}\n\`\`\``;
          if (issue) out += `\n\n## Relaciones\n\n${issueRelationsMarkdown(issue)}\n\n## Cronología\n\n${issueTimelineMarkdown(issue)}`;
          if (minutes) out += `\n\n## Propuestas (bandeja de aprobación)\n\n${minutesItemsMarkdown(minutes)}`;
          if (p.files?.length) {
            out +=
              '\n\n---\nAdjuntos:\n' +
              p.files.map((f) => `- ${f.name} (file_id: ${f.id}, ${f.mime || 'desconocido'}, ${f.size} bytes)`).join('\n');
          }
          return ok(out);
        } catch (e) {
          return fail(e);
        }
      }
    );

    server.registerTool(
      'create_page',
      {
        title: 'Crear página',
        description:
          'Crea una página nueva en NoNotion con contenido Markdown. Úsala SOLO cuando el usuario pida explícitamente una página nueva; para añadir contenido a una conversación en curso usa append_to_page. Antes de crear, usa list_pages/search_pages para elegir el padre temático adecuado; usa Inbox solo si no encaja en ninguna sección. Sin parent_id la página va a la página Inbox.',
        inputSchema: {
          markdown: z.string().describe('Contenido en Markdown'),
          title: z.string().optional().describe('Título (si falta, se deriva del primer encabezado)'),
          parent_id: z.string().optional().describe('Id de la página padre'),
          page_date: z.string().optional().describe('Fecha YYYY-MM-DD para fijarla en el calendario (reuniones)'),
          icon: z.string().optional().describe('Emoji como icono'),
          tags: z.array(z.string()).optional().describe('Etiquetas para clasificarla (reutiliza las existentes: list_tags)'),
        },
      },
      async (args) => {
        try {
          const r = await (
            await api('/api/capture', { method: 'POST', body: JSON.stringify(args) })
          ).json();
          return ok(`Página creada: "${r.title}" (id: ${r.id}, ruta: ${r.url})`);
        } catch (e) {
          return fail(e);
        }
      }
    );

    server.registerTool(
      'append_to_page',
      {
        title: 'Añadir a página',
        description:
          'Añade contenido Markdown al final de una página existente, conservando lo que ya hay. Es la forma preferida de ir guardando contenido en la página de trabajo de la conversación.',
        inputSchema: {
          page_id: z.string().describe('Id de la página'),
          markdown: z.string().describe('Contenido Markdown a añadir al final'),
        },
      },
      async ({ page_id, markdown }) => {
        try {
          await api(`/api/pages/${page_id}/append`, { method: 'POST', body: JSON.stringify({ markdown }) });
          return ok(`Contenido añadido a la página ${page_id}.`);
        } catch (e) {
          return fail(e);
        }
      }
    );

    server.registerTool(
      'edit_page',
      {
        title: 'Editar fragmento',
        description:
          'Modifica un fragmento concreto de una página: busca un texto exacto en su Markdown y lo sustituye. Falla si el texto no aparece o aparece más de una vez (incluye más contexto en find_text para hacerlo único). Para reescrituras completas usa update_page.',
        inputSchema: {
          page_id: z.string().describe('Id de la página'),
          find_text: z.string().describe('Texto exacto a localizar (único en la página)'),
          replace_text: z.string().describe('Texto de sustitución'),
        },
      },
      async ({ page_id, find_text, replace_text }) => {
        try {
          // El servidor solo regenera los bloques que contienen el fragmento:
          // el resto de la página (tablas, imágenes…) no se toca
          await api(`/api/pages/${page_id}/replace`, {
            method: 'POST',
            body: JSON.stringify({ find_text, replace_text }),
          });
          return ok(`Página ${page_id} editada (la versión anterior queda en el historial).`);
        } catch (e) {
          if (e.status === 404 && /find_text/.test(e.message)) {
            return fail(new Error('find_text no aparece en la página. Lee la página con read_page y usa el texto exacto.'));
          }
          if (e.status === 409) return fail(new Error('find_text aparece más de una vez. Añade más contexto para que sea único.'));
          return fail(e);
        }
      }
    );

    server.registerTool(
      'update_page',
      {
        title: 'Actualizar página',
        description:
          'Reescribe una página: reemplaza todo su contenido Markdown y/o cambia título, icono o fecha. El contenido anterior queda en el historial de versiones. Para añadir sin borrar usa append_to_page; para cambios puntuales, edit_page.',
        inputSchema: {
          page_id: z.string().describe('Id de la página'),
          markdown: z.string().optional().describe('Nuevo contenido completo en Markdown'),
          title: z.string().optional(),
          icon: z.string().optional().describe('Emoji'),
          page_date: z.string().optional().describe('Fecha YYYY-MM-DD (cadena vacía para quitarla)'),
        },
      },
      async ({ page_id, markdown, title, icon, page_date }) => {
        try {
          const body = {};
          if (markdown !== undefined) {
            body.content = await markdownToDoc(markdown); // se guarda como documento, igual que el editor
            body.content_text = markdown;
          }
          if (title !== undefined) body.title = title;
          if (icon !== undefined) body.icon = icon;
          if (page_date !== undefined) body.page_date = page_date || null;
          if (!Object.keys(body).length) return fail(new Error('Nada que actualizar.'));
          await api(`/api/pages/${page_id}`, { method: 'PUT', body: JSON.stringify(body) });
          return ok(`Página ${page_id} actualizada.`);
        } catch (e) {
          return fail(e);
        }
      }
    );

    server.registerTool(
      'trash_page',
      {
        title: 'Mover a la papelera',
        description:
          'Mueve una página (y sus subpáginas) a la papelera de NoNotion. Es reversible desde la interfaz durante 30 días. Úsala solo si el usuario lo pide explícitamente.',
        inputSchema: { page_id: z.string().describe('Id de la página') },
      },
      async ({ page_id }) => {
        try {
          const r = await (await api(`/api/pages/${page_id}`, { method: 'DELETE' })).json();
          return ok(`Movida a la papelera (${r.trashed} página(s)). Recuperable desde la interfaz.`);
        } catch (e) {
          return fail(e);
        }
      }
    );

    server.registerTool(
      'read_attachment',
      {
        title: 'Leer adjunto',
        description:
          'Lee el contenido de un archivo adjunto de NoNotion por su file_id (visible en read_page). Extrae el texto de PDF, Word y PowerPoint; las hojas de Excel/ODS las devuelve completas en CSV (una sección por hoja); muestra imágenes; y devuelve el contenido de archivos de texto/código. Para PDFs escaneados o con diagramas que necesites ver, usa read_document_pages.',
        inputSchema: { file_id: z.string().describe('Id del archivo (file_id)') },
      },
      async ({ file_id }) => {
        try {
          // HEAD para conocer el tipo sin descargar binarios grandes
          const head = await api(`/files/${file_id}`, { method: 'HEAD' });
          const mime = (head.headers.get('content-type') || '').split(';')[0];

          if (mime.startsWith('image/') && mime !== 'image/svg+xml') {
            const buf = Buffer.from(await (await api(`/files/${file_id}`)).arrayBuffer());
            if (buf.length > IMAGE_LIMIT) return ok(`Imagen demasiado grande (${buf.length} bytes, máx. ${IMAGE_LIMIT}).`);
            return { content: [{ type: 'image', data: buf.toString('base64'), mimeType: mime }] };
          }

          if (isTextMime(mime)) {
            const buf = Buffer.from(await (await api(`/files/${file_id}`)).arrayBuffer());
            if (buf.length > TEXT_LIMIT) {
              return ok(`Archivo de texto grande (${buf.length} bytes). Primeros 200 KB:\n\n${buf.subarray(0, TEXT_LIMIT).toString('utf8')}`);
            }
            return ok(buf.toString('utf8'));
          }

          // PDF / Word / Excel / PowerPoint → extracción de texto en el servidor
          const r = await api(`/files/${file_id}/text`);
          const data = await r.json();
          if (data.scanned) {
            return ok(
              'El documento no tiene capa de texto (parece escaneado o solo imágenes). Usa read_document_pages para verlo como imágenes.'
            );
          }
          let out = data.text;
          if (data.truncated) {
            out += `\n\n[… texto truncado: se muestran los primeros ${TEXT_EXTRACT_LIMIT_LABEL} de ${data.chars} caracteres. Pide una sección concreta o usa read_document_pages para páginas específicas.]`;
          }
          return ok(out);
        } catch (e) {
          if (e.status === 501) {
            return ok('Este archivo es binario y el servidor no tiene poppler instalado para extraer su contenido (apt install poppler-utils). Descargable desde la página en NoNotion.');
          }
          if (e.status === 400) {
            return ok('Archivo binario sin extractor de texto disponible. Descargable desde la página en NoNotion.');
          }
          return fail(e);
        }
      }
    );

    server.registerTool(
      'read_document_pages',
      {
        title: 'Ver páginas de documento',
        description:
          'Renderiza páginas concretas de un PDF o documento de oficina como imágenes, para leer documentos escaneados, diagramas, tablas con formato o cualquier cosa que la extracción de texto no capte bien. Indica las páginas (p. ej. "1-5" o "1,3,7"); máximo 10 por llamada.',
        inputSchema: {
          file_id: z.string().describe('Id del archivo (file_id)'),
          pages: z.string().optional().describe('Páginas a renderizar, p. ej. "1-5" o "2,4,6". Por defecto "1-3".'),
        },
      },
      async ({ file_id, pages = '1-3' }) => {
        try {
          const wanted = [];
          for (const part of pages.split(',')) {
            const m = part.trim().match(/^(\d+)(?:-(\d+))?$/);
            if (!m) continue;
            const from = parseInt(m[1], 10);
            const to = m[2] ? parseInt(m[2], 10) : from;
            for (let p = from; p <= to && wanted.length < MAX_RENDER_PAGES; p++) if (p >= 1) wanted.push(p);
          }
          if (!wanted.length) return fail(new Error('Especifica páginas válidas, p. ej. "1-5" o "2,4".'));
          const content = [{ type: 'text', text: `Páginas ${wanted.join(', ')} del documento:` }];
          for (const p of wanted) {
            const res = await api(`/files/${file_id}/page/${p}`);
            const buf = Buffer.from(await res.arrayBuffer());
            content.push({ type: 'image', data: buf.toString('base64'), mimeType: 'image/png' });
          }
          return { content };
        } catch (e) {
          if (e.status === 501) {
            return ok('El servidor no tiene poppler instalado para renderizar páginas (apt install poppler-utils).');
          }
          return fail(e);
        }
      }
    );

    // move_page / move_pages: mismo endpoint atómico que usa la interfaz
    const positionSchema = {
      position: z
        .number()
        .int()
        .min(0)
        .optional()
        .describe('Índice (0 = primera) entre las hermanas del destino. Sin posición: al final'),
      before_id: z.string().optional().describe('Colocarla justo antes de esta página hermana del destino'),
      after_id: z.string().optional().describe('Colocarla justo después de esta página hermana del destino'),
    };
    const toMove = (m) => ({
      page_id: m.page_id,
      parent_id: m.new_parent_id === undefined ? undefined : m.new_parent_id,
      index: m.position,
      before_id: m.before_id,
      after_id: m.after_id,
    });

    server.registerTool(
      'move_page',
      {
        title: 'Mover página',
        description:
          'Mueve una página (y sus subpáginas) bajo otro padre o a la raíz. Úsala para reclasificar; no cambia contenido, etiquetas ni ids.',
        inputSchema: {
          page_id: z.string().describe('Id de la página a mover'),
          new_parent_id: z
            .string()
            .nullable()
            .describe('Id del nuevo padre, o null para moverla a la raíz del espacio'),
          ...positionSchema,
        },
      },
      async (args) => {
        try {
          const r = await (
            await api('/api/move-pages', { method: 'POST', body: JSON.stringify({ moves: [toMove(args)] }) })
          ).json();
          return ok(r.results[0].message);
        } catch (e) {
          return fail(e);
        }
      }
    );

    server.registerTool(
      'move_pages',
      {
        title: 'Mover varias páginas',
        description:
          'Mueve varias páginas de una vez (cada una con sus subpáginas), de forma atómica: si un movimiento no es válido, no se aplica ninguno. Se aplican en orden. Úsala para reorganizaciones grandes; no cambia contenido, etiquetas ni ids.',
        inputSchema: {
          moves: z
            .array(
              z.object({
                page_id: z.string().describe('Id de la página a mover'),
                new_parent_id: z.string().nullable().describe('Id del nuevo padre, o null para la raíz del espacio'),
                ...positionSchema,
              })
            )
            .min(1)
            .max(200)
            .describe('Movimientos a aplicar, en orden'),
        },
      },
      async ({ moves }) => {
        try {
          const r = await (
            await api('/api/move-pages', { method: 'POST', body: JSON.stringify({ moves: moves.map(toMove) }) })
          ).json();
          const changed = r.results.filter((x) => !x.noop).length;
          return ok(
            `${changed} de ${r.results.length} página(s) movida(s):\n` + r.results.map((x) => `- ${x.message}`).join('\n')
          );
        } catch (e) {
          return fail(e);
        }
      }
    );

    // Canvas (JSON Canvas 1.0, como Obsidian)
    const canvasSchema = {
      nodes: z
        .array(z.object({}).passthrough())
        .describe(
          'Tarjetas. Comunes: id, type ("text"|"file"|"link"|"group"), x, y, width, height (px), color opcional ("1" rojo … "6" morado o "#rrggbb"). text: { text } en Markdown; file: { file } = "/p/<page_id>" para una página de NoNotion o "/files/<file_id>/<nombre>" para un adjunto; link: { url }; group: { label }. Orden = de abajo arriba.'
        ),
      edges: z
        .array(z.object({}).passthrough())
        .optional()
        .describe(
          'Conexiones: id, fromNode, toNode (ids de tarjetas), fromSide/toSide ("top"|"right"|"bottom"|"left"), fromEnd/toEnd ("none"|"arrow"; por defecto toEnd = arrow), color y label opcionales.'
        ),
    };

    server.registerTool(
      'create_canvas',
      {
        title: 'Crear canvas',
        description:
          'Crea un canvas (lienzo visual como el de Obsidian, formato JSON Canvas) con tarjetas y conexiones: mapas mentales, diagramas, tableros. Úsalo solo cuando el usuario lo pida. Coloca las tarjetas sin solaparse (p. ej. 300 px de ancho y 40 px de separación).',
        inputSchema: {
          title: z.string().describe('Título del canvas'),
          parent_id: z.string().optional().describe('Id de la página padre (elige el padre temático; sin él va a la raíz)'),
          icon: z.string().optional().describe('Emoji como icono'),
          ...canvasSchema,
        },
      },
      async ({ title, parent_id, icon, nodes, edges }) => {
        try {
          const r = await (
            await api('/api/pages', {
              method: 'POST',
              body: JSON.stringify({ kind: 'canvas', title, parent_id, icon: icon || '🧩', content: { nodes, edges: edges || [] } }),
            })
          ).json();
          return ok(`Canvas creado: "${r.title}" (id: ${r.id}, ruta: /p/${r.id}) con ${nodes.length} tarjeta(s).`);
        } catch (e) {
          return fail(e);
        }
      }
    );

    server.registerTool(
      'update_canvas',
      {
        title: 'Actualizar canvas',
        description:
          'Reemplaza el contenido de un canvas por el JSON Canvas dado (lee antes el actual con read_page y conserva lo que no cambies). La versión anterior queda en el historial.',
        inputSchema: { page_id: z.string().describe('Id del canvas'), ...canvasSchema },
      },
      async ({ page_id, nodes, edges }) => {
        try {
          const page = await (await api(`/api/pages/${page_id}`)).json();
          if (page.kind !== 'canvas') return fail(new Error('Esa página no es un canvas: usa append_to_page, edit_page o update_page'));
          await api(`/api/pages/${page_id}`, { method: 'PUT', body: JSON.stringify({ content: { nodes, edges: edges || [] } }) });
          return ok(`Canvas "${page.title || 'Sin título'}" actualizado: ${nodes.length} tarjeta(s), ${(edges || []).length} conexión(es).`);
        } catch (e) {
          return fail(e);
        }
      }
    );

    // Ideas: desarrollo de ideas fuera del árbol (semilla → desarrollo → resultado)
    const stepSchema = z.object({
      kind: z
        .enum(['note', 'question', 'answer', 'hypothesis', 'decision', 'discarded', 'outline'])
        .describe('Tipo de paso: question (pregunta abierta), answer (respuesta de la persona), hypothesis, decision, discarded (descartado y por qué), outline (esquema del documento), note'),
      text: z.string().describe('Texto del paso, en Markdown'),
    });
    const outcomeSchema = z.object({
      type: z
        .enum(['page', 'canvas', 'plan', 'issue', 'file', 'external'])
        .describe('page: página de NoNotion; canvas: diagrama/mapa (create_canvas); plan: página de planificación (tareas, hitos, fechas); file: archivo adjunto (attach_file: Word, Excel…); external: documento fuera de NoNotion (Google Docs, etc.)'),
      page_id: z.string().optional().describe('Id de la página/canvas/plan creado (page, canvas, plan)'),
      file_id: z.string().optional().describe('file_id del adjunto (file)'),
      url: z.string().optional().describe('URL del documento externo (external)'),
      label: z.string().optional().describe('Qué es, en pocas palabras: "Documento de diseño", "Diagrama de arquitectura", "Plan de implantación"'),
      note: z.string().optional().describe('Observación breve (opcional)'),
    });

    server.registerTool(
      'list_ideas',
      {
        title: 'Listar ideas',
        description:
          'Lista las ideas del espacio (desarrollo de ideas fuera del árbol de páginas) con su estado: seed (semilla sin trabajar), developing, documented, archived. Úsala cuando el usuario hable de sus ideas o pida desarrollar/documentar una.',
        inputSchema: {
          status: z.enum(['seed', 'developing', 'documented', 'archived']).optional().describe('Filtrar por estado'),
        },
      },
      async ({ status }) => {
        try {
          let ideas = await (await api('/api/ideas')).json();
          if (status) ideas = ideas.filter((i) => i.status === status);
          if (!ideas.length) return ok(status ? `No hay ideas en estado "${status}".` : 'No hay ideas todavía.');
          const label = { seed: 'semilla', developing: 'en desarrollo', documented: 'documentada', archived: 'archivada' };
          return ok(
            ideas
              .map(
                (i) =>
                  `- ${i.icon || '💡'} ${i.title || 'Sin título'} (id: ${i.id}, ${label[i.status]}, ${i.seeds} semilla(s), ${i.steps} paso(s), ${i.outcomes.length} resultado(s))${i.preview ? `\n  ${i.preview}` : ''}`
              )
              .join('\n')
          );
        } catch (e) {
          return fail(e);
        }
      }
    );

    server.registerTool(
      'create_idea',
      {
        title: 'Crear idea',
        description:
          'Guarda una idea nueva (fuera del árbol de páginas) a partir de su semilla: un texto, una lista de temas, un enlace o un fragmento de una página. Úsala solo cuando el usuario pida guardar algo como idea. Si manda una captura o archivo, créala primero y adjúntalo con attach_file a la idea; la interfaz lo tomará como semilla. No desarrolles la idea aquí: eso es develop_idea, cuando el usuario lo pida.',
        inputSchema: {
          title: z.string().optional().describe('Título corto (si falta, se deriva de la semilla)'),
          seed_text: z.string().optional().describe('La semilla en bruto, tal cual llegó (texto, lista de temas…)'),
          seed_url: z.string().optional().describe('Enlace que originó la idea'),
          source_page_id: z.string().optional().describe('Página de NoNotion de la que sale la idea (con seed_text como fragmento, si procede)'),
          summary: z.string().optional().describe('Una frase que enuncie la idea (solo si el usuario ya la tiene clara)'),
          icon: z.string().optional().describe('Emoji (por defecto 💡)'),
          tags: z.array(z.string()).optional().describe('Etiquetas (reutiliza las existentes: list_tags)'),
        },
      },
      async ({ title, seed_text, seed_url, source_page_id, summary, icon, tags }) => {
        try {
          const seeds = [];
          if (source_page_id) seeds.push({ kind: 'page', page_id: source_page_id, text: seed_text || undefined });
          else if (seed_text?.trim()) seeds.push({ kind: 'text', text: seed_text });
          if (seed_url?.trim()) seeds.push({ kind: 'link', url: seed_url.trim() });
          if (!seeds.length && !summary?.trim()) return fail(new Error('Indica al menos una semilla (seed_text, seed_url o source_page_id)'));
          const r = await (
            await api('/api/pages', {
              method: 'POST',
              body: JSON.stringify({ kind: 'idea', title, icon: icon || '💡', content: { type: 'idea', summary: summary || '', seeds } }),
            })
          ).json();
          if (tags?.length) await api(`/api/pages/${r.id}/tags`, { method: 'PUT', body: JSON.stringify({ tags }) });
          return ok(`Idea creada: "${r.title}" (id: ${r.id}, ruta: /p/${r.id}, estado: semilla). Está en la vista Ideas, fuera del árbol.`);
        } catch (e) {
          return fail(e);
        }
      }
    );

    server.registerTool(
      'develop_idea',
      {
        title: 'Desarrollar idea',
        description:
          'Añade pasos al desarrollo de una idea (preguntas, hipótesis, decisiones, descartes, esquema) y, si procede, actualiza su resumen o estado. Lee antes la idea con read_page (y sus capturas con read_attachment). Úsala para dejar constancia del razonamiento acordado con el usuario, no para volcar conversación. Pasa primero a "developing" automáticamente.',
        inputSchema: {
          page_id: z.string().describe('Id de la idea'),
          steps: z.array(stepSchema).min(1).max(50).describe('Pasos a añadir, en orden'),
          summary: z.string().optional().describe('Nuevo enunciado de la idea (sustituye el anterior)'),
          status: z.enum(['seed', 'developing', 'documented', 'archived']).optional().describe('Forzar un estado (normalmente no hace falta)'),
          title: z.string().optional().describe('Nuevo título, si la idea se ha concretado'),
        },
      },
      async ({ page_id, steps, summary, status, title }) => {
        try {
          const page = await (await api(`/api/pages/${page_id}`)).json();
          if (page.kind !== 'idea') return fail(new Error('Esa página no es una idea (list_ideas las lista)'));
          const body = { steps_add: steps.map((s) => ({ ...s, by: 'claude' })) };
          if (summary !== undefined) body.summary = summary;
          if (status !== undefined) body.status = status;
          if (title !== undefined) body.title = title;
          const r = await (await api(`/api/pages/${page_id}/idea`, { method: 'POST', body: JSON.stringify(body) })).json();
          return ok(`Idea "${r.title}" actualizada: ${r.idea.steps.length} paso(s) en total, estado ${r.idea.status}.`);
        } catch (e) {
          return fail(e);
        }
      }
    );

    server.registerTool(
      'materialize_idea',
      {
        title: 'Materializar idea',
        description:
          'Registra dónde se ha materializado una idea y la marca como documentada. Flujo: primero crea el resultado con la herramienta normal (create_page para documentación o un plan, create_canvas para diagramas/mapas, attach_file para Word/Excel/PowerPoint, o un documento externo), y después llama a esta con sus ids/urls. Una idea puede tener varios resultados (documento + diagrama + planning). Enlaza desde la página creada a la idea con [💡 título](/p/<idea_id>) para que queden conectadas en el grafo.',
        inputSchema: {
          page_id: z.string().describe('Id de la idea'),
          outcomes: z.array(outcomeSchema).min(1).max(20).describe('Resultados a registrar'),
          status: z.enum(['developing', 'documented', 'archived']).optional().describe('Estado final (por defecto, documented)'),
          summary: z.string().optional().describe('Enunciado final de la idea, si cambia'),
        },
      },
      async ({ page_id, outcomes, status, summary }) => {
        try {
          const page = await (await api(`/api/pages/${page_id}`)).json();
          if (page.kind !== 'idea') return fail(new Error('Esa página no es una idea (list_ideas las lista)'));
          for (const o of outcomes) {
            if (['page', 'canvas', 'plan', 'issue'].includes(o.type) && !o.page_id) return fail(new Error(`Resultado "${o.type}": falta page_id`));
            if (o.type === 'file' && !o.file_id) return fail(new Error('Resultado "file": falta file_id'));
            if (o.type === 'external' && !o.url) return fail(new Error('Resultado "external": falta url'));
          }
          const body = { outcomes_add: outcomes, status: status || 'documented' };
          if (summary !== undefined) body.summary = summary;
          const r = await (await api(`/api/pages/${page_id}/idea`, { method: 'POST', body: JSON.stringify(body) })).json();
          return ok(
            `Idea "${r.title}" materializada (${r.idea.status}): ${r.idea.outcomes.length} resultado(s) en total:\n` +
              r.idea.outcomes.map((o) => `- ${o.type}${o.label ? ` «${o.label}»` : ''}: ${o.page_id ? `/p/${o.page_id}` : o.url || o.file_id}`).join('\n')
          );
        } catch (e) {
          return fail(e);
        }
      }
    );

    // ---------- Seguimiento: listas (trackers) y tickets, como un Jira ligero ----------
    const issueRef = z.string().describe('Clave del ticket (p. ej. "BLQ-12") o su id de página');
    const trackerRef = z.string().describe('Lista: su id, su prefijo (BLQ) o su título');
    const resolveIssue = async (ref) => {
      const s = String(ref || '').trim();
      if (/^[A-Za-z][A-Za-z0-9]{0,9}-\d+$/.test(s)) {
        const r = await (await api(`/api/issues?key=${encodeURIComponent(s)}`)).json();
        if (!r.issues.length) throw new Error(`No hay ningún ticket ${s} en este espacio`);
        return r.issues[0].id;
      }
      return s;
    };
    const resolveTracker = async (ref) => {
      const s = String(ref || '').trim();
      const { trackers } = await (await api('/api/trackers')).json();
      const fold = (x) => String(x || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
      const t = trackers.find((x) => x.id === s || x.prefix === s.toUpperCase()) || trackers.find((x) => fold(x.title) === fold(s));
      if (!t) throw new Error(`No hay ninguna lista "${s}". Listas: ${trackers.map((x) => `${x.title} (${x.prefix})`).join(', ') || 'ninguna (créala con create_tracker)'}`);
      return t;
    };
    const linkSchema = z.object({
      type: z
        .enum(['blocks', 'relates', 'documents', 'origin'])
        .describe('blocks = este ticket bloquea a otro ticket; relates = relacionado; documents = documentado en una página; origin = viene de (idea, acta de reunión, página)'),
      target: z.string().describe('Id de la página o clave del ticket destino (BLQ-7)'),
    });
    const fieldsSchema = z
      .record(z.string(), z.any())
      .optional()
      .describe('Valores por NOMBRE de campo de la lista: {"Responsable": "vmorant", "Impacto": "Alto", "Fecha límite": "2026-11-20"}. Desplegables por nombre de opción; varias opciones como lista; null para vaciar. Mira los campos con list_trackers');
    const CAT = { todo: 'pendiente', doing: 'en curso', blocked: 'bloqueado', done: 'hecho' };
    const issueLine = (i, fieldsOf) => {
      const extra = (fieldsOf(i.tracker_id) || [])
        .filter((f) => i.values[f.id] != null && !(Array.isArray(i.values[f.id]) && !i.values[f.id].length))
        .map((f) => `${f.name}: ${f.type === 'select' ? f.options.find((o) => o.id === i.values[f.id])?.name : f.type === 'multi' ? i.values[f.id].map((x) => f.options.find((o) => o.id === x)?.name).join('/') : f.type === 'checkbox' ? (i.values[f.id] ? 'sí' : 'no') : i.values[f.id]}`);
      return `- ${i.key} ${i.title} · ${i.status_name}${extra.length ? ` · ${extra.join(' · ')}` : ''}${i.blocked_by_open ? ` · ⛔ bloqueado por ${i.blocked_by_open}` : ''} (id: ${i.id})`;
    };

    server.registerTool(
      'list_trackers',
      {
        title: 'Listar listas de seguimiento',
        description:
          'Devuelve las listas de seguimiento del espacio (p. ej. "Bloqueantes", "To-do", "Temas"): prefijo de sus tickets, estados y campos con sus opciones, y cuántos tickets hay por estado. Úsala antes de crear o filtrar tickets para saber qué lista y qué campos usar.',
        inputSchema: {},
      },
      async () => {
        try {
          const { trackers, templates } = await (await api('/api/trackers')).json();
          if (!trackers.length) {
            return ok(`No hay listas todavía. Plantillas para create_tracker: ${templates.map((t) => `${t.id} (${t.label})`).join(', ')}.`);
          }
          return ok(
            trackers
              .map((t) =>
                [
                  `## ${t.icon || '📋'} ${t.title} — prefijo ${t.prefix} (id: ${t.id})`,
                  `Tickets: ${Object.entries(t.counts).filter(([, n]) => n).map(([c, n]) => `${n} ${CAT[c]}`).join(', ') || 'ninguno'}`,
                  `Estados: ${t.config.statuses.map((s) => `${s.name} (${CAT[s.category]})`).join(', ')}`,
                  `Campos: ${t.config.fields.map((f) => `${f.name} [${f.type}${f.options ? `: ${f.options.map((o) => o.name).join(', ') || '—'}` : ''}]`).join('; ') || 'solo título y estado'}`,
                ].join('\n')
              )
              .join('\n\n')
          );
        } catch (e) {
          return fail(e);
        }
      }
    );

    server.registerTool(
      'create_tracker',
      {
        title: 'Crear lista de seguimiento',
        description:
          'Crea una lista de seguimiento (tickets con campos propios, como un Jira ligero) a partir de una plantilla: issues (incidencias y mejoras), blockers (bloqueos e impedimentos), todo (tareas), topics (temas y decisiones) o blank. Puede ir dentro de una página (parent_id: aparece bajo ella en el árbol) o sin página (solo en Seguimiento). Úsala solo cuando el usuario lo pida.',
        inputSchema: {
          title: z.string().describe('Nombre de la lista, p. ej. "Bloqueantes AXA"'),
          template: z.enum(['issues', 'blockers', 'todo', 'topics', 'blank']).optional().describe('Por defecto blank'),
          parent_id: z.string().optional().describe('Página a la que pertenece (sin él, lista independiente: solo en Seguimiento, no en el árbol)'),
          prefix: z.string().optional().describe('Prefijo de las claves (letras y números, p. ej. BLQ); por defecto el de la plantilla o derivado del título'),
          icon: z.string().optional(),
        },
      },
      async (args) => {
        try {
          const d = await (await api('/api/trackers', { method: 'POST', body: JSON.stringify(args) })).json();
          return ok(
            `Lista creada: «${args.title}» (id: ${d.id}, prefijo ${d.prefix}). Estados: ${d.config.statuses.map((s) => s.name).join(', ')}. Campos: ${d.config.fields.map((f) => f.name).join(', ') || 'ninguno'}.`
          );
        } catch (e) {
          return fail(e);
        }
      }
    );

    server.registerTool(
      'update_tracker',
      {
        title: 'Configurar lista de seguimiento',
        description:
          'Cambia la configuración de una lista: añadir campos (desplegable, varias opciones, texto, número, fecha, persona, casilla, enlace), añadir opciones a un desplegable, añadir estados, renombrar la lista o cambiar su prefijo. Solo cuando el usuario lo pida. No borra nada (para quitar campos o estados, que lo haga el usuario desde la interfaz).',
        inputSchema: {
          tracker: trackerRef,
          add_fields: z
            .array(
              z.object({
                name: z.string(),
                type: z.enum(['select', 'multi', 'text', 'number', 'date', 'person', 'checkbox', 'url']),
                options: z.array(z.string()).optional().describe('Opciones de un desplegable'),
                date_role: z.enum(['deadline', 'start', 'event', 'other']).optional().describe('Para fechas: qué significa en el calendario (fecha límite, inicio, evento u otra)'),
              })
            )
            .optional(),
          add_options: z.array(z.object({ field: z.string(), options: z.array(z.string()) })).optional().describe('Nuevas opciones para desplegables existentes'),
          add_statuses: z.array(z.object({ name: z.string(), category: z.enum(['todo', 'doing', 'blocked', 'done']) })).optional(),
          prefix: z.string().optional(),
          title: z.string().optional(),
        },
      },
      async ({ tracker, add_fields = [], add_options = [], add_statuses = [], prefix, title }) => {
        try {
          const t = await resolveTracker(tracker);
          const config = JSON.parse(JSON.stringify(t.config));
          const COLORS = ['blue', 'green', 'yellow', 'orange', 'red', 'purple', 'pink', 'teal', 'gray'];
          const optsOf = (names, start = 0) => names.map((n, i) => ({ name: n, color: COLORS[(start + i) % COLORS.length] }));
          for (const f of add_fields) {
            config.fields.push({
              name: f.name,
              type: f.type,
              ...(f.type === 'select' || f.type === 'multi' ? { options: optsOf(f.options || []) } : {}),
              ...(f.type === 'date' && f.date_role ? { date_role: f.date_role } : {}),
            });
          }
          for (const a of add_options) {
            const f = config.fields.find((x) => x.name.toLowerCase() === a.field.toLowerCase() || x.id === a.field);
            if (!f || !f.options) return fail(new Error(`«${a.field}» no es un desplegable de la lista`));
            const have = new Set(f.options.map((o) => o.name.toLowerCase()));
            f.options.push(...optsOf(a.options.filter((o) => !have.has(o.toLowerCase())), f.options.length));
          }
          for (const s of add_statuses) config.statuses.push({ name: s.name, category: s.category, color: s.category === 'done' ? 'green' : s.category === 'blocked' ? 'red' : s.category === 'doing' ? 'yellow' : 'blue' });
          const body = { config };
          if (prefix) body.prefix = prefix;
          const d = await (await api(`/api/pages/${t.id}/tracker`, { method: 'PATCH', body: JSON.stringify(body) })).json();
          if (title) await api(`/api/pages/${t.id}`, { method: 'PUT', body: JSON.stringify({ title }) });
          return ok(`Lista ${d.prefix} actualizada. Campos: ${d.config.fields.map((f) => f.name).join(', ') || 'ninguno'}. Estados: ${d.config.statuses.map((s) => s.name).join(', ')}.`);
        } catch (e) {
          return fail(e);
        }
      }
    );

    server.registerTool(
      'list_issues',
      {
        title: 'Listar tickets',
        description:
          'Lista tickets de seguimiento de una lista o de todas, con clave, estado y campos. Úsala para "¿qué está bloqueado?", "¿qué tengo pendiente?", "temas abiertos de AXA", o antes de crear uno para no duplicarlo.',
        inputSchema: {
          tracker: trackerRef.optional(),
          category: z.string().optional().describe('todo, doing, blocked, done o "active" (pendiente + en curso + bloqueado), separadas por comas'),
          status: z.string().optional().describe('Nombres de estado de la lista, separados por comas'),
          blocked_only: z.boolean().optional().describe('Solo lo bloqueado (estado bloqueado o bloqueado por otro ticket abierto)'),
          fields: z.record(z.string(), z.string()).optional().describe('Filtros por campo: {"Responsable": "vmorant", "Impacto": "Alto"}'),
          query: z.string().optional().describe('Texto en clave o título'),
        },
      },
      async ({ tracker, category, status, blocked_only, fields, query }) => {
        try {
          const qs = new URLSearchParams();
          if (tracker) qs.set('tracker', (await resolveTracker(tracker)).id);
          if (category) qs.set('category', category);
          if (status) qs.set('status', status);
          if (blocked_only) qs.set('blocked', 'true');
          if (fields) qs.set('fields', JSON.stringify(fields));
          if (query) qs.set('q', query);
          const [r, { trackers }] = await Promise.all([(await api(`/api/issues?${qs}`)).json(), (await api('/api/trackers')).json()]);
          if (!r.issues.length) return ok('No hay tickets que coincidan.');
          const fieldsOf = (id) => trackers.find((t) => t.id === id)?.config.fields;
          const byTracker = new Map();
          for (const i of r.issues) {
            if (!byTracker.has(i.tracker_title)) byTracker.set(i.tracker_title, []);
            byTracker.get(i.tracker_title).push(issueLine(i, fieldsOf));
          }
          return ok([...byTracker].map(([t, lines]) => `## ${t}\n${lines.join('\n')}`).join('\n\n'));
        } catch (e) {
          return fail(e);
        }
      }
    );

    server.registerTool(
      'create_issue',
      {
        title: 'Crear ticket',
        description:
          'Crea un ticket en una lista de seguimiento (mira antes list_trackers para elegir la lista y sus campos, y list_issues para no duplicar). Solo cuando el usuario lo pida ("apúntalo como bloqueante", "crea los tickets de esta reunión"). Relaciónalo con las páginas de las que sale o que lo documentan.',
        inputSchema: {
          tracker: trackerRef,
          title: z.string().describe('Título corto y concreto'),
          status: z.string().optional().describe('Nombre del estado (por defecto el primero de la lista)'),
          fields: fieldsSchema,
          description: z.string().optional().describe('Descripción en Markdown: contexto, impacto, qué se necesita'),
          links: z.array(linkSchema).optional().describe('Relaciones a crear'),
          from_idea_id: z.string().optional().describe('Idea de la que sale: queda enlazada y la idea lo registra como resultado'),
          tags: z.array(z.string()).optional(),
        },
      },
      async ({ tracker, ...args }) => {
        try {
          const t = await resolveTracker(tracker);
          const d = await (await api('/api/issues', { method: 'POST', body: JSON.stringify({ ...args, tracker_id: t.id }) })).json();
          return ok(`Ticket creado: ${d.key} «${args.title}» en «${d.tracker.title}» (id: ${d.page_id}, ${d.status_name}) con ${d.links.length} relación(es).`);
        } catch (e) {
          return fail(e);
        }
      }
    );

    server.registerTool(
      'update_issue',
      {
        title: 'Actualizar ticket',
        description:
          'Cambia estado, campos o título de un ticket y/o añade un comentario a su cronología (queda con autor y fecha). Cuando el usuario lo pida o lo confirme (p. ej. "marca BLQ-12 como resuelto", "comenta que IT ya dio acceso").',
        inputSchema: {
          issue: issueRef,
          status: z.string().optional().describe('Nombre del nuevo estado'),
          fields: fieldsSchema,
          title: z.string().optional(),
          comment: z.string().optional().describe('Comentario en Markdown para la cronología'),
        },
      },
      async ({ issue, ...rest }) => {
        try {
          const id = await resolveIssue(issue);
          const d = await (await api(`/api/pages/${id}/issue`, { method: 'PATCH', body: JSON.stringify(rest) })).json();
          return ok(`${d.key} actualizado: ${d.status_name}.`);
        } catch (e) {
          return fail(e);
        }
      }
    );

    server.registerTool(
      'link_issue',
      {
        title: 'Relacionar ticket',
        description:
          'Añade o quita una relación de un ticket (o de una lista entera con tracker): bloquea a otro ticket, relacionado con, documentado en, o viene de. El destino puede ser cualquier página, canvas, idea, evento (página con fecha), lista o ticket. Para quitar, pasa remove=true con el mismo tipo y destino.',
        inputSchema: {
          issue: issueRef.optional(),
          tracker: trackerRef.optional().describe('En lugar de issue: relacionar la lista entera (no admite "blocks")'),
          type: linkSchema.shape.type,
          target: linkSchema.shape.target,
          remove: z.boolean().optional(),
        },
      },
      async ({ issue, tracker, type, target, remove }) => {
        try {
          if (!issue && !tracker) return fail(new Error('Indica issue (ticket) o tracker (lista)'));
          const id = tracker ? (await resolveTracker(tracker)).id : await resolveIssue(issue);
          if (tracker) {
            if (remove) {
              const d = await (await api(`/api/pages/${id}/tracker`)).json();
              const tid = /^[A-Za-z][A-Za-z0-9]{0,9}-\d+$/.test(target) ? await resolveIssue(target) : target;
              const l = d.links.find((x) => x.type === type && x.target_id === tid);
              if (!l) return fail(new Error('Esa relación no existe'));
              await api(`/api/pages/${id}/issue/links/${l.id}`, { method: 'DELETE' });
              return ok('Relación de la lista quitada.');
            }
            const d = await (await api(`/api/pages/${id}/issue/links`, { method: 'POST', body: JSON.stringify({ type, target }) })).json();
            return ok(`Lista ${d.prefix}: ${d.links.length} relación(es).`);
          }
          if (remove) {
            const d = await (await api(`/api/pages/${id}/issue`)).json();
            const tid = /^[A-Za-z][A-Za-z0-9]{0,9}-\d+$/.test(target) ? await resolveIssue(target) : target;
            const l = d.links.find((x) => x.type === type && x.target_id === tid);
            if (!l) return fail(new Error('Esa relación no existe'));
            await api(`/api/pages/${id}/issue/links/${l.id}`, { method: 'DELETE' });
            return ok(`Relación quitada de ${d.key}.`);
          }
          const d = await (await api(`/api/pages/${id}/issue/links`, { method: 'POST', body: JSON.stringify({ type, target }) })).json();
          return ok(`${d.key}: ${d.links.length} relación(es) salientes, ${d.incoming.length} entrantes.`);
        } catch (e) {
          return fail(e);
        }
      }
    );

    server.registerTool(
      'agenda',
      {
        title: 'Agenda y calendario',
        description:
          'Qué hay en unas fechas: eventos y reuniones (páginas con fecha), fechas de tickets de las listas de seguimiento por tipo (fecha límite, inicio, evento, otra) y, si se pide, páginas creadas o modificadas. Incluye las fechas límite vencidas de tickets abiertos. Úsala para "¿qué vence esta semana?", "¿qué tengo el jueves?", "¿qué está vencido?".',
        inputSchema: {
          from: z.string().optional().describe('AAAA-MM-DD (por defecto hoy)'),
          to: z.string().optional().describe('AAAA-MM-DD (por defecto dentro de 14 días)'),
          kinds: z
            .array(z.enum(['events', 'deadline', 'start', 'event', 'other', 'created', 'edited']))
            .optional()
            .describe('Qué incluir: events (páginas con fecha), deadline/start/event/other (fechas de tickets), created/edited (actividad). Por defecto todo menos created/edited'),
          tracker: trackerRef.optional().describe('Solo las fechas de esta lista'),
          include_done: z.boolean().optional().describe('Incluir tickets hechos (por defecto no)'),
        },
      },
      async ({ from, to, kinds, tracker, include_done }) => {
        try {
          const day = (d) => d.toISOString().slice(0, 10);
          const f = from || day(new Date());
          const t = to || day(new Date(Date.now() + 14 * 86400000));
          const want = new Set(kinds?.length ? kinds : ['events', 'deadline', 'start', 'event', 'other']);
          const trackerId = tracker ? (await resolveTracker(tracker)).id : null;
          const d = await (await api(`/api/calendar?from=${f}&to=${t}&overdue=${day(new Date())}`)).json();
          const lines = [];
          const overdue = d.issues.filter((i) => i.overdue && i.day < f && (!trackerId || i.tracker_id === trackerId));
          if (overdue.length && want.has('deadline')) {
            lines.push('## ⚠ Vencido', ...overdue.map((i) => `- ${i.day} · ${i.key} ${i.title} (${i.tracker_title}, ${i.status_name}) — ${i.field}`), '');
          }
          const items = [];
          if (want.has('events') && !trackerId) for (const p of d.dated) items.push({ day: p.day, text: `📅 Evento: ${p.title || 'Sin título'} (id: ${p.id})` });
          for (const i of d.issues) {
            if (i.day < f || !want.has(i.role) || (trackerId && i.tracker_id !== trackerId)) continue;
            if (!include_done && i.category === 'done') continue;
            const label = { deadline: '⏰ Vence', start: '▶ Empieza', event: '📌 Evento', other: '• Fecha' }[i.role];
            items.push({ day: i.day, text: `${label}: ${i.key} ${i.title} — ${i.field} (${i.tracker_title}, ${i.status_name})${i.overdue ? ' ⚠ vencido' : ''}` });
          }
          if (want.has('created') && !trackerId) for (const p of d.created) items.push({ day: p.day, text: `✚ Creada: ${p.title || 'Sin título'} (id: ${p.id})` });
          if (want.has('edited') && !trackerId) for (const p of d.edited) items.push({ day: p.day, text: `✎ Editada: ${p.title || 'Sin título'} (id: ${p.id})` });
          items.sort((a, b) => a.day.localeCompare(b.day));
          let cur = null;
          for (const it of items) {
            if (it.day !== cur) {
              lines.push(`## ${it.day}`);
              cur = it.day;
            }
            lines.push(`- ${it.text}`);
          }
          return ok(lines.length ? lines.join('\n') : `Nada entre ${f} y ${t}.`);
        } catch (e) {
          return fail(e);
        }
      }
    );

    // ---------- Actas de reunión ----------
    const proposalSchema = z.object({
      type: z.enum(['task', 'list', 'doc', 'idea', 'event']).describe('task = tarea con seguimiento (ticket en una lista); list = lista de seguimiento nueva; doc = página de documentación; idea; event = evento de calendario (página con fecha)'),
      title: z.string(),
      details: z.string().optional().describe('Contexto en Markdown'),
      payload: z
        .object({
          tracker_id: z.string().optional().describe('task: lista donde va el ticket (list_trackers); si falta, la persona la elige'),
          assignee: z.string().optional().describe('task: responsable'),
          date: z.string().optional().describe('task: fecha límite; event: fecha del evento (AAAA-MM-DD)'),
          fields: z.record(z.string(), z.any()).optional().describe('task: otros campos de la lista por nombre'),
          parent_id: z.string().optional().describe('doc/event/list: página bajo la que va (por defecto, el proyecto del acta)'),
          template: z.enum(['issues', 'blockers', 'todo', 'topics', 'blank']).optional().describe('list: plantilla'),
        })
        .optional(),
    });

    server.registerTool(
      'list_minutes',
      {
        title: 'Listar actas',
        description: 'Lista las actas de reunión del espacio (fecha, proyecto, asistentes y cuántas propuestas quedan por aprobar).',
        inputSchema: {},
      },
      async () => {
        try {
          const { minutes } = await (await api('/api/minutes')).json();
          if (!minutes.length) return ok('No hay actas todavía.');
          return ok(
            minutes
              .map((m) => `- ${m.date || '—'} · ${m.title} (id: ${m.id})${m.project ? ` · proyecto «${m.project.title}»` : ''}${m.attendees.length ? ` · ${m.attendees.join(', ')}` : ''}${m.pending ? ` · ⏳ ${m.pending} propuesta(s) por aprobar` : ''}`)
              .join('\n')
          );
        } catch (e) {
          return fail(e);
        }
      }
    );

    server.registerTool(
      'create_minutes',
      {
        title: 'Crear acta de reunión',
        description:
          'Guarda un acta de reunión (sección Actas, sale en el calendario) con su texto en Markdown, fecha, proyecto y asistentes, y opcionalmente las propuestas que salen de ella (tareas, listas, documentación, ideas, eventos). Las propuestas NO se crean: quedan en la bandeja del acta hasta que la persona las aprueba. Úsala solo cuando el usuario pida guardar el acta.',
        inputSchema: {
          title: z.string(),
          date: z.string().optional().describe('AAAA-MM-DD (por defecto hoy)'),
          project_id: z.string().optional().describe('Página del proyecto al que pertenece'),
          attendees: z.array(z.string()).optional(),
          markdown: z.string().optional().describe('Texto del acta: Asistentes, Agenda, Notas, Acciones (- [ ] …), Decisiones, Ideas'),
          proposals: z.array(proposalSchema).optional(),
        },
      },
      async (args) => {
        try {
          const d = await (await api('/api/minutes', { method: 'POST', body: JSON.stringify(args) })).json();
          return ok(`Acta guardada: «${d.title}» (id: ${d.page_id}, ${d.date}) con ${d.items.length} propuesta(s) pendientes de aprobar en la app.`);
        } catch (e) {
          return fail(e);
        }
      }
    );

    server.registerTool(
      'propose_from_minutes',
      {
        title: 'Proponer desde un acta',
        description:
          'Añade a la bandeja de un acta propuestas de lo que hay que crear: tareas con seguimiento (en qué lista, responsable, fecha), listas nuevas, documentación, ideas y eventos de calendario. No crea nada: la persona revisa y aprueba en la app. Lee antes el acta con read_page (y list_trackers para elegir listas). No repitas propuestas que ya estén.',
        inputSchema: { minutes_id: z.string(), proposals: z.array(proposalSchema).min(1).max(60) },
      },
      async ({ minutes_id, proposals }) => {
        try {
          const d = await (await api(`/api/pages/${minutes_id}/minutes/items`, { method: 'POST', body: JSON.stringify({ proposals }) })).json();
          return ok(`${d.added} propuesta(s) añadidas a «${d.title}» (las repetidas se ignoran). La persona las aprueba en la app.`);
        } catch (e) {
          return fail(e);
        }
      }
    );

    server.registerTool(
      'list_tags',
      {
        title: 'Listar etiquetas',
        description: 'Devuelve todas las etiquetas de NoNotion con cuántas páginas tiene cada una. Úsala antes de etiquetar para reutilizar las existentes en vez de inventar variantes.',
        inputSchema: {},
      },
      async () => {
        try {
          const tags = await (await api('/api/tags')).json();
          if (!tags.length) return ok('Todavía no hay etiquetas.');
          return ok(tags.map((t) => `- #${t.name} (${t.count} página${t.count === 1 ? '' : 's'})`).join('\n'));
        } catch (e) {
          return fail(e);
        }
      }
    );

    server.registerTool(
      'tag_page',
      {
        title: 'Etiquetar página',
        description:
          'Añade y/o quita etiquetas de una página (no cambia su contenido). Las etiquetas no distinguen mayúsculas y se guardan en minúsculas ("Pegasus" = "pegasus"). Primero se quitan las de remove y luego se añaden las de add. Úsala solo cuando el usuario pida clasificar o etiquetar.',
        inputSchema: {
          page_id: z.string().describe('Id de la página'),
          add: z.array(z.string()).optional().describe('Etiquetas a añadir'),
          remove: z.array(z.string()).optional().describe('Etiquetas a quitar'),
        },
      },
      async ({ page_id, add = [], remove = [] }) => {
        try {
          const page = await (await api(`/api/pages/${page_id}`)).json();
          const rm = new Set(remove.map(normalizeTag).filter(Boolean));
          const next = [...(page.tags || []).filter((t) => !rm.has(normalizeTag(t))), ...add];
          const r = await (await api(`/api/pages/${page_id}/tags`, { method: 'PUT', body: JSON.stringify({ tags: next }) })).json();
          return ok(`Etiquetas de "${page.title || 'Sin título'}": ${r.tags.length ? r.tags.map((t) => '#' + t).join(' ') : '(ninguna)'}`);
        } catch (e) {
          return fail(e);
        }
      }
    );

    server.registerTool(
      'attach_file',
      {
        title: 'Adjuntar archivo',
        description:
          'Sube un archivo como adjunto de una página de NoNotion. Úsala para guardar código generado, configuraciones o datos como archivo descargable (además de mostrarlos en el markdown si procede). encoding "text" para contenido de texto, "base64" para binario.',
        inputSchema: {
          page_id: z.string().describe('Id de la página destino'),
          filename: z.string().describe('Nombre del archivo con extensión, p. ej. backup.sh'),
          content: z.string().describe('Contenido del archivo'),
          encoding: z.enum(['text', 'base64']).optional().describe('Por defecto "text"'),
        },
      },
      async ({ page_id, filename, content, encoding = 'text' }) => {
        try {
          const problem = checkAttachment(filename, content, encoding);
          if (problem) return { content: [{ type: 'text', text: `Error: ${problem}` }], isError: true };
          const data = encoding === 'base64' ? Buffer.from(content, 'base64') : Buffer.from(content, 'utf8');
          const mime = EXT_MIME[path.extname(filename).toLowerCase()] || 'application/octet-stream';
          const fd = new FormData();
          fd.append('page_id', page_id);
          fd.append('file', new Blob([data], { type: mime }), filename);
          const r = await (await api('/api/files', { method: 'POST', body: fd })).json();
          return ok(`Archivo adjuntado: ${r.name} (file_id: ${r.id}, ${r.size} bytes) en la página ${page_id}.`);
        } catch (e) {
          return fail(e);
        }
      }
    );

    return server;
  }

  app.post('/mcp/:token', async (req, res) => {
    if (!lookupToken(req.params.token)) {
      return res.status(401).json({
        jsonrpc: '2.0',
        error: { code: -32001, message: 'Token MCP inválido' },
        id: null,
      });
    }
    try {
      // Stateless: una instancia por petición, sin sesiones que mantener
      const server = buildServer(req.params.token);
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      res.on('close', () => {
        transport.close();
        server.close();
      });
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (err) {
      console.error('Error MCP:', err);
      if (!res.headersSent) {
        res.status(500).json({ jsonrpc: '2.0', error: { code: -32603, message: 'Error interno' }, id: null });
      }
    }
  });

  // En modo stateless no hay stream de notificaciones ni sesiones que cerrar
  const reject = (req, res) => {
    if (!lookupToken(req.params.token)) {
      return res.status(401).json({
        jsonrpc: '2.0',
        error: { code: -32001, message: 'Token MCP inválido' },
        id: null,
      });
    }
    res.status(405).json({
      jsonrpc: '2.0',
      error: { code: -32000, message: 'Método no permitido (servidor MCP sin estado)' },
      id: null,
    });
  };
  app.get('/mcp/:token', reject);
  app.delete('/mcp/:token', reject);

  const wsName = tokenWorkspaceName(legacyToken);
  console.log(`MCP activo: POST /mcp/<token> (un token por espacio y persona: Ajustes del espacio → Conector de Claude)`);
  // Nunca el token entero en el registro (journald lo guarda y puede leerlo más gente)
  if (wsName) console.log(`  Conector histórico del espacio "${wsName}": /mcp/${legacyToken.slice(0, 4)}… (la URL completa está en ${path.join(DATA_DIR, 'mcp_token')})`);
  return legacyToken;
}
