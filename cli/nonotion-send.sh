#!/usr/bin/env bash
# nonotion-send: envía Markdown (stdin o portapapeles) como página nueva a NoNotion.
#
# Uso:
#   cat respuesta.md | nonotion-send "Título opcional"
#   nonotion-send "Título"            # sin stdin: toma el portapapeles (xclip/wl-paste)
#
# Configuración (variables de entorno):
#   NONOTION_URL              URL base, p. ej. https://notas.tudominio.com (obligatoria)
#   NONOTION_PARENT           id de página padre opcional (por defecto: Inbox)
#   CF_ACCESS_CLIENT_ID       service token de Cloudflare Access (opcional, para pasar Zero Trust)
#   CF_ACCESS_CLIENT_SECRET
set -euo pipefail

URL="${NONOTION_URL:-}"
if [ -z "$URL" ]; then
  echo "Error: define NONOTION_URL (p. ej. export NONOTION_URL=https://notas.tudominio.com)" >&2
  exit 1
fi

TITLE="${1:-}"

if [ -t 0 ]; then
  if command -v wl-paste >/dev/null 2>&1; then
    MARKDOWN="$(wl-paste --no-newline 2>/dev/null || wl-paste)"
  elif command -v xclip >/dev/null 2>&1; then
    MARKDOWN="$(xclip -o -selection clipboard)"
  elif command -v pbpaste >/dev/null 2>&1; then
    MARKDOWN="$(pbpaste)"
  else
    echo "Error: sin stdin y sin xclip/wl-paste/pbpaste para leer el portapapeles" >&2
    exit 1
  fi
else
  MARKDOWN="$(cat)"
fi

if [ -z "${MARKDOWN// /}" ]; then
  echo "Error: no hay contenido que enviar" >&2
  exit 1
fi

EXTRA_HEADERS=()
if [ -n "${CF_ACCESS_CLIENT_ID:-}" ]; then
  EXTRA_HEADERS+=(-H "CF-Access-Client-Id: $CF_ACCESS_CLIENT_ID" -H "CF-Access-Client-Secret: ${CF_ACCESS_CLIENT_SECRET:-}")
fi

BODY=$(MARKDOWN="$MARKDOWN" TITLE="$TITLE" PARENT="${NONOTION_PARENT:-}" python3 -c '
import json, os
payload = {"markdown": os.environ["MARKDOWN"]}
if os.environ.get("TITLE"):
    payload["title"] = os.environ["TITLE"]
if os.environ.get("PARENT"):
    payload["parent_id"] = os.environ["PARENT"]
print(json.dumps(payload))
')

RESPONSE=$(curl -sf -X POST "$URL/api/capture" \
  -H 'Content-Type: application/json' \
  "${EXTRA_HEADERS[@]}" \
  -d "$BODY")

PAGE_URL=$(python3 -c 'import json,sys; d=json.load(sys.stdin); print(d["url"])' <<<"$RESPONSE")
PAGE_TITLE=$(python3 -c 'import json,sys; d=json.load(sys.stdin); print(d["title"])' <<<"$RESPONSE")
echo "✅ Página creada: \"$PAGE_TITLE\" → $URL$PAGE_URL"
