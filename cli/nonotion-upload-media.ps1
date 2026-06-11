# nonotion-upload-media.ps1: recomprime una grabación local (Game Bar Win+Alt+R,
# Teams, OBS…) a formato ligero y la sube a NoNotion como página de reunión.
#
# Uso:
#   .\nonotion-upload-media.ps1 grabacion.mp4                      # solo audio (~20 MB/h)
#   .\nonotion-upload-media.ps1 grabacion.mp4 -Mode light          # vídeo 720p/5fps
#   .\nonotion-upload-media.ps1 grabacion.mp4 -Title "Reunión X" -PageId abc123
#
# Configuración: NONOTION_URL, y opcionalmente CF_ACCESS_CLIENT_ID/SECRET.
# Requiere ffmpeg en el PATH (winget install ffmpeg).
param(
  [Parameter(Mandatory = $true)][string]$Path,
  [ValidateSet('audio', 'light')][string]$Mode = 'audio',
  [string]$Title = '',
  [string]$PageId = ''
)

$ErrorActionPreference = 'Stop'

$url = $env:NONOTION_URL
if (-not $url) { Write-Error 'Define NONOTION_URL' }
if (-not (Test-Path $Path)) { Write-Error "No existe: $Path" }
if (-not (Get-Command ffmpeg -ErrorAction SilentlyContinue)) { Write-Error 'ffmpeg no está instalado (winget install ffmpeg)' }

$base = [IO.Path]::GetFileNameWithoutExtension($Path)
$tmp = Join-Path $env:TEMP "nonotion-$([guid]::NewGuid().ToString('n').Substring(0,8))"
New-Item -ItemType Directory -Path $tmp | Out-Null

try {
  Write-Host "==> Recomprimiendo ($Mode)..."
  if ($Mode -eq 'audio') {
    $out = Join-Path $tmp "$base (audio).webm"
    ffmpeg -loglevel error -y -i $Path -vn -c:a libopus -b:a 48k $out
  } else {
    $out = Join-Path $tmp "$base (ligero).mp4"
    ffmpeg -loglevel error -y -i $Path -vf 'scale=-2:min(720\,ih),fps=5' -c:v libx264 -preset veryfast -crf 30 -c:a aac -b:a 64k -movflags +faststart $out
  }
  $origMB = [math]::Round((Get-Item $Path).Length / 1MB, 1)
  $newMB = [math]::Round((Get-Item $out).Length / 1MB, 1)
  Write-Host "    $origMB MB -> $newMB MB"

  $headers = @{}
  if ($env:CF_ACCESS_CLIENT_ID) {
    $headers['CF-Access-Client-Id'] = $env:CF_ACCESS_CLIENT_ID
    $headers['CF-Access-Client-Secret'] = $env:CF_ACCESS_CLIENT_SECRET
  }

  if (-not $PageId) {
    $pageTitle = if ($Title) { $Title } else { "Reunión $(Get-Date -Format 'yyyy-MM-dd HH:mm')" }
    $body = @{ markdown = 'Grabación de la reunión adjunta.'; title = $pageTitle } | ConvertTo-Json
    $page = Invoke-RestMethod -Method Post -Uri "$url/api/capture" -ContentType 'application/json; charset=utf-8' `
      -Headers $headers -Body ([Text.Encoding]::UTF8.GetBytes($body))
    $PageId = $page.id
    Write-Host "==> Página creada: $url/p/$PageId"
  }

  Write-Host '==> Subiendo...'
  $form = @{ page_id = $PageId; file = Get-Item $out }
  Invoke-RestMethod -Method Post -Uri "$url/api/files" -Headers $headers -Form $form | Out-Null

  Write-Host "✅ Grabación subida a $url/p/$PageId"
} finally {
  Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue
}
