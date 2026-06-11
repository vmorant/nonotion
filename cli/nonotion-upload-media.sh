#!/usr/bin/env bash
# nonotion-upload-media: recomprime una grabación local (Game Bar, Teams, OBS…)
# a formato ligero y la sube a NoNotion como página de reunión.
#
# Uso:
#   nonotion-upload-media [-m audio|light] [-t "Título"] [-p PAGE_ID] grabacion.mp4
#
#   -m audio  (por defecto) solo audio Opus 48 kbps  → ~20 MB/h
#   -m light  vídeo 720p/5fps H264 + AAC             → ~100 MB/h
#   -t        título de la página (por defecto "Reunión <fecha>")
#   -p        adjuntar a una página existente en vez de crear una
#
# Configuración: NONOTION_URL, y opcionalmente CF_ACCESS_CLIENT_ID/SECRET
# (igual que nonotion-send). Requiere ffmpeg local.
set -euo pipefail

MODE=audio
TITLE=""
PAGE_ID="${NONOTION_PARENT_PAGE:-}"
while getopts 'm:t:p:' opt; do
  case "$opt" in
    m) MODE="$OPTARG" ;;
    t) TITLE="$OPTARG" ;;
    p) PAGE_ID="$OPTARG" ;;
    *) exit 1 ;;
  esac
done
shift $((OPTIND - 1))

INPUT="${1:-}"
URL="${NONOTION_URL:-}"
[ -n "$URL" ] || { echo "Error: define NONOTION_URL" >&2; exit 1; }
[ -f "$INPUT" ] || { echo "Uso: nonotion-upload-media [-m audio|light] [-t título] [-p page_id] archivo" >&2; exit 1; }
command -v ffmpeg >/dev/null || { echo "Error: ffmpeg no está instalado" >&2; exit 1; }

BASE="$(basename "${INPUT%.*}")"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

echo "==> Recomprimiendo ($MODE)…"
if [ "$MODE" = audio ]; then
  OUT="$TMP/${BASE} (audio).webm"
  MIME="audio/webm"
  ffmpeg -loglevel error -y -i "$INPUT" -vn -c:a libopus -b:a 48k "$OUT"
else
  OUT="$TMP/${BASE} (ligero).mp4"
  MIME="video/mp4"
  ffmpeg -loglevel error -y -i "$INPUT" \
    -vf 'scale=-2:min(720\,ih),fps=5' -c:v libx264 -preset veryfast -crf 30 \
    -c:a aac -b:a 64k -movflags +faststart "$OUT"
fi
ORIG=$(du -h "$INPUT" | cut -f1); NUEVO=$(du -h "$OUT" | cut -f1)
echo "    $ORIG → $NUEVO"

EXTRA_HEADERS=()
if [ -n "${CF_ACCESS_CLIENT_ID:-}" ]; then
  EXTRA_HEADERS+=(-H "CF-Access-Client-Id: $CF_ACCESS_CLIENT_ID" -H "CF-Access-Client-Secret: ${CF_ACCESS_CLIENT_SECRET:-}")
fi

if [ -z "$PAGE_ID" ]; then
  PAGE_TITLE="${TITLE:-Reunión $(date '+%Y-%m-%d %H:%M')}"
  BODY=$(TITLE="$PAGE_TITLE" python3 -c '
import json, os
print(json.dumps({"markdown": "Grabación de la reunión adjunta.", "title": os.environ["TITLE"]}))
')
  PAGE_ID=$(curl -sf -X POST "$URL/api/capture" -H 'Content-Type: application/json' \
    "${EXTRA_HEADERS[@]}" -d "$BODY" | python3 -c 'import json,sys;print(json.load(sys.stdin)["id"])')
  echo "==> Página creada: $URL/p/$PAGE_ID"
fi

echo "==> Subiendo…"
curl -sf -X POST "$URL/api/files" "${EXTRA_HEADERS[@]}" \
  -F "page_id=$PAGE_ID" -F "file=@$OUT;type=$MIME" >/dev/null

echo "✅ Grabación subida a $URL/p/$PAGE_ID"
