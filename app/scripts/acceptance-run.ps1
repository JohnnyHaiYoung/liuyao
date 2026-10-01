# Phase 1 acceptance harness (Windows PowerShell).
#
#   ASCII-ONLY ON PURPOSE. Windows PowerShell reads a BOM-less UTF-8 .ps1 as ANSI;
#   non-ASCII comments then decode into stray characters (including backticks), which
#   silently swallows the following line and makes commands "not run". Keep this file
#   ASCII. Chinese documentation lives in docs/phase1_delivery.md.
#
# What it does: prepares environment variables, starts a local `next start`,
# calls the black-box verification scripts, optionally restarts and re-reads history.
# It never touches the read-only source drive (F:).
#
# Examples:
#   powershell -File app/scripts/acceptance-run.ps1 -Storage <root>\storage\verify-fake -FakeMode -Rebuild -RestartCheck
#   powershell -File app/scripts/acceptance-run.ps1 -Storage <root>\storage\verify-nokey
#   powershell -File app/scripts/acceptance-run.ps1 -Storage <root>\storage\verify-badkey -ApiKey sk-invalid-for-verification

param(
  [string]$Storage = '',
  [int]$Port = 3100,
  [switch]$FakeMode,
  [string]$ApiKey = '',
  [string]$Password = 'verify-password-123',
  [switch]$Rebuild,
  [switch]$RestartCheck,
  [switch]$CaptureSse,
  [string]$RestoreFrom = ''
)

# Continue instead of Stop: npm/next write progress to stderr, and Stop would turn that
# into a terminating NativeCommandError. Failures are checked explicitly below.
$ErrorActionPreference = 'Continue'

# Windows PowerShell cannot build a child-process environment block when both HTTP_PROXY
# and http_proxy exist. Drop the lower-case duplicates for this session only.
foreach ($duplicate in @('http_proxy', 'https_proxy', 'all_proxy', 'no_proxy')) {
  if (Test-Path "Env:$duplicate") { Remove-Item "Env:$duplicate" -ErrorAction SilentlyContinue }
}

$appDir = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$projectRoot = [System.IO.Path]::GetFullPath((Join-Path $appDir '..'))
if ([string]::IsNullOrWhiteSpace($Storage)) {
  $Storage = Join-Path $projectRoot 'storage\verify'
}
$storage = [System.IO.Path]::GetFullPath($Storage)
New-Item -ItemType Directory -Force -Path $storage | Out-Null

# Restore drill: replace the target database with a backup, exactly as documented in
# docs/phase1_delivery.md (stop service -> copy backup -> remove old -wal/-shm -> start).
if (-not [string]::IsNullOrWhiteSpace($RestoreFrom)) {
  $backupPath = [System.IO.Path]::GetFullPath($RestoreFrom)
  if (-not (Test-Path $backupPath)) { throw "backup file not found: $backupPath" }
  Write-Host "restore from : $backupPath"
  foreach ($suffix in @('liuyao.db', 'liuyao.db-wal', 'liuyao.db-shm')) {
    $target = Join-Path $storage $suffix
    if (Test-Path $target) { Remove-Item $target -Force }
  }
  Copy-Item $backupPath (Join-Path $storage 'liuyao.db') -Force
}

$env:LIUYAO_STORAGE_DIR = $storage
$env:LIUYAO_VERIFY_PASSWORD = $Password
$env:PORT = "$Port"
$env:LIUYAO_BASE_URL = "http://127.0.0.1:$Port"

# Bootstrap the owner from a hash produced by scripts/hash-password.mjs instead of a plaintext
# password: this way every acceptance run also proves that the generator and the server-side
# verifier agree (and that the colon format survives PowerShell / env handling).
# Use an absolute path: this block runs before Set-Location, so a relative path would not resolve.
$hashScript = Join-Path $appDir 'scripts\hash-password.mjs'
$ownerHash = (& node $hashScript $Password 2>$null | Select-Object -First 1)
if ([string]::IsNullOrWhiteSpace($ownerHash)) { throw "hash-password.mjs produced no hash ($hashScript)" }
$env:LIUYAO_OWNER_PASSWORD_HASH = $ownerHash.Trim()
Remove-Item Env:LIUYAO_OWNER_PASSWORD -ErrorAction SilentlyContinue

