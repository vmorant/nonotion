# NoNotion 🗂️

Webapp autoalojada tipo Notion, **sin límites de capacidad**: tus apuntes, respuestas de IA (Claude) y archivos viven en tu propio servidor (pensada para un LXC de Proxmox detrás de un túnel de Cloudflare), con login de GitHub y un conector MCP para que Claude lea y escriba directamente.

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
- **Organiza arrastrando** — arrastra páginas en el árbol para reordenarlas o anidarlas, o usa **Mover a…** en su menú ⋯ para elegir el destino con buscador; duplica páginas (subárbol y archivos incluidos) con un clic. Claude reorganiza igual con `move_page` / `move_pages` (misma lógica y validaciones).
- **Visor de documentos integrado** — clic en un adjunto y se abre dentro de NoNotion: PDF, imágenes, vídeo, audio y texto/código directamente, y **Word, Excel y PowerPoint** convertidos a PDF en el servidor con LibreOffice (con caché: la primera apertura tarda unos segundos, las siguientes son instantáneas). Nada sale de tu servidor — sin visores de Google/Microsoft.
- **Visor de Excel de verdad** — los `.xlsx`, `.xls`, `.ods` y `.csv` se abren como hoja de cálculo: pestañas de hojas (las ocultas en cursiva), cabecera de columnas y números de fila fijos, celdas combinadas, anchos de columna del original y buscador que filtra filas. Si quieres ver el formato de impresión, "Ver como PDF" usa la conversión de LibreOffice. Claude (MCP `read_attachment`) recibe todas las hojas completas en CSV.
- **Índice lateral y secciones plegables** — en páginas con 3 o más encabezados aparece un índice a la derecha que resalta la sección visible y salta a cada una. Cada encabezado tiene un triángulo para plegar su sección (solo visual: el contenido se guarda y exporta entero; lo plegado se recuerda por página en el navegador).
- **Tablas cómodas** — cabecera fija al desplazarte, scroll horizontal en tablas anchas, columnas redimensionables arrastrando el borde, y una barra sobre la tabla para ordenar filas por la columna actual (entiende números como `1.234,5`), añadir/quitar filas y columnas y **copiar la tabla para pegarla en Excel**. Al pegar Markdown de Claude, los `<br>` de las celdas se convierten en saltos de línea.
- **Tablas avanzadas (como el plugin *Advanced Tables* de Obsidian)** — con el cursor en una tabla aparece abajo un panel de controles (`Ctrl+Mayús+D` lo oculta/muestra):
  - **Navegación tipo Excel**: `Tab`/`Mayús+Tab` celda siguiente/anterior (en la última, crea fila), `Enter` baja a la fila siguiente en la misma columna (en la última, crea fila), `Mayús+Enter` salto de línea dentro de la celda.
  - **Crear tablas escribiendo**: `| Columna 1 | Columna 2` y `Enter` (o `Tab` para añadir otra columna).
  - **Mover** filas (`Alt+Mayús+↑↓`) y columnas (`Alt+Mayús+←→`), **alinear** columnas (izquierda/centro/derecha), ordenar, añadir/quitar filas y columnas.
  - **Fórmulas de hoja de cálculo** con el mismo motor y sintaxis que Advanced Tables ([sintaxis](https://github.com/tgrosinger/md-advanced-tables/blob/main/docs/formulas.md)): `@>$2=sum(@I..@-1)`, `mean`, `if`, operaciones, `;%.2f`, horas `;hm`… Botón **ƒx** para escribirlas y **↻ Calcular** para recalcular. Entiende números en formato español (`1.234,5`) y devuelve los resultados en el mismo formato.
  - **Exportar a CSV** (Excel en español lo abre directo) y copiar para pegar en Excel.
  - En Markdown (exportar, Claude) las tablas salen **alineadas** con la fila de alineación (`:---:`) y las fórmulas como `<!-- TBLFM: … -->`: compatible con Obsidian en ambos sentidos (pegar Markdown de Obsidian con fórmulas también funciona).
- **Ancho completo por página** — botón ↔ para usar todo el ancho de la pantalla (se guarda en la página, igual en todos tus dispositivos).
- **Favoritas y recientes** — ★ en una página (o en su menú ⋯ del árbol) la fija arriba en la barra lateral; "Recientes" muestra las últimas páginas que abriste en ese navegador.
- **Enlaces que se abren** — clic en un enlace: burbuja con *Abrir* (páginas de NoNotion se abren dentro de la app; adjuntos en el visor), *Pestaña nueva*, *Vista previa* de webs externas (si la web permite mostrarse dentro de otra), editar y quitar. `Ctrl/⌘+clic` o clic central abren directamente en pestaña nueva.
- **Enlaces entre páginas** — escribe `[[` (o `/enlace`) para buscar una página y enlazarla; pegar la URL de una página de NoNotion la convierte en enlace con su título. Cada página muestra abajo "↩ Enlazada desde" con las páginas que la enlazan.
- **Etiquetas** — clasifica cada página con etiquetas de colores (siempre en minúsculas, sin distinguir mayúsculas) (bajo el título, con autocompletado). La vista **🏷 Etiquetas** filtra por una o varias (todas / alguna), lista también los adjuntos de esas páginas y tiene un filtro "Sin etiquetar" para ir clasificando. Renombrar (fusiona si ya existe), cambiar color o borrar desde su menú ⋯. En la búsqueda `Ctrl+K`, `#etiqueta` filtra resultados. Claude las lee y, si se lo pides, las aplica (`list_tags`, `tag_page`).
- **Imágenes ágiles** — al pegar o arrastrar, la imagen aparece al instante donde la sueltas con la subida avanzando encima. Redimensiona arrastrando los tiradores laterales, o con la barra al seleccionarla (25/50/75/100 %, original), alinéala a izquierda/centro/derecha, y ábrela a tamaño completo con doble clic. El tamaño se guarda en la página y se respeta cuando Claude la edita.
- **Export ZIP completo** — descarga todo el workspace como Markdown + archivos adjuntos con enlaces relativos: backup portable, cero lock-in.
- **Calendario propio (sin integraciones externas)** — vista mensual y semanal que muestra qué páginas creaste y editaste cada día (registro de actividad interno): de un vistazo ves en qué trabajaste y qué días no. Los datos antiguos se reconstruyen automáticamente desde el historial de versiones.
- **Reuniones** — asigna una fecha a cualquier página y queda fijada ese día en el calendario (también fechas futuras). El botón "+" de un día crea una página de reunión con plantilla (asistentes, agenda, notas, acciones), y el comando `/reunión` inserta la misma plantilla en cualquier página.
- **Claude conectado (MCP)** — Claude (claude.ai, app móvil, Desktop, Claude Code) busca, lee, crea y edita páginas y lee los adjuntos (PDF, Office, Excel, imágenes) sin copiar y pegar. Ver [MCP](#mcp-conecta-claude-a-nonotion).
- **Sincronización en vivo** — si cambias una página en otro dispositivo, o la cambia Claude, se actualiza sola sin recargar (si estás escribiendo en ella, te avisa en vez de pisarte).
- **Subidas sin límite de tamaño** — los archivos se suben en trozos reanudables con barra de progreso (Cloudflare corta en 100 MB por petición; así no aplica).
- **Grafo de notas (como el Graph view de Obsidian)** — **🕸 Grafo** en la barra lateral: cada página es un círculo y cada enlace interno una línea; cuantas más páginas la enlazan, más grande. Pasar el ratón resalta sus conexiones, clic abre (Ctrl/⌘+clic en pestaña nueva, clic derecho: menú), arrastra nodos o el lienzo, zoom con rueda o `+`/`-` y flechas para desplazarte. Ajustes (⚙): filtros (búsqueda, etiquetas, adjuntos, huérfanas y la jerarquía del árbol), **grupos de color** por texto o `#etiqueta`, visualización (flechas, umbral de texto, tamaño de nodo, grosor de enlace, **animación** en orden de creación) y fuerzas (centro, repulsión, enlace, distancia). En cada página, el botón de **grafo local** muestra sus vecinas con profundidad ajustable (entrantes, salientes y enlaces entre vecinas).
- **Seguimiento (bloqueos, problemas, riesgos, tareas…)** — una sección aparte del árbol para seguir en el tiempo lo que hay que resolver en un proyecto. Cada elemento tiene clave por espacio (**AXA-12**, prefijo editable en Ajustes del espacio), tipo (bloqueo, problema, riesgo, tarea, decisión, pregunta), estado (abierto → en curso → bloqueado → resuelto → cerrado), prioridad, responsable (usuario de GitHub o texto libre, p. ej. «Equipo AXA»), fecha límite e hito, y su descripción se escribe con el editor normal. **Relaciones con tipo**: *bloquea a* (y *bloqueado por*), *relacionado con*, *documentado en* una página y *viene de* (idea, acta, página); escribir `AXA-12` en cualquier página lo enlaza con su estado, y cada página muestra sus elementos. **Cronología** con quién y cuándo de cada cambio, relación y comentario (también los de Claude). Vistas de **lista con filtros**, **tablero por estado** (arrastrar cambia el estado) y **bloqueos** (qué está parado, por qué y qué frena). Se crean desde la vista, desde cualquier página (la selección como título) o desde una idea, que lo registra como resultado. En el grafo son triángulos de color según estado y los bloqueos se ven en rojo. Claude: `list_issues`, `create_issue`, `update_issue`, `link_issue`.
- **Ideas (desarrollo de ideas)** — una zona aparte del árbol de notas para lo que todavía no sabe dónde vive: una captura de pantalla, un texto pegado, una lista de temas, un enlace o un fragmento seleccionado en cualquier página (botón 💡 «Desarrollar como idea»). Cada idea separa tres cosas que no se mezclan: la **semilla** (lo que llegó, tal cual; las capturas pasan por OCR para poder buscarlas), el **desarrollo** (pasos fechados: preguntas, hipótesis, decisiones, descartes, esquema; tuyos o de Claude) y el **resultado** (dónde se materializó: páginas, diagramas en canvas, planning fijado en el calendario, archivos o documentos externos como Google Docs). Un tablero por estado (semilla → en desarrollo → documentada → archivada), «Desarrollar con Claude» (te da el prompt para claude.ai con el conector; Claude lee la idea con sus capturas, pregunta y deja los pasos y resultados solo cuando se lo pides) y trazabilidad en el grafo y en los backlinks entre la idea y lo que salió de ella. Botones para crear desde la idea un documento, un diagrama o un planning ya enlazados. Claude: `list_ideas`, `create_idea`, `develop_idea`, `materialize_idea`.
- **Canvas (como Obsidian Canvas)** — lienzos infinitos en formato abierto **JSON Canvas** (se exportan como `.canvas` y se abren en Obsidian). Tarjetas de texto en Markdown (doble clic en el canvas), páginas de NoNotion con su contenido, imágenes y archivos, webs y grupos; arrastra páginas del árbol, archivos del ordenador o enlaces del navegador. Conecta tarjetas desde sus bordes (con etiqueta, dirección y color; soltar en vacío crea una tarjeta conectada), selecciona con Mayús o recuadro, mueve con ajuste a la cuadrícula (Espacio lo desactiva, Mayús fija el eje, Alt duplica), redimensiona, alinea/organiza/reparte, agrupa, colorea, convierte una tarjeta en página, deshacer/rehacer, zoom (encajar `Mayús+1`, a la selección `Mayús+2`), ir a un grupo y modo solo lectura. Un canvas es una página más (árbol, papelera, historial, compartir, búsqueda y backlinks) y Claude lo lee y lo edita (`create_canvas`, `update_canvas`).
- **Espacios (varios proyectos)** — una sola instancia con varios espacios separados (por ejemplo, un cliente y otro proyecto), cada uno con sus páginas, archivos, etiquetas, papelera, calendario, miembros y conector de Claude. Selector arriba a la izquierda. Ver [Espacios](#espacios-varios-proyectos-y-equipos).
- **Login con GitHub** — solo entran los usuarios de GitHub que autorices; compatible con Cloudflare Access como segunda capa (o sin él). Ver [Login con GitHub](#login-con-github).
- **Diseño propio** — interfaz estilo Obsidian con la marca NoNotion (negro, blanco y azul eléctrico), tema oscuro, claro o el del sistema (botón abajo a la izquierda), iconos Lucide y tipografías Inter y JetBrains Mono servidas desde tu propio servidor.
- **Autoguardado a prueba de cortes** — todo se guarda solo mientras escribes; si se cae la red o se cierra el navegador, nada se pierde (ver [protección contra pérdidas](#copias-de-seguridad-y-protección-contra-pérdidas)).

## Stack

- **Backend**: Node.js 20 + Express + SQLite (better-sqlite3, modo WAL). Los archivos se guardan directamente en disco.
- **Frontend**: React + Vite + Tiptap (ProseMirror) con `tiptap-markdown` y `lowlight` para sintaxis.
- **Sin Docker, sin Postgres, sin S3**: un solo proceso, una carpeta de datos. Backup = copiar `/var/lib/nonotion`.

## Desarrollo local

```bash
npm install
npm run build        # compila el frontend (client/dist)
npm run dev          # servidor en http://localhost:3000
npm test             # prueba del editor + tests del servidor (node --test server/test/)
```

Para desarrollo con recarga del frontend:

```bash
npm run dev                      # terminal 1: API en :3000
cd client && npm run dev         # terminal 2: Vite en :5173 con proxy a la API
```

## Ramas y cambios

- **`main`** es la rama estable: lo que hay en `main` es lo que corre en el servidor.
- Cada cambio se hace en una rama propia (`feature/…`, `fix/…`) y entra en `main` mediante un **pull request** que pase `npm test`.
- Al fusionar: se despliega desde `main` y se borra la rama del cambio.
- Antes de desplegar algo que toque la base de datos: snapshot del contenedor (o `backups/pre-update/`, que `install.sh` crea solo).

## Instalación en el LXC de Proxmox

Recomendado: LXC Debian 12, 2 vCPU, **2 GB de RAM** (LibreOffice convierte los documentos de Office para el visor; con 1 GB funciona, pero los documentos grandes van justos) y el disco que quieras para tus archivos.

```bash
# Dentro del contenedor, como root:
apt-get update && apt-get install -y git
git clone -b main https://github.com/vmorant/nonotion.git /root/nonotion
cd /root/nonotion
bash deploy/install.sh
```

El script instala Node 20, LibreOffice y poppler (visor y lectura de documentos), compila el frontend, crea el usuario de servicio `nonotion`, instala la app en `/opt/nonotion`, los datos en `/var/lib/nonotion`, crea `/etc/nonotion.env` a partir de la plantilla (ver [Login con GitHub](#login-con-github)) y deja un servicio systemd arrancado y comprobado:

```bash
systemctl status nonotion
journalctl -u nonotion -f
```

Para actualizar más adelante:

```bash
cd /root/nonotion && git checkout main && git pull --ff-only && bash deploy/install.sh
```

El servidor se despliega siempre desde `main` (ver [Ramas y cambios](#ramas-y-cambios)).

(Los datos en `/var/lib/nonotion` nunca se tocan; antes de cada actualización se guarda una copia de la base de datos en `backups/pre-update/`.)

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

Opcional si usas el [login con GitHub](#login-con-github) (que ya protege cada ruta); útil como segunda capa. Si usas Access, crea una aplicación cubriendo `notas.tudominio.com` con tu política habitual (por ejemplo, tu email de Google). Sin login de GitHub, la app muestra el usuario de Access leyendo la cabecera `Cf-Access-Authenticated-User-Email`.

> ⚠️ Sin login de GitHub **y** sin Access, cualquiera con la URL entra: configura al menos uno de los dos.

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
export NONOTION_TOKEN=...      # contenido de /var/lib/nonotion/mcp_token (obligatorio con login GitHub)
# Solo si además tienes Cloudflare Access delante: service token de Access
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

Si usas Cloudflare Access, crea el service token en Zero Trust → Access → Service Auth → Create Service Token y añade una política **Service Auth** a tu aplicación de Access que lo permita.

## MCP: conecta Claude a NoNotion

NoNotion expone un **servidor MCP remoto** en `https://notas.tudominio.com/mcp/<token>`: Claude puede buscar, leer, crear y modificar páginas y adjuntos directamente — sin copiar y pegar. Funciona desde claude.ai, la app móvil, Claude Desktop y Claude Code.

### El token

Cada espacio tiene sus conectores (uno por persona) en **⚙ Ajustes del espacio → Conector de Claude**: ahí se crean, se copian y se revocan. Además existe el token histórico del espacio inicial, que se genera al arrancar en `DATA_DIR/mcp_token` (por defecto `/var/lib/nonotion/mcp_token`). Para verlo:

```bash
cat /var/lib/nonotion/mcp_token      # o: journalctl -u nonotion | grep MCP
```

Para rotarlo: borra el archivo y reinicia (`systemctl restart nonotion`).

> ⚠️ **La URL es la credencial**: quien tenga `https://.../mcp/<token>` puede leer y escribir todo el espacio de ese conector. No la compartas ni la pegues en sitios públicos.

### Cloudflare Access

Solo si usas Access: los clientes MCP no pueden pasar el login de Zero Trust, así que crea una aplicación en Access con política **Bypass** para `notas.tudominio.com/mcp/*` (igual que la de `/share/*`). La protección real es el token de la URL. Con el login de GitHub, `/mcp/<token>` ya queda accesible solo con el token.

### Registrar el conector

- **claude.ai / Claude Desktop / app móvil**: Ajustes → Conectores → *Add custom connector* → pega `https://notas.tudominio.com/mcp/<token>`.
- **Claude Code**:

  ```bash
  claude mcp add --transport http nonotion https://notas.tudominio.com/mcp/<token>
  ```

### Herramientas disponibles

| Herramienta | Qué hace |
| --- | --- |
| `search_pages` / `list_pages` | Buscar por texto y/o etiquetas / ver el árbol completo con etiquetas |
| `read_page` | Leer una página en Markdown + sus adjuntos |
| `create_page` | Crear página (Markdown; fecha, emoji y etiquetas opcionales; sin padre → Inbox) |
| `append_to_page` | Añadir al final sin tocar lo existente (la habitual) |
| `edit_page` | Sustituir un fragmento exacto del Markdown |
| `update_page` | Reescribir contenido/título/icono/fecha (queda versión anterior en el historial) |
| `trash_page` | Mover a la papelera (reversible; no existe borrado definitivo vía MCP) |
| `move_page` | Mover una página (con sus subpáginas) bajo otro padre o a la raíz, con posición opcional (`position`, `before_id`, `after_id`); no cambia contenido, etiquetas ni ids |
| `move_pages` | Varios movimientos en una sola llamada, atómicos: si uno no es válido no se aplica ninguno |
| `create_canvas` / `update_canvas` | Crear un canvas o reemplazar su contenido (JSON Canvas: tarjetas text/file/link/group y conexiones); `read_page` de un canvas devuelve su resumen y su JSON |
| `list_issues` / `create_issue` / `update_issue` / `link_issue` | Seguimiento: listar con filtros (estado, tipo, prioridad, responsable, solo bloqueos), crear (con relaciones y desde una idea), cambiar campos o comentar (queda en la cronología) y relacionar o quitar relaciones. Los elementos se nombran por clave (`AXA-12`) o id; `read_page` de un elemento devuelve campos, descripción, relaciones y cronología |
| `list_ideas` / `create_idea` / `develop_idea` / `materialize_idea` | Ideas fuera del árbol: listar por estado, guardar una semilla (texto, enlace, fragmento de página; las capturas se adjuntan con `attach_file`), añadir pasos de desarrollo (pregunta, hipótesis, decisión, descarte, esquema) y registrar dónde se materializó (página, canvas, planning, archivo o documento externo). `read_page` de una idea devuelve semilla (con OCR), desarrollo y resultado |
| `read_attachment` | Leer el contenido de un adjunto: texto de PDF/Word/PowerPoint, hojas de Excel/ODS/CSV completas en CSV, imágenes y archivos de texto/código |
| `read_document_pages` | Renderiza páginas concretas de un PDF/documento como imágenes (escaneados, diagramas, tablas con formato) |
| `attach_file` | Subir un archivo (código generado, configs…) a una página; rechaza binarios incompletos |
| `list_tags` / `tag_page` | Ver las etiquetas existentes / añadir o quitar etiquetas de una página (en minúsculas: `Pegasus` = `pegasus`) |

### Skill recomendada

En `skills/nonotion/SKILL.md` hay una skill lista para tu Claude: cópiala a `~/.claude/skills/nonotion/` (Claude Code) o añádela como skill en claude.ai. Define el flujo de trabajo conversacional: Claude **solo escribe cuando tú se lo pides**, mantiene una *página de trabajo* por conversación y la amplía (`append_to_page`) o retoca (`edit_page`) en vez de crear páginas nuevas a cada respuesta.

## API

| Método | Ruta | Descripción |
| --- | --- | --- |
| GET | `/api/pages` | Árbol de páginas |
| POST | `/api/pages` | Crear página (`parent_id` opcional; `kind: "canvas"` con `content` JSON Canvas para un canvas; `kind: "idea"` con `content` `{ type: "idea", seeds, … }` para una idea, siempre sin padre) |
| GET | `/api/issues` | Elementos de seguimiento del espacio con su clave, campos y recuentos (filtros: `status` (o `active`), `type`, `priority`, `assignee`, `tag`, `blocked=true`, `q`, `key`) |
| POST | `/api/issues` | Crear elemento: `title`, `type`, `status`, `priority`, `assignee`, `due_date`, `milestone`, `description` (Markdown), `links: [{type, target}]`, `tags`, `from_idea_id` |
| GET / PATCH | `/api/pages/:id/issue` | Detalle (campos, relaciones, menciones, cronología) / cambiar campos y `comment` |
| POST / DELETE | `/api/pages/:id/issue/links` (`/:linkId`) | Añadir relación `{type: blocks\|relates\|documents\|origin, target: id o clave}` / quitarla |
| GET | `/api/pages/:id/issues` | Elementos que relacionan o menciona una página cualquiera |
| GET | `/api/ideas` | Ideas del espacio con estado, resumen corto y resultados (la vista Ideas) |
| POST | `/api/pages/:id/idea` | Parche de una idea: `status`, `summary`, `title`, `seeds_add`/`steps_add`/`outcomes_add`, `*_update`, `remove`. Las semillas de imagen pasan por OCR (tesseract) |
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
| GET | `/api/pages/:id/backlinks` | Páginas que enlazan a esta (también desde canvas) |
| GET | `/api/graph` | Grafo del espacio: páginas, enlaces internos, etiquetas y adjuntos |
| GET/POST | `/api/workspaces` | Espacios accesibles / crear espacio (propietarios) |
| PATCH/DELETE | `/api/workspaces/:id` | Renombrar / borrar (solo vacío) |
| GET | `/api/workspaces/:id/members` | Miembros del espacio |
| PUT/DELETE | `/api/workspaces/:id/members/:login` | Añadir o cambiar rol (`{role: editor\|admin}`) / quitar |
| GET/POST | `/api/workspaces/:id/tokens` | Conectores de Claude del espacio / crear el tuyo |
| DELETE | `/api/workspaces/:id/tokens/:prefijo` | Revocar un conector |
| POST | `/api/pages/:id/prefs` | Favorita / ancho completo (`{favorite?, full_width?}`); no crea versión ni cambia la revisión |
| GET | `/api/search?q=` | Búsqueda full-text |
| POST/DELETE | `/api/pages/:id/share` | Activar / desactivar enlace público |
| GET | `/api/share/:token` | Página compartida (pública) |
| POST | `/api/capture` | Crear página desde Markdown (`{markdown, title?, parent_id?, page_date?, icon?, tags?}`) |
| POST | `/api/pages/:id/move` | Mover en el árbol con su subárbol (`{parent_id, index? \| before_id? \| after_id?}`; sin posición, al final) |
| POST | `/api/move-pages` | Varios movimientos atómicos (`{moves: [{page_id, parent_id, index?, before_id?, after_id?}]}`) |
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
| POST | `/api/pages/:id/replace` | Sustituir un fragmento exacto del Markdown (`{find, replace}`; 404 si no está, 409 si es ambiguo) |
| GET | `/files/:id/text` | Texto extraído de un PDF/documento (hojas de cálculo en CSV) |
| GET | `/files/:id/page/:n` | Página `n` de un PDF/documento como PNG |
| GET | `/api/events` | Eventos en vivo (Server-Sent Events) cuando cambia el árbol o una página |
| GET | `/api/me` | Usuario de la sesión y modo de autenticación |
| GET | `/api/health` | Comprobación de salud (pública) |
| POST | `/mcp/:token` | Servidor MCP remoto (Streamable HTTP) |

Todas las rutas trabajan dentro de un espacio: con sesión, el de la cabecera `X-Workspace: <id>` (o `?ws=`); con token, el del token. Para automatizar desde scripts, autentícate con `Authorization: Bearer <token>` (un conector del espacio o el de `/var/lib/nonotion/mcp_token`). Si hay Cloudflare Access delante, añade además las cabeceras de un [service token de Access](https://developers.cloudflare.com/cloudflare-one/identity/service-tokens/).

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

## Espacios: varios proyectos y equipos

Una misma instancia puede alojar varios proyectos totalmente separados. Cada **espacio** tiene sus propias páginas, adjuntos, etiquetas, papelera, calendario, búsqueda, exportación y conector de Claude; nada de un espacio se ve desde otro.

**Quién ve qué**

| Quién | Acceso |
| --- | --- |
| **Propietarios** (`AUTH_ALLOWED_GITHUB_USERS` en `/etc/nonotion.env`) | Todos los espacios, como administradores. Solo ellos crean y borran espacios. |
| **Administrador** de un espacio | Lee y escribe en ese espacio y gestiona sus miembros. |
| **Editor** de un espacio | Lee y escribe en ese espacio. |
| Cualquier otra cuenta de GitHub | No entra. |

**Dar acceso a otro equipo**

1. Selector de espacio (arriba a la izquierda) → **+ Nuevo espacio** (solo propietarios).
2. **⚙ Ajustes del espacio** → **Miembros**: añade su usuario de GitHub como *Editor* o *Administrador*. No hace falta reiniciar ni tocar `/etc/nonotion.env`.
3. Esa persona entra en la misma URL con **Entrar con GitHub** y solo ve los espacios donde es miembro.

Quitar a alguien de un espacio le corta el acceso al momento, incluidos sus conectores de Claude de ese espacio.

**Conector de Claude por espacio**: en **⚙ Ajustes del espacio → Conector de Claude**, cada persona crea su propio conector (URL `…/mcp/<token>`), que solo ve ese espacio. Para trabajar con Claude en dos proyectos, añade un conector por proyecto. El token histórico (`/var/lib/nonotion/mcp_token`) sigue funcionando y pertenece al espacio inicial.

**Cómo está protegido**: un único guardián en el servidor resuelve a qué espacio pertenece cada página, archivo, versión, subida o etiqueta pedidos y responde *no encontrado* si no tienes acceso (también para las referencias en el cuerpo de la petición, como `parent_id`, y para los eventos en vivo). Las favoritas son de cada persona; el historial de versiones y la papelera, de cada espacio.

Al actualizar desde una versión anterior, todo lo existente pasa al espacio inicial (nombre configurable con `DEFAULT_WORKSPACE_NAME` en `/etc/nonotion.env` antes del primer arranque; después se renombra desde sus ajustes).

## Subida de archivos grandes

Cloudflare rechaza cualquier petición de más de **100 MB**. La app sube por eso los archivos en trozos de 8 MB, cada uno escrito en su posición exacta y confirmado en disco: si la conexión falla, se pregunta al servidor cuánto llegó y se continúa desde ahí, sin repetir ni corromper nada. No hay límite de tamaño más allá del disco. Funciona igual al pegar o arrastrar archivos dentro del editor.

## Login con GitHub

Además (o en lugar) de Cloudflare Access, NoNotion puede exigir login con GitHub y dejar entrar solo a los propietarios que indiques y a los miembros de cada [espacio](#espacios-varios-proyectos-y-equipos).

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
- Quitar a un propietario de `AUTH_ALLOWED_GITHUB_USERS` y reiniciar le corta el acceso aunque tenga sesión; a un miembro se le quita desde los ajustes del espacio, sin reiniciar.
- Si la configuración queda a medias, la app **se bloquea** (falla cerrada), nunca queda abierta.
- Las escrituras con sesión deben venir de tu propio dominio (protección CSRF).
- Siguen públicos: el conector MCP (`/mcp/<token>`), los enlaces de compartir y los adjuntos de páginas compartidas.
- Los scripts (`nonotion-send`) usan un token de API: el de un conector del espacio (Ajustes del espacio) o el histórico `cat /var/lib/nonotion/mcp_token` (espacio inicial).

Con el login de GitHub activo puedes **quitar Cloudflare Access** del dominio principal (y las reglas Bypass de `/share/*`, `/files/*`, `/assets/*` y `/mcp/*`): la app ya protege cada ruta. O mantener ambos como doble capa.
