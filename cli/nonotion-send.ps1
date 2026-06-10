# nonotion-send.ps1: envía Markdown (stdin o portapapeles) como página nueva a NoNotion.
#
# Uso:
#   Get-Content respuesta.md -Raw | .\nonotion-send.ps1 "Título opcional"
#   .\nonotion-send.ps1 "Título"     # sin stdin: toma el portapapeles
#
# Configuración (variables de entorno):
#   NONOTION_URL              URL base, p. ej. https://notas.tudominio.com (obligatoria)
#   NONOTION_PARENT           id de página padre opcional (por defecto: Inbox)
#   CF_ACCESS_CLIENT_ID       service token de Cloudflare Access (opcional)
#   CF_ACCESS_CLIENT_SECRET
param([string]$Title = '')

$ErrorActionPreference = 'Stop'

$url = $env:NONOTION_URL
if (-not $url) {
  Write-Error 'Define NONOTION_URL (p. ej. $env:NONOTION_URL = "https://notas.tudominio.com")'
}

if ($MyInvocation.ExpectingInput) {
  $markdown = $input | Out-String
} else {
  $markdown = Get-Clipboard -Raw
}

if (-not $markdown -or -not $markdown.Trim()) {
  Write-Error 'No hay contenido que enviar'
}

$payload = @{ markdown = $markdown }
if ($Title) { $payload.title = $Title }
if ($env:NONOTION_PARENT) { $payload.parent_id = $env:NONOTION_PARENT }

$headers = @{}
if ($env:CF_ACCESS_CLIENT_ID) {
  $headers['CF-Access-Client-Id'] = $env:CF_ACCESS_CLIENT_ID
  $headers['CF-Access-Client-Secret'] = $env:CF_ACCESS_CLIENT_SECRET
}

$response = Invoke-RestMethod -Method Post -Uri "$url/api/capture" `
  -ContentType 'application/json; charset=utf-8' `
  -Headers $headers `
  -Body ([System.Text.Encoding]::UTF8.GetBytes(($payload | ConvertTo-Json -Depth 3)))

Write-Host "✅ Página creada: `"$($response.title)`" → $url$($response.url)"
