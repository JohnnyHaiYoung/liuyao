# Phase 1 acceptance harness (Windows PowerShell).
#
#   ASCII-ONLY ON PURPOSE. Windows PowerShell reads a BOM-less UTF-8 .ps1 as ANSI;
#   non-ASCII comments then decode into stray characters (including backticks), which
#   silently swallows the following line and makes commands "not run". Keep this file
#   ASCII. Chinese documentation lives in docs/phase1_delivery.md.
#
# Phases (each starts its own server instance, so switches can be combined):
#   (default)       black-box acceptance with the local fake model: verify-phase1.mjs
#   -AdapterCheck   controllable mock upstream: check-adapter-states.mjs
#                   (normal end / early EOF / reset / HTTP 4xx-5xx / length / user stop)
#   -PagingCheck    seed N conversations, then check-conversations-paging.mjs
#   -RestartCheck   restart the service and re-read history (acceptance phase)
#   -CaptureSse     capture one real SSE response (acceptance phase)
#   -RestoreFrom    replace the target database with a backup before starting
#
#   Model environment per run (mutually exclusive, keep it explicit):
#     -FakeMode           local fake model (no network)
#     -ApiKey <key>       live DeepSeek with an explicit key (use an invalid one to test errors)
#     -ApiKeyFromFile     leave the process environment alone so app/.env.local supplies the real
#                         key -> real DeepSeek end-to-end run
#     (none of the above) live DeepSeek with an explicitly EMPTY key variable, which shadows
#                         app/.env.local and deterministically reproduces "not configured"
#
# Examples:
#   powershell -File app/scripts/acceptance-run.ps1 -Storage <root>\storage\verify-fake -FakeMode -Rebuild -RestartCheck -CaptureSse
#   powershell -File app/scripts/acceptance-run.ps1 -Storage <root>\storage\verify-live -ApiKeyFromFile -Rebuild
#   powershell -File app/scripts/acceptance-run.ps1 -Storage <root>\storage\verify-adapter -AdapterCheck
#   powershell -File app/scripts/acceptance-run.ps1 -Storage <root>\storage\verify-paging -PagingCheck -SeedConversations 55
#   powershell -File app/scripts/acceptance-run.ps1 -Storage <root>\storage\verify-nokey

param(
  [string]$Storage = '',
  [int]$Port = 3100,
  [int]$MockPort = 3211,
  [switch]$FakeMode,
  [string]$ApiKey = '',
  [switch]$ApiKeyFromFile,
  [string]$Password = 'verify-password-123',
  [switch]$Rebuild,
  [switch]$RestartCheck,
  [switch]$CaptureSse,
  [string]$RestoreFrom = '',
  [switch]$AdapterCheck,
  [switch]$PagingCheck,
  [int]$SeedConversations = 55
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
# password: this way every run also proves that the generator and the server-side verifier
# agree (and that the colon format survives PowerShell / env handling).
$hashScript = Join-Path $appDir 'scripts\hash-password.mjs'
$ownerHash = (& node $hashScript $Password 2>$null | Select-Object -First 1)
if ([string]::IsNullOrWhiteSpace($ownerHash)) { throw "hash-password.mjs produced no hash ($hashScript)" }
$env:LIUYAO_OWNER_PASSWORD_HASH = $ownerHash.Trim()
Remove-Item Env:LIUYAO_OWNER_PASSWORD -ErrorAction SilentlyContinue

Set-Location $appDir
Write-Host "app dir      : $appDir"
Write-Host "storage dir  : $storage"
Write-Host "port         : $Port"
Write-Host "phases       : default=$(-not ($AdapterCheck -or $PagingCheck)) adapter=$($AdapterCheck.IsPresent) paging=$($PagingCheck.IsPresent)"
if ($FakeMode) { Write-Host 'model env    : local fake model' }
elseif ($ApiKeyFromFile) { Write-Host 'model env    : live DeepSeek, key from app/.env.local' }
elseif (-not [string]::IsNullOrWhiteSpace($ApiKey)) { Write-Host 'model env    : live DeepSeek with explicit key (masked)' }
else { Write-Host 'model env    : live DeepSeek with EMPTY key (not-configured scenario)' }
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

function Set-FakeModelEnv {
  $env:LIUYAO_FAKE_MODEL = '1'
  Remove-Item Env:DEEPSEEK_API_KEY -ErrorAction SilentlyContinue
  Remove-Item Env:LLM_BASE_URL -ErrorAction SilentlyContinue
}

function Set-LiveEnv {
  param([string]$Key, [switch]$FromFile)
  Remove-Item Env:LIUYAO_FAKE_MODEL -ErrorAction SilentlyContinue
  Remove-Item Env:LLM_BASE_URL -ErrorAction SilentlyContinue
  if ($FromFile) {
    # Leave DEEPSEEK_API_KEY untouched: app/.env.local supplies the real key.
    Write-Host 'model env    : live DeepSeek, key from app/.env.local'
    return
  }
  # NOTE: PowerShell DELETES a variable when you assign an empty string, which would let
  # app/.env.local supply the real key again. A single space keeps the variable defined
  # (so Next's dotenv leaves it alone) while the app trims it to "not configured".
  if ([string]::IsNullOrWhiteSpace($Key)) {
    $env:DEEPSEEK_API_KEY = ' '
  } else {
    $env:DEEPSEEK_API_KEY = $Key
  }
}

function Set-MockUpstreamEnv {
  Remove-Item Env:LIUYAO_FAKE_MODEL -ErrorAction SilentlyContinue
  $env:DEEPSEEK_API_KEY = 'sk-mock-upstream-for-tests'
  $env:LLM_BASE_URL = "http://127.0.0.1:$MockPort/v1"
}

# Model environment for the acceptance/paging phases.
function Apply-ModelEnv {
  if ($FakeMode) { Set-FakeModelEnv; return }
  if ($ApiKeyFromFile) { Set-LiveEnv -FromFile; return }
  Set-LiveEnv -Key $ApiKey
}
Apply-ModelEnv

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
    Start-Sleep -Milliseconds 900
  }
}