if ($FakeMode) {
  $env:LIUYAO_FAKE_MODEL = '1'
} else {
  Remove-Item Env:LIUYAO_FAKE_MODEL -ErrorAction SilentlyContinue
}
if ([string]::IsNullOrWhiteSpace($ApiKey)) {
  Remove-Item Env:DEEPSEEK_API_KEY -ErrorAction SilentlyContinue
} else {
  $env:DEEPSEEK_API_KEY = $ApiKey
}

Set-Location $appDir
Write-Host "app dir      : $appDir"
Write-Host "storage dir  : $storage"
Write-Host "port         : $Port"
Write-Host "fake model   : $($FakeMode.IsPresent)"
Write-Host "api key given: $(-not [string]::IsNullOrWhiteSpace($ApiKey))"
Write-Host ''

if ($Rebuild) {
  Write-Host '=== next build ==='
  # Call the Next CLI directly through node.exe. Do not use `npm run build`: on Windows
  # `npm` resolves to the npm.ps1 wrapper whose `exit` aborts this script.
  & node 'node_modules/next/dist/bin/next' build
  $buildExit = $LASTEXITCODE
  Write-Host "next build exit code: $buildExit"
  if ($buildExit -ne 0) { throw "build failed with exit code $buildExit" }
}

function Start-AppServer {
  param([string]$Tag)
  $outLog = Join-Path $storage "server-$Tag.out.log"
  $errLog = Join-Path $storage "server-$Tag.err.log"
  $process = Start-Process -FilePath 'node' `
    -ArgumentList @('node_modules/next/dist/bin/next', 'start', '-p', "$Port") `
    -WorkingDirectory $appDir -PassThru -NoNewWindow `
    -RedirectStandardOutput $outLog -RedirectStandardError $errLog
  for ($attempt = 0; $attempt -lt 80; $attempt++) {
    Start-Sleep -Milliseconds 500
    if ($process.HasExited) { break }
    try {
      $response = Invoke-WebRequest -Uri "http://127.0.0.1:$Port/api/healthz" -UseBasicParsing -TimeoutSec 2
      if ($response.StatusCode -eq 200) {
        Write-Host "server ready (stderr log: $errLog)"
        return $process
      }
    } catch {
      # not up yet; keep waiting
    }
  }
  Write-Host 'server did not become ready; stderr tail:'
  if (Test-Path $errLog) { Get-Content $errLog -Encoding UTF8 | Select-Object -Last 30 }
  if (-not $process.HasExited) { Stop-Process -Id $process.Id -Force }
  throw 'server not ready'
}

function Stop-AppServer {
  param($Process)
  if ($Process -and -not $Process.HasExited) {
    Stop-Process -Id $Process.Id -Force
    Start-Sleep -Milliseconds 800
  }
}

$server = $null
try {
  $server = Start-AppServer -Tag 'first'
  Write-Host ''
  if ([string]::IsNullOrWhiteSpace($RestoreFrom)) {
    Write-Host '=== phase 1 verification ==='
    & node 'scripts/verify-phase1.mjs' --base-url "http://127.0.0.1:$Port" --storage $storage
    $verifyExit = $LASTEXITCODE
  } else {
    Write-Host '=== restore drill: read history from the restored database ==='
    & node 'scripts/check-persistence.mjs' --base-url "http://127.0.0.1:$Port" --storage $storage
    $verifyExit = $LASTEXITCODE
  }

  if ($RestartCheck) {
    Write-Host ''
    Write-Host '=== restart the service, then re-read history ==='
    Stop-AppServer $server
    $server = Start-AppServer -Tag 'restart'
    & node 'scripts/check-persistence.mjs' --base-url "http://127.0.0.1:$Port" --storage $storage
  }

  if ($CaptureSse) {
    Write-Host ''
    Write-Host '=== capture one real SSE response ==='
    & node 'scripts/capture-sse-example.mjs' --base-url "http://127.0.0.1:$Port" --out (Join-Path $storage 'sse-sample.txt')
  }

  Write-Host ''
  Write-Host '=== server stderr tail (must contain no API key) ==='
  $errLog = Join-Path $storage 'server-first.err.log'
  if (Test-Path $errLog) { Get-Content $errLog -Encoding UTF8 | Select-Object -Last 15 }
  exit $verifyExit
} finally {
  Stop-AppServer $server
}
