#!/usr/bin/env bash
# Instalador de NoNotion para un LXC Debian 12 / Ubuntu 22.04+ de Proxmox.
# Ejecutar como root DENTRO del contenedor:
#   bash deploy/install.sh
set -euo pipefail

APP_DIR=/opt/nonotion
DATA_DIR=/var/lib/nonotion
REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"

echo "==> Instalando dependencias del sistema"
apt-get update
apt-get install -y curl ca-certificates git build-essential python3 rsync
# LibreOffice headless: vista previa de Word/Excel/PowerPoint dentro de NoNotion
apt-get install -y --no-install-recommends libreoffice-writer libreoffice-calc libreoffice-impress fonts-liberation
# poppler: lectura de contenido de PDF/Office por Claude (extracción de texto y render de páginas)
apt-get install -y poppler-utils

if ! command -v node >/dev/null || [ "$(node -v | cut -d. -f1 | tr -d v)" -lt 20 ]; then
  echo "==> Instalando Node.js 20 (NodeSource)"
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt-get install -y nodejs
fi

echo "==> Creando usuario de servicio"
id nonotion &>/dev/null || useradd --system --home "$DATA_DIR" --shell /usr/sbin/nologin nonotion

echo "==> Copiando aplicación a $APP_DIR"
mkdir -p "$APP_DIR"
rsync -a --delete \
  --exclude node_modules --exclude data --exclude .git --exclude client/dist \
  "$REPO_DIR"/ "$APP_DIR"/

echo "==> Instalando dependencias y compilando el frontend"
cd "$APP_DIR"
npm install --omit=dev
npm run build

echo "==> Preparando directorio de datos en $DATA_DIR"
mkdir -p "$DATA_DIR"

# Copia de seguridad consistente de la base de datos antes de reiniciar con la
# versión nueva (las migraciones se aplican al arrancar)
if [ -f "$DATA_DIR/nonotion.db" ]; then
  mkdir -p "$DATA_DIR/backups/pre-update"
  STAMP=$(date +%Y%m%d-%H%M%S)
  node -e "
    const D = require('$APP_DIR/node_modules/better-sqlite3');
    new D('$DATA_DIR/nonotion.db').backup('$DATA_DIR/backups/pre-update/nonotion-$STAMP.db')
      .then(() => console.log('    copia previa: backups/pre-update/nonotion-$STAMP.db'))
      .catch((e) => { console.error('    ERROR en la copia previa:', e.message); process.exit(1); });
  "
  # Se conservan las 10 últimas copias previas a actualizar
  ls -1t "$DATA_DIR/backups/pre-update/"nonotion-*.db 2>/dev/null | tail -n +11 | xargs -r rm -f
fi
chown -R nonotion:nonotion "$DATA_DIR" "$APP_DIR"

echo "==> Configuración en /etc/nonotion.env"
if [ ! -f /etc/nonotion.env ]; then
  cp "$APP_DIR/deploy/nonotion.env.example" /etc/nonotion.env
  echo "    creada desde la plantilla (login con GitHub desactivado hasta rellenarla)"
fi
chown root:root /etc/nonotion.env
chmod 600 /etc/nonotion.env

echo "==> Instalando y reiniciando el servicio systemd"
cp "$APP_DIR/deploy/nonotion.service" /etc/systemd/system/nonotion.service
systemctl daemon-reload
systemctl enable nonotion
systemctl restart nonotion # "enable --now" no reinicia un servicio ya activo: sin esto seguía la versión vieja

for i in $(seq 1 20); do
  curl -fsS http://127.0.0.1:3000/api/health >/dev/null 2>&1 && break
  sleep 1
done
if curl -fsS http://127.0.0.1:3000/api/health >/dev/null 2>&1; then
  echo "    servicio respondiendo"
else
  echo "⚠  El servicio no responde. Revisa: journalctl -u nonotion -n 50"
fi

echo
echo "✅ NoNotion instalado y en ejecución en http://localhost:3000"
echo "   Estado:   systemctl status nonotion"
echo "   Logs:     journalctl -u nonotion -f"
echo "   Datos:    $DATA_DIR (base de datos + archivos)"
echo
echo "Siguiente paso: apunta tu túnel de cloudflared a http://localhost:3000 (ver README.md)"
