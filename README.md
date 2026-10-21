# NoNotion 🗂️

Webapp autoalojada tipo Notion, **sin límites de capacidad**: tus apuntes, respuestas de IA (Claude) y archivos viven en tu propio LXC de Proxmox, detrás de tu túnel de Cloudflare con Zero Trust.

## Características

- **Editor de bloques estilo Notion** — escribe `/` para insertar encabezados, listas, tareas, citas, tablas, código, imágenes y separadores.
- **Pegado de Markdown nativo** — copia una respuesta de Claude (o cualquier Markdown) y pégala: se convierte automáticamente en bloques con formato, incluyendo **bloques de código con resaltado de sintaxis**, tablas y listas. También puedes copiar desde el editor y obtienes Markdown.
- **Páginas anidadas infinitas** — organiza con un árbol de páginas y subpáginas, iconos emoji y migas de pan, como en Notion.
- **Archivos sin límite** — sube o arrastra cualquier archivo a una página; solo te limita el disco del LXC. Las imágenes pegadas se insertan en línea.
- **Búsqueda instantánea** — `Ctrl+K` busca en títulos y contenido de todas las páginas (full-text con SQLite FTS5).
- **Exportar a Markdown** — descarga cualquier página como `.md` con un clic.
- **Enlaces públicos de solo lectura** — comparte una página concreta con quien quieras sin darle acceso a tu Zero Trust (requiere una regla de bypass, ver abajo).
- **Captura desde el PC de IA** — `POST /api/capture` acepta Markdown directamente y el CLI `cli/nonotion-send.sh` (o `.ps1` en Windows) crea una página desde el portapapeles o stdin con un comando, sin abrir el navegador. Las capturas van a una página "📥 Inbox".
- **Historial de versiones** — snapshots automáticos al editar (máx. uno cada 10 min, se conservan 50 por página) con vista previa y restauración, como el Page History de Notion.
- **Papelera** — eliminar mueve a la papelera (con subpáginas y archivos); restaurable durante 30 días, después se purga automáticamente.
- **Organiza arrastrando** — arrastra páginas en el árbol para reordenarlas o anidarlas; duplica páginas (subárbol y archivos incluidos) con un clic.
- **Visor de documentos integrado** — clic en un adjunto y se abre dentro de NoNotion: PDF, imágenes, vídeo, audio y texto/código directamente, y **Word, Excel y PowerPoint** convertidos a PDF en el servidor con LibreOffice (con caché: la primera apertura tarda unos segundos, las siguientes son instantáneas). Nada sale de tu servidor — sin visores de Google/Microsoft.
- **Visor de Excel de verdad** — los `.xlsx`, `.xls`, `.ods` y `.csv` se abren como hoja de cálculo: pestañas de hojas (las ocultas en cursiva), cabecera de columnas y números de fila fijos, celdas combinadas, anchos de columna del original y buscador que filtra filas. Si quieres ver el formato de impresión, "Ver como PDF" usa la conversión de LibreOffice. Claude (MCP `read_attachment`) recibe todas las hojas completas en CSV.
- **Índice lateral y secciones plegables** — en páginas con 3 o más encabezados aparece un índice a la derecha que resalta la sección visible y salta a cada una. Cada encabezado tiene un triángulo para plegar su sección (solo visual: el contenido se guarda y exporta entero; lo plegado se recuerda por página en el navegador).
- **Tablas cómodas** — cabecera fija al desplazarte, scroll horizontal en tablas anchas, columnas redimensionables arrastrando el borde, y una barra sobre la tabla para ordenar filas por la columna actual (entiende números como `1.234,5`), añadir/quitar filas y columnas y **copiar la tabla para pegarla en Excel**. Al pegar Markdown de Claude, los `<br>` de las celdas se convierten en saltos de línea.
- **Ancho completo por página** — botón ↔ para usar todo el ancho de la pantalla (se guarda en la página, igual en todos tus dispositivos).
- **Favoritas y recientes** — ★ en una página (o en su menú ⋯ del árbol) la fija arriba en la barra lateral; "Recientes" muestra las últimas páginas que abriste en ese navegador.
- **Enlaces que se abren** — clic en un enlace: burbuja con *Abrir* (páginas de NoNotion se abren dentro de la app; adjuntos en el visor), *Pestaña nueva*, *Vista previa* de webs externas (si la web permite mostrarse dentro de otra), editar y quitar. `Ctrl/⌘+clic` o clic central abren directamente en pestaña nueva.
- **Enlaces entre páginas** — escribe `[[` (o `/enlace`) para buscar una página y enlazarla; pegar la URL de una página de NoNotion la convierte en enlace con su título. Cada página muestra abajo "↩ Enlazada desde" con las páginas que la enlazan.
- **Etiquetas** — clasifica cada página con etiquetas de colores (bajo el título, con autocompletado). La vista **🏷 Etiquetas** filtra por una o varias (todas / alguna), lista también los adjuntos de esas páginas y tiene un filtro "Sin etiquetar" para ir clasificando. Renombrar (fusiona si ya existe), cambiar color o borrar desde su menú ⋯. En la búsqueda `Ctrl+K`, `#etiqueta` filtra resultados. Claude las lee y, si se lo pides, las aplica (`list_tags`, `tag_page`).
- **Imágenes ágiles** — al pegar o arrastrar, la imagen aparece al instante donde la sueltas con la subida avanzando encima. Redimensiona arrastrando los tiradores laterales, o con la barra al seleccionarla (25/50/75/100 %, original), alinéala a izquierda/centro/derecha, y ábrela a tamaño completo con doble clic. El tamaño se guarda en la página y se respeta cuando Claude la edita.
- **Export ZIP completo** — descarga todo el workspace como Markdown + archivos adjuntos con enlaces relativos: backup portable, cero lock-in.
- **Calendario propio (sin integraciones externas)** — vista mensual y semanal que muestra qué páginas creaste y editaste cada día (registro de actividad interno): de un vistazo ves en qué trabajaste y qué días no. Los datos antiguos se reconstruyen automáticamente desde el historial de versiones.
- **Reuniones** — asigna una fecha a cualquier página y queda fijada ese día en el calendario (también fechas futuras). El botón "+" de un día crea una página de reunión con plantilla (asistentes, agenda, notas, acciones), y el comando `/reunión` inserta la misma plantilla en cualquier página.
- **Integración con Cloudflare Access** — la app muestra el usuario autenticado leyendo la cabecera `Cf-Access-Authenticated-User-Email`. No hay login propio: Zero Trust es la puerta.
- **Autoguardado** — todo se guarda solo mientras escribes.

