#!/usr/bin/env bash
# Copia de NoNotion fuera del disco del servidor. Se ejecuta en el HOST Proxmox
# (no dentro del contenedor), cada hora por cron:
#
#   install -m 755 deploy/proxmox-offsite-backup.sh /usr/local/bin/nonotion-offsite-backup
#   echo '17 * * * * root /usr/local/bin/nonotion-offsite-backup' > /etc/cron.d/nonotion-offsite-backup
#
# Copia, desde el LXC en marcha, a un destino montado en otro dispositivo:
#   - files/      adjuntos: nunca se modifican, solo se añaden. Sin --delete:
#                 lo que se borre en la app sigue existiendo en la copia.
#   - backups/db/ instantáneas consistentes de la BD que la app hace cada hora
#                 (48 horarias + 30 diarias; la rotación ya viene hecha).
set -uo pipefail

VMID="${NONOTION_VMID:-119}"
DEST="${NONOTION_OFFSITE_DIR:-/mnt/router/nonotion}"
TAG=nonotion-offsite-backup

# Activa el automontaje (x-systemd.automount) y comprueba que el destino está
ls "$(dirname "$DEST")" >/dev/null 2>&1
if ! mountpoint -q "$(dirname "$DEST")"; then
  logger -t "$TAG" "destino $(dirname "$DEST") no montado; se omite esta copia"
  exit 0
fi

PID=$(lxc-info -n "$VMID" -p -H 2>/dev/null || true)
if [ -z "$PID" ]; then
  logger -t "$TAG" "el contenedor $VMID no está en marcha; se omite esta copia"
  exit 0
fi
SRC="/proc/$PID/root/var/lib/nonotion"
[ -d "$SRC" ] || { logger -t "$TAG" "no existe $SRC"; exit 1; }

mkdir -p "$DEST/files" "$DEST/db"
# Mismo patrón que la réplica de vzdump existente (-rt: el CIFS del router no guarda permisos)
rsync -rt --size-only --partial "$SRC/files/" "$DEST/files/" || { logger -t "$TAG" "ERROR copiando files/"; exit 1; }
rsync -rt --partial --delete "$SRC/backups/db/" "$DEST/db/" || { logger -t "$TAG" "ERROR copiando backups/db/"; exit 1; }

date -Iseconds > "$DEST/ULTIMA_COPIA.txt"
logger -t "$TAG" "copia OK: $(du -sh "$DEST" 2>/dev/null | cut -f1) en $DEST"
