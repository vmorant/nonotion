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
- **Export ZIP completo** — descarga todo el workspace como Markdown + archivos adjuntos con enlaces relativos: backup portable, cero lock-in.
- **Calendario propio (sin integraciones externas)** — vista mensual y semanal que muestra qué páginas creaste y editaste cada día (registro de actividad interno): de un vistazo ves en qué trabajaste y qué días no. Los datos antiguos se reconstruyen automáticamente desde el historial de versiones.
- **Reuniones** — asigna una fecha a cualquier página y queda fijada ese día en el calendario (también fechas futuras). El botón "+" de un día crea una página de reunión con plantilla (asistentes, agenda, notas, acciones), y el comando `/reunión` inserta la misma plantilla en cualquier página.
- **Grabación ligera de reuniones** — botón "⏺ Grabar" en cualquier página: captura pantalla + audio del sistema + micrófono desde el navegador con presets de tamaño controlado (solo audio ~20 MB/h, vídeo 720p/5fps ~90 MB/h), subida por chunks mientras grabas (resistente a caídas) y reproductor integrado. Indicador de espacio usado/libre en el sidebar.
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

La app **no tiene login propio**: se apoya en que ya tienes Zero Trust por defecto delante del dominio. Asegúrate de tener una aplicación de Access cubriendo `notas.tudominio.com` con tu política habitual (por ejemplo, tu email de Google).

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

## Grabar reuniones (Teams u otras)

El grabador vive en la propia webapp: abre la página de la reunión, pulsa **⏺ Grabar**, elige preset y graba. No necesitas OBS ni nada instalado.

| Preset | Configuración | Tamaño aprox. |
| --- | --- | --- |
| 🎙 Solo audio | Opus 48 kbps | **~20 MB/h** |
| 📺 Ligero | 720p, 5 fps, VP9 ~220 kbps | **~90 MB/h** |
| 🎬 Nítido | 720p, 15 fps, ~450 kbps | ~200 MB/h |

Consejo contra el volumen: una reunión es contenido casi estático; **solo-audio o el preset ligero cubren el 95 % de los casos**. La grabación se sube por chunks mientras grabas (si se corta algo no la pierdes), queda adjunta a la página con reproductor integrado, y el contador en vivo te muestra MB y tasa estimada.

**Con la app de escritorio de Teams** (el caso normal): en el selector del navegador elige **Pantalla completa** y marca **"Compartir también el audio del sistema"** — eso captura cualquier aplicación, incluida Teams de escritorio, más tu micrófono mezclado. Compartir una *ventana* suelta no incluye audio (limitación de Chromium). Requisitos: Chrome o Edge en Windows; el HTTPS lo pone tu túnel.

Si hay `ffmpeg` en el LXC (el instalador lo añade), las grabaciones se remuxan al guardar para que la barra de progreso/seek funcione perfecta; sin ffmpeg también se guardan y reproducen.

### Alternativa 100 % nativa: `nonotion-upload-media`

Si prefieres grabar con otra cosa (Game Bar de Windows con `Win+Alt+R`, la grabación propia de Teams, OBS…), el script `cli/nonotion-upload-media.{sh,ps1}` recomprime el archivo a formato ligero con ffmpeg y lo sube como página de reunión:

```powershell
# Windows (requiere ffmpeg: winget install ffmpeg)
.\nonotion-upload-media.ps1 reunion.mp4                 # solo audio (~20 MB/h)
.\nonotion-upload-media.ps1 reunion.mp4 -Mode light     # 720p/5fps
```

Una grabación de Game Bar de 1 GB se queda en ~20-100 MB según el modo.

### Y para el acta: Whisper + nonotion-send

El combo que menos espacio ocupa: graba **solo audio**, pásalo por Whisper en tu PC de IA y sube la transcripción/acta con `nonotion-send` a la misma página. El audio original lo puedes borrar cuando tengas el acta.

## API

| Método | Ruta | Descripción |
| --- | --- | --- |
| GET | `/api/pages` | Árbol de páginas |
| POST | `/api/pages` | Crear página (`parent_id` opcional) |
| GET/PUT/DELETE | `/api/pages/:id` | Leer / actualizar / mover a papelera (recursivo) |
| POST | `/api/files` | Subir archivo (multipart, `page_id`) |
| GET | `/files/:id/:nombre` | Descargar / ver archivo |
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
| POST | `/api/recordings/start` · `:id/chunk` · `:id/finish` | Subida de grabaciones por chunks |
| GET | `/api/stats` | Espacio usado (archivos + BD) y libre en disco |

Útil para automatizar: por ejemplo, un script en tu PC de IA puede crear páginas con respuestas de Claude vía `POST /api/pages` + `PUT` con el contenido (las llamadas dentro de la red de Zero Trust pueden usar un [service token de Access](https://developers.cloudflare.com/cloudflare-one/identity/service-tokens/)).

## Copias de seguridad

Todo el estado está en `DATA_DIR` (por defecto `/var/lib/nonotion`):

- `nonotion.db` — páginas y metadatos (SQLite, modo WAL)
- `files/` — archivos subidos

Un snapshot del LXC desde Proxmox, o un `rsync` de esa carpeta, es un backup completo.