## Stack

- **Backend**: Node.js 20 + Express + SQLite (better-sqlite3, modo WAL). Los archivos se guardan directamente en disco.
- **Frontend**: React + Vite + Tiptap (ProseMirror) con `tiptap-markdown` y `lowlight` para sintaxis.
- **Sin Docker, sin Postgres, sin S3**: un solo proceso, una carpeta de datos. Backup = copiar `/var/lib/nonotion`.

## Desarrollo local

```bash
npm install
npm run build        # compila el frontend (client/dist)
npm run dev          # servidor en http://localhost:3000
```

Para desarrollo con recarga del frontend:

```bash
npm run dev                      # terminal 1: API en :3000
cd client && npm run dev         # terminal 2: Vite en :5173 con proxy a la API
```

## Instalación en el LXC de Proxmox

Recomendado: LXC Debian 12, 1–2 vCPU, 1 GB RAM, y el disco que quieras para tus archivos.

```bash
# Dentro del contenedor, como root:
apt-get update && apt-get install -y git
git clone https://github.com/vmorant/nonotion.git /root/nonotion
cd /root/nonotion
bash deploy/install.sh
```

El script instala Node 20, compila el frontend, crea el usuario de servicio `nonotion`, instala la app en `/opt/nonotion`, los datos en `/var/lib/nonotion` y deja un servicio systemd arrancado:

