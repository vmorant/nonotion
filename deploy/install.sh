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
apt-get install -y curl ca-certificates git build-essential python3

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
chown -R nonotion:nonotion "$DATA_DIR" "$APP_DIR"

echo "==> Instalando servicio systemd"
cp "$APP_DIR/deploy/nonotion.service" /etc/systemd/system/nonotion.service
systemctl daemon-reload
systemctl enable --now nonotion

echo
echo "✅ NoNotion instalado y en ejecución en http://localhost:3000"
echo "   Estado:   systemctl status nonotion"
echo "   Logs:     journalctl -u nonotion -f"
echo "   Datos:    $DATA_DIR (base de datos + archivos)"
echo
echo "Siguiente paso: apunta tu túnel de cloudflared a http://localhost:3000 (ver README.md)"