function Start-MockUpstream {
  $outLog = Join-Path $storage 'mock-upstream.out.log'
  $errLog = Join-Path $storage 'mock-upstream.err.log'
  $script = Join-Path $appDir 'scripts\mock-deepseek-upstream.mjs'
  $process = Start-Process -FilePath 'node' -ArgumentList @($script, '--port', "$MockPort", '--mode', 'normal') `
    -WorkingDirectory $appDir -PassThru -NoNewWindow `
    -RedirectStandardOutput $outLog -RedirectStandardError $errLog
  for ($attempt = 0; $attempt -lt 40; $attempt++) {
    Start-Sleep -Milliseconds 300
    try {
      $response = Invoke-WebRequest -Uri "http://127.0.0.1:$MockPort/__control" -UseBasicParsing -TimeoutSec 2
      if ($response.StatusCode -eq 200) {
        Write-Host "mock upstream ready on http://127.0.0.1:$MockPort"
        return $process
      }
    } catch {
      # not up yet
    }
  }
  if (-not $process.HasExited) { Stop-Process -Id $process.Id -Force }
  throw 'mock upstream not ready'
}

$exitCode = 0

# ---------------------------------------------------------------- acceptance phase
if (-not ($AdapterCheck -or $PagingCheck) -or $RestartCheck -or $CaptureSse) {
  Apply-ModelEnv
  $server = $null
  try {
    $server = Start-AppServer -Tag 'first'
    Write-Host ''
    Write-Host '=== phase 1 verification ==='
    & node 'scripts/verify-phase1.mjs' --base-url "http://127.0.0.1:$Port" --storage $storage
    if ($LASTEXITCODE -ne 0) { $exitCode = $LASTEXITCODE }

    if ($RestartCheck) {
      Write-Host ''
      Write-Host '=== restart the service, then re-read history ==='
      Stop-AppServer $server
      $server = Start-AppServer -Tag 'restart'
      & node 'scripts/check-persistence.mjs' --base-url "http://127.0.0.1:$Port" --storage $storage
      if ($LASTEXITCODE -ne 0) { $exitCode = $LASTEXITCODE }
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
  } finally {
    Stop-AppServer $server
  }
}

# ---------------------------------------------------------------- adapter states phase
if ($AdapterCheck) {
  Write-Host ''
  Write-Host '=== adapter termination states (mock upstream) ==='
  $mock = $null
  $server = $null
  try {
    $mock = Start-MockUpstream
    Set-MockUpstreamEnv
    $server = Start-AppServer -Tag 'adapter'
    & node 'scripts/check-adapter-states.mjs' --base-url "http://127.0.0.1:$Port" --mock-url "http://127.0.0.1:$MockPort"
    if ($LASTEXITCODE -ne 0) { $exitCode = $LASTEXITCODE }
    Write-Host ''
    Write-Host '=== adapter phase server stderr tail ==='
    $errLog = Join-Path $storage 'server-adapter.err.log'
    if (Test-Path $errLog) { Get-Content $errLog -Encoding UTF8 | Select-Object -Last 20 }
  } finally {
    Stop-AppServer $server
    Stop-AppServer $mock
  }
}

# ---------------------------------------------------------------- conversation paging phase
if ($PagingCheck) {
  Write-Host ''
  Write-Host '=== conversation list paging ==='
  # The "continue the oldest conversation" step needs a working model; fall back to the
  # local fake model when no live key was supplied in any form.
  if ($FakeMode) { Set-FakeModelEnv } elseif ($ApiKeyFromFile) { Set-LiveEnv -FromFile } else { Set-LiveEnv -Key $ApiKey }
  if (-not $FakeMode -and -not $ApiKeyFromFile -and [string]::IsNullOrWhiteSpace($ApiKey)) { Set-FakeModelEnv }
  $server = $null
  try {
    $server = Start-AppServer -Tag 'paging'
    Write-Host "--- seeding $SeedConversations conversations ---"
    & node 'scripts/seed-conversations.mjs' --count "$SeedConversations" --storage $storage
    if ($LASTEXITCODE -ne 0) { throw 'seeding failed' }
    & node 'scripts/check-conversations-paging.mjs' --base-url "http://127.0.0.1:$Port" --expect-oldest-index "$SeedConversations"
    if ($LASTEXITCODE -ne 0) { $exitCode = $LASTEXITCODE }
  } finally {
    Stop-AppServer $server
  }
}

exit $exitCode