```bash
systemctl status nonotion
journalctl -u nonotion -f
```

Para actualizar más adelante:

```bash
cd /root/nonotion && git pull && bash deploy/install.sh
```

(Los datos en `/var/lib/nonotion` nunca se tocan.)

## Cloudflare Tunnel (cloudflared)

Si ya tienes el túnel configurado, solo añade un ingress apuntando al LXC. En `/etc/cloudflared/config.yml` del host donde corre cloudflared:

```yaml
tunnel: <TU_TUNNEL_ID>
credentials-file: /etc/cloudflared/<TU_TUNNEL_ID>.json

ingress:
  - hostname: notas.tudominio.com
    service: http://IP_DEL_LXC:3000
  - service: http_status:404
```

```bash
systemctl restart cloudflared
```

Y en el dashboard de Cloudflare (Zero Trust → Networks → Tunnels también vale si gestionas el túnel desde la web): añade el hostname público `notas.tudominio.com` → `http://IP_DEL_LXC:3000`.

## Zero Trust (Cloudflare Access)

La app puede apoyarse solo en Zero Trust delante del dominio, o además (o en su lugar) exigir **login con GitHub** (ver más abajo). Si usas Access, asegúrate de tener una aplicación cubriendo `notas.tudominio.com` con tu política habitual (por ejemplo, tu email de Google).

La app leerá la cabecera `Cf-Access-Authenticated-User-Email` y mostrará tu usuario abajo a la izquierda.

### Enlaces públicos de compartir

Los enlaces de "Compartir" (`/share/<token>`) son de solo lectura y usan tokens aleatorios no adivinables, pero Cloudflare Access bloqueará a los visitantes anónimos. Para que funcionen, crea en Zero Trust → Access → Applications una aplicación adicional **con política Bypass** para estas rutas:

- `notas.tudominio.com/share/*`
- `notas.tudominio.com/api/share/*`
- `notas.tudominio.com/files/*` (para que se vean adjuntos e imágenes)
- `notas.tudominio.com/assets/*` (JS/CSS del frontend)

> Nota: `files/*` queda accesible para cualquiera que tenga la URL exacta del archivo (IDs aleatorios de 21 caracteres, mismo modelo que los enlaces de S3 de Notion). Si no vas a usar enlaces públicos, no crees el bypass y todo queda 100 % detrás de Access.

## Flujo de trabajo con Claude

1. En tu PC de IA, copia la respuesta de Claude (botón "Copy" de la interfaz, que copia Markdown).
2. Pega en una página de NoNotion: títulos, listas, tablas y bloques de código quedan formateados con resaltado de sintaxis.
3. Adjunta los archivos generados (scripts, datasets, etc.) arrastrándolos a la página.
4. Si quieres pasárselo a alguien, activa el enlace público de esa página.

### Aún más rápido: el CLI `nonotion-send`

Copia el script `cli/nonotion-send.sh` a tu PC de IA (`~/.local/bin/nonotion-send`, `chmod +x`) y configura:

```bash
export NONOTION_URL=https://notas.tudominio.com
# Solo si llamas a través del túnel (recomendado): service token de Access
export CF_ACCESS_CLIENT_ID=xxxx.access
export CF_ACCESS_CLIENT_SECRET=yyyy
```

Y a partir de ahí:

```bash
# Copia la respuesta de Claude y:
nonotion-send "Script de backup"        # toma el portapapeles
cat respuesta.md | nonotion-send        # o por stdin; el título se deriva del primer encabezado
```

La página aparece al instante en "📥 Inbox" (o bajo `NONOTION_PARENT` si lo defines). En Windows, `cli/nonotion-send.ps1` hace lo mismo con `Get-Clipboard`.

Para crear el service token: Zero Trust → Access → Service Auth → Create Service Token, y añade una política **Service Auth** a tu aplicación de Access que lo permita. Si llamas por IP local (LAN), no hace falta nada.

