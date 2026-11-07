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
import { lookupToken } from './workspaces.js';
import { normalizeTag } from './tags.js';
import { markdownToDoc } from './markdown.js';

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
          const pages = all.filter((p) => p.kind !== 'idea');
          const ws = (await (await api('/api/workspaces')).json()).workspaces?.[0];
          let head = ws ? `Espacio: ${ws.icon || ''} ${ws.name} (este conector solo ve este espacio)\n` : '';
          head += ideas.length ? `Ideas en desarrollo (fuera del árbol): ${ideas.length} → list_ideas\n\n` : '\n';
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
                `${'  '.repeat(depth)}- ${p.icon || '📄'} ${p.title || 'Sin título'} (id: ${p.id}${p.kind === 'canvas' ? ', canvas' : ''}${p.page_date ? `, fecha: ${p.page_date}` : ''})${p.tags?.length ? ` [${p.tags.map((t) => '#' + t).join(' ')}]` : ''}`
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
          out += p.markdown || '(página vacía)';
          if (p.kind === 'canvas') out += `\n\n---\nJSON Canvas:\n\`\`\`json\n${JSON.stringify(p.canvas)}\n\`\`\``;
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
        .enum(['page', 'canvas', 'plan', 'file', 'external'])
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
            if (['page', 'canvas', 'plan'].includes(o.type) && !o.page_id) return fail(new Error(`Resultado "${o.type}": falta page_id`));
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

  const ws = db.prepare('SELECT w.name FROM api_tokens t JOIN workspaces w ON w.id = t.workspace_id WHERE t.token = ?').get(legacyToken);
  console.log(`MCP activo: POST /mcp/<token> (un token por espacio y persona: Ajustes del espacio → Conector de Claude)`);
  // Nunca el token entero en el registro (journald lo guarda y puede leerlo más gente)
  if (ws) console.log(`  Conector histórico del espacio "${ws.name}": /mcp/${legacyToken.slice(0, 4)}… (cópialo desde Ajustes del espacio)`);
  return legacyToken;
}
