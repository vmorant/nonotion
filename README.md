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

## API

| Método | Ruta | Descripción |
| --- | --- | --- |
| GET | `/api/pages` | Árbol de páginas |
| POST | `/api/pages` | Crear página (`parent_id` opcional) |
| GET/PUT/DELETE | `/api/pages/:id` | Leer / actualizar / eliminar (recursivo) |
| POST | `/api/files` | Subir archivo (multipart, `page_id`) |
| GET | `/files/:id/:nombre` | Descargar / ver archivo |
| GET | `/api/search?q=` | Búsqueda full-text |
| POST/DELETE | `/api/pages/:id/share` | Activar / desactivar enlace público |
| GET | `/api/share/:token` | Página compartida (pública) |

Útil para automatizar: por ejemplo, un script en tu PC de IA puede crear páginas con respuestas de Claude vía `POST /api/pages` + `PUT` con el contenido (las llamadas dentro de la red de Zero Trust pueden usar un [service token de Access](https://developers.cloudflare.com/cloudflare-one/identity/service-tokens/)).

## Copias de seguridad

Todo el estado está en `DATA_DIR` (por defecto `/var/lib/nonotion`):

- `nonotion.db` — páginas y metadatos (SQLite, modo WAL)
- `files/` — archivos subidos

Un snapshot del LXC desde Proxmox, o un `rsync` de esa carpeta, es un backup completo.