## MCP: conecta Claude a NoNotion

NoNotion expone un **servidor MCP remoto** en `https://notas.tudominio.com/mcp/<token>`: Claude puede buscar, leer, crear y modificar páginas y adjuntos directamente — sin copiar y pegar. Funciona desde claude.ai, la app móvil, Claude Desktop y Claude Code.

### El token

Se genera automáticamente al arrancar y se guarda en `DATA_DIR/mcp_token` (por defecto `/var/lib/nonotion/mcp_token`). Para verlo:

```bash
cat /var/lib/nonotion/mcp_token      # o: journalctl -u nonotion | grep MCP
```

Para rotarlo: borra el archivo y reinicia (`systemctl restart nonotion`).

> ⚠️ **La URL es la credencial**: quien tenga `https://.../mcp/<token>` puede leer y escribir todo tu workspace. No la compartas ni la pegues en sitios públicos.

### Cloudflare Access

Los clientes MCP no pueden pasar el login de Zero Trust, así que crea una aplicación en Access con política **Bypass** para `notas.tudominio.com/mcp/*` (igual que la de `/share/*`). La protección real es el token de la URL.

### Registrar el conector

- **claude.ai / Claude Desktop / app móvil**: Ajustes → Conectores → *Add custom connector* → pega `https://notas.tudominio.com/mcp/<token>`.
- **Claude Code**:

  ```bash
  claude mcp add --transport http nonotion https://notas.tudominio.com/mcp/<token>
  ```

### Herramientas disponibles

| Herramienta | Qué hace |
| --- | --- |
| `search_pages` / `list_pages` | Buscar por texto / ver el árbol completo |
| `read_page` | Leer una página en Markdown + sus adjuntos |
| `create_page` | Crear página (Markdown, fecha y emoji opcionales; sin padre → Inbox) |
| `append_to_page` | Añadir al final sin tocar lo existente (la habitual) |
| `edit_page` | Sustituir un fragmento exacto del Markdown |
| `update_page` | Reescribir contenido/título/icono/fecha (queda versión anterior en el historial) |
| `trash_page` | Mover a la papelera (reversible; no existe borrado definitivo vía MCP) |
| `read_attachment` | Leer el contenido de un adjunto: extrae texto de PDF/Word/Excel/PowerPoint, muestra imágenes y archivos de texto/código |
| `read_document_pages` | Renderiza páginas concretas de un PDF/documento como imágenes (escaneados, diagramas, tablas con formato) |
| `attach_file` | Subir un archivo (código generado, configs…) a una página; rechaza binarios incompletos |
| `list_tags` / `tag_page` | Ver las etiquetas existentes / añadir o quitar etiquetas de una página |

### Skill recomendada

En `skills/nonotion/SKILL.md` hay una skill lista para tu Claude: cópiala a `~/.claude/skills/nonotion/` (Claude Code) o añádela como skill en claude.ai. Define el flujo de trabajo conversacional: Claude **solo escribe cuando tú se lo pides**, mantiene una *página de trabajo* por conversación y la amplía (`append_to_page`) o retoca (`edit_page`) en vez de crear páginas nuevas a cada respuesta.

## API

