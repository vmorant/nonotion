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
import { DATA_DIR } from './db.js';

const TEXT_LIMIT = 200 * 1024; // 200 KB para adjuntos de texto
const IMAGE_LIMIT = 4 * 1024 * 1024; // 4 MB para imágenes

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

function getOrCreateToken() {
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

export function mountMcp(app, port) {
  const token = getOrCreateToken();
  const base = `http://127.0.0.1:${port}`;

  async function api(p, options = {}) {
    const headers = { ...(options.headers || {}) };
    if (options.body && typeof options.body === 'string') headers['Content-Type'] = 'application/json';
    const res = await fetch(base + p, { ...options, headers });
    if (!res.ok) {
      let msg = `Error HTTP ${res.status}`;
      try {
        msg = (await res.json()).error || msg;
      } catch {}
      throw new Error(msg);
    }
    return res;
  }

  const ok = (text) => ({ content: [{ type: 'text', text }] });
  const fail = (err) => ({ content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true });

  function buildServer() {
    const server = new McpServer({ name: 'nonotion', version: '1.0.0' });

    server.registerTool(
      'search_pages',
      {
        title: 'Buscar páginas',
        description:
          'Busca páginas en NoNotion por texto (títulos y contenido). Úsala SIEMPRE antes de crear una página nueva, para comprobar si ya existe una sobre el tema.',
        inputSchema: { query: z.string().describe('Texto a buscar') },
      },
      async ({ query }) => {
        try {
          const rows = await (await api(`/api/search?q=${encodeURIComponent(query)}`)).json();
          if (!rows.length) return ok('Sin resultados.');
          return ok(
            rows
              .map((r) => `- ${r.icon || '📄'} ${r.title || 'Sin título'} (id: ${r.id})${r.snippet ? `\n  …${r.snippet.replace(/<\/?mark>/g, '**')}…` : ''}`)
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
        description: 'Devuelve el árbol completo de páginas de NoNotion (id, icono, título, fecha asignada).',
        inputSchema: {},
      },
      async () => {
        try {
          const pages = await (await api('/api/pages')).json();
          if (!pages.length) return ok('No hay páginas todavía.');
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
                `${'  '.repeat(depth)}- ${p.icon || '📄'} ${p.title || 'Sin título'} (id: ${p.id}${p.page_date ? `, fecha: ${p.page_date}` : ''})`
              );
              walk(p.id, depth + 1);
            }
          };
          walk(null, 0);
          return ok(lines.join('\n'));
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
          'Lee una página de NoNotion: devuelve su contenido en Markdown y la lista de archivos adjuntos (con file_id para read_attachment).',
        inputSchema: { page_id: z.string().describe('Id de la página') },
      },
      async ({ page_id }) => {
        try {
          const p = await (await api(`/api/pages/${page_id}/markdown`)).json();
          let out = `# ${p.icon ? p.icon + ' ' : ''}${p.title || 'Sin título'}\n`;
          out += `(id: ${p.id}${p.page_date ? ` · fecha: ${p.page_date}` : ''} · actualizada: ${p.updated_at}${p.trashed ? ' · EN PAPELERA' : ''})\n\n`;
          out += p.markdown || '(página vacía)';
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
          'Crea una página nueva en NoNotion con contenido Markdown. Úsala SOLO cuando el usuario pida explícitamente una página nueva; para añadir contenido a una conversación en curso usa append_to_page. Sin parent_id la página va a la página Inbox.',
        inputSchema: {
          markdown: z.string().describe('Contenido en Markdown'),
          title: z.string().optional().describe('Título (si falta, se deriva del primer encabezado)'),
          parent_id: z.string().optional().describe('Id de la página padre'),
          page_date: z.string().optional().describe('Fecha YYYY-MM-DD para fijarla en el calendario (reuniones)'),
          icon: z.string().optional().describe('Emoji como icono'),
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
          const p = await (await api(`/api/pages/${page_id}/markdown`)).json();
          const md = p.markdown || '';
          const count = md.split(find_text).length - 1;
          if (count === 0) return fail(new Error('find_text no aparece en la página. Lee la página con read_page y usa el texto exacto.'));
          if (count > 1) return fail(new Error(`find_text aparece ${count} veces. Añade más contexto para que sea único.`));
          const updated = md.replace(find_text, replace_text);
          await api(`/api/pages/${page_id}`, {
            method: 'PUT',
            body: JSON.stringify({ content: updated, content_text: updated }),
          });
          return ok(`Página ${page_id} editada.`);
        } catch (e) {
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
            body.content = markdown;
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
          'Descarga un archivo adjunto de NoNotion por su file_id (visible en read_page). Devuelve texto para archivos de texto/código/JSON (hasta 200 KB) y la imagen para imágenes (hasta 4 MB); para otros tipos devuelve solo los metadatos.',
        inputSchema: { file_id: z.string().describe('Id del archivo (file_id)') },
      },
      async ({ file_id }) => {
        try {
          const res = await api(`/files/${file_id}`);
          const mime = (res.headers.get('content-type') || '').split(';')[0];
          const buf = Buffer.from(await res.arrayBuffer());
          if (mime.startsWith('image/') && mime !== 'image/svg+xml') {
            if (buf.length > IMAGE_LIMIT) return ok(`Imagen demasiado grande (${buf.length} bytes, máx. ${IMAGE_LIMIT}).`);
            return { content: [{ type: 'image', data: buf.toString('base64'), mimeType: mime }] };
          }
          if (isTextMime(mime)) {
            if (buf.length > TEXT_LIMIT) {
              return ok(`Archivo de texto demasiado grande (${buf.length} bytes). Primeros 200 KB:\n\n${buf.subarray(0, TEXT_LIMIT).toString('utf8')}`);
            }
            return ok(buf.toString('utf8'));
          }
          return ok(`Archivo binario (${mime || 'tipo desconocido'}, ${buf.length} bytes). No se puede mostrar; descargable desde la página en NoNotion.`);
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
    if (req.params.token !== token) {
      return res.status(401).json({
        jsonrpc: '2.0',
        error: { code: -32001, message: 'Token MCP inválido' },
        id: null,
      });
    }
    try {
      // Stateless: una instancia por petición, sin sesiones que mantener
      const server = buildServer();
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
    if (req.params.token !== token) {
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

  console.log(`MCP activo: POST /mcp/${token}`);
  console.log(`  Conector para Claude: https://TU_DOMINIO/mcp/${token}`);
  return token;
}