| Método | Ruta | Descripción |
| --- | --- | --- |
| GET | `/api/pages` | Árbol de páginas |
| POST | `/api/pages` | Crear página (`parent_id` opcional) |
| GET/PUT/DELETE | `/api/pages/:id` | Leer / actualizar / mover a papelera (recursivo) |
| POST | `/api/files` | Subir archivo (multipart, `page_id`; hasta 100 MB tras Cloudflare) |
| POST | `/api/uploads` | Iniciar subida por trozos (`{name, size, mime, page_id}`) |
| PUT | `/api/uploads/:id?offset=N` | Enviar un trozo en su posición (409 + `received` si hay desfase) |
| GET | `/api/uploads/:id` | Cuánto ha llegado (para reanudar) |
| POST | `/api/uploads/:id/complete` | Cerrar la subida y adjuntar el archivo |
| GET/POST/DELETE | `/api/trash/files…` | Papelera de adjuntos: listar / restaurar / eliminar |
| GET | `/files/:id/:nombre` | Descargar / ver archivo |
| GET | `/files/:id/preview` | Documento de oficina convertido a PDF (LibreOffice, con caché) |
| GET | `/files/:id/sheets` | Hoja de cálculo como JSON para el visor (hojas, celdas con formato, combinadas, anchos) |
| GET | `/api/tags` | Etiquetas con número de páginas |
| PUT | `/api/pages/:id/tags` | Fijar las etiquetas de una página (`{tags: [...]}`) |
| PATCH/DELETE | `/api/tags/:nombre` | Color / renombrar (fusiona) · borrar etiqueta |
| GET | `/api/tagged?tags=a,b&mode=all\|any` | Páginas con esas etiquetas y sus adjuntos |
| GET | `/api/pages/:id/backlinks` | Páginas que enlazan a esta |
| POST | `/api/pages/:id/prefs` | Favorita / ancho completo (`{favorite?, full_width?}`); no crea versión ni cambia la revisión |
| GET | `/api/search?q=` | Búsqueda full-text |
| POST/DELETE | `/api/pages/:id/share` | Activar / desactivar enlace público |
| GET | `/api/share/:token` | Página compartida (pública) |
| POST | `/api/capture` | Crear página desde Markdown (`{markdown, title?, parent_id?}`) |
| POST | `/api/pages/:id/move` | Mover en el árbol (`{parent_id, index}`) |
| POST | `/api/pages/:id/duplicate` | Duplicar subárbol con archivos |
| GET | `/api/pages/:id/versions` | Historial de versiones |
| POST | `/api/pages/:id/restore-version/:vid` | Restaurar una versión |
| GET/DELETE | `/api/trash` | Listar / vaciar papelera |
| POST | `/api/trash/:id/restore` | Restaurar de la papelera |
| DELETE | `/api/trash/:id` | Eliminar definitivamente |
| GET | `/api/export` | ZIP con todo el workspace (Markdown + archivos) |
| GET | `/api/calendar?from=&to=` | Actividad y páginas con fecha por día (YYYY-MM-DD) |
| GET | `/api/pages/:id/markdown` | Página convertida a Markdown + adjuntos |
| POST | `/api/pages/:id/append` | Añadir Markdown al final (con snapshot de versión) |
| POST | `/mcp/:token` | Servidor MCP remoto (Streamable HTTP) |

Útil para automatizar: por ejemplo, un script en tu PC de IA puede crear páginas con respuestas de Claude vía `POST /api/pages` + `PUT` con el contenido (las llamadas dentro de la red de Zero Trust pueden usar un [service token de Access](https://developers.cloudflare.com/cloudflare-one/identity/service-tokens/)).

## Copias de seguridad y protección contra pérdidas

Todo el estado está en `DATA_DIR` (por defecto `/var/lib/nonotion`):

- `nonotion.db` — páginas y metadatos (SQLite, modo WAL)
- `files/` — archivos subidos (nunca se modifican, solo se añaden)
- `backups/db/` — instantáneas de la BD hechas por la propia app
- `backups/pre-update/` — copia de la BD justo antes de cada actualización con `install.sh`

### Capas de protección

| Riesgo | Protección |
| --- | --- |
| Se cae la red mientras escribes | El autoguardado reintenta solo (2 s, 4 s, 8 s… hasta 30 s) y vuelve a intentarlo al recuperar la conexión |
| Cierras la pestaña, se cuelga el navegador o caduca la sesión | Todo cambio no confirmado vive también en el navegador (`localStorage`); al volver a abrir la página se ofrece **Recuperar** |
| Cerrar con cambios pendientes o subidas en curso | El navegador avisa antes de cerrar |
| Dos dispositivos (o Claude) editan la misma página | Si guardas sobre una versión que otro cambió, la suya se guarda en el historial antes (control por revisión): nunca se pisa sin copia |
| Escrituras de Claude/MCP o scripts | Siempre dejan versión previa en el historial |
| Borrar un adjunto por error | Va a la papelera 30 días (🗑 Papelera → Archivos adjuntos) |
| Corrupción o error grave | Instantánea consistente de la BD cada hora con cambios (48 horarias + 30 diarias) |
| Fallo del disco del servidor | El host Proxmox copia cada hora `files/` y las instantáneas a otro dispositivo (`deploy/proxmox-offsite-backup.sh`) |

Además, `vzdump` de Proxmox sigue haciendo la copia completa del contenedor.

### Restaurar la base de datos

```bash
systemctl stop nonotion
cp /var/lib/nonotion/nonotion.db /root/nonotion-antes-de-restaurar.db   # por si acaso
rm -f /var/lib/nonotion/nonotion.db-wal /var/lib/nonotion/nonotion.db-shm
cp /var/lib/nonotion/backups/db/nonotion-AAAA-MM-DD-HH-MM.db /var/lib/nonotion/nonotion.db
chown nonotion:nonotion /var/lib/nonotion/nonotion.db
systemctl start nonotion
```

Si el disco entero se perdiera: la copia externa (`nonotion/db/` y `nonotion/files/` en el router) contiene todo lo necesario; se reinstala NoNotion, se copian `files/` a `/var/lib/nonotion/files/` y la instantánea más reciente como `nonotion.db`.

## Subida de archivos grandes

Cloudflare rechaza cualquier petición de más de **100 MB**. La app sube por eso los archivos en trozos de 8 MB, cada uno escrito en su posición exacta y confirmado en disco: si la conexión falla, se pregunta al servidor cuánto llegó y se continúa desde ahí, sin repetir ni corromper nada. No hay límite de tamaño más allá del disco. Funciona igual al pegar o arrastrar archivos dentro del editor.

## Login con GitHub

Además (o en lugar) de Cloudflare Access, NoNotion puede exigir login con GitHub y dejar entrar solo a los usuarios que indiques.

1. Crea una OAuth App en <https://github.com/settings/applications/new>:
   - **Application name**: NoNotion
   - **Homepage URL**: `https://notas.tudominio.com`
   - **Authorization callback URL**: `https://notas.tudominio.com/auth/github/callback`
2. Genera un *client secret* y rellena `/etc/nonotion.env` en el servidor (plantilla en `deploy/nonotion.env.example`):

   ```bash
   PUBLIC_URL=https://notas.tudominio.com
   GITHUB_CLIENT_ID=Ov23li...
   GITHUB_CLIENT_SECRET=...
   AUTH_ALLOWED_GITHUB_USERS=tu-usuario
   ```

3. `systemctl restart nonotion`. En el log verás `Login con GitHub activo`.

Cómo funciona:

- Sesiones de 30 días (se renuevan al usarla), guardadas en SQLite solo como hash; cookie `HttpOnly`, `Secure`, `SameSite=Lax`. Botón **Salir** abajo a la izquierda.
- Solo se pide el permiso `read:user` (saber quién eres). El token de GitHub no se guarda.
- Quitar a alguien de `AUTH_ALLOWED_GITHUB_USERS` y reiniciar le corta el acceso aunque tenga sesión.
- Si la configuración queda a medias, la app **se bloquea** (falla cerrada), nunca queda abierta.
- Las escrituras con sesión deben venir de tu propio dominio (protección CSRF).
- Siguen públicos: el conector MCP (`/mcp/<token>`), los enlaces de compartir y los adjuntos de páginas compartidas.
- Los scripts (`nonotion-send`) usan el token de API: `export NONOTION_TOKEN=$(cat /var/lib/nonotion/mcp_token)`.

Con el login de GitHub activo puedes **quitar Cloudflare Access** del dominio principal (y las reglas Bypass de `/share/*`, `/files/*`, `/assets/*` y `/mcp/*`): la app ya protege cada ruta. O mantener ambos como doble capa.

## API