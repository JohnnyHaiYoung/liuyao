# Word (COM) probe + optional .doc conversion, with in-process timeouts.
#
# ASCII only: Windows PowerShell 5.1 reads BOM-less UTF-8 .ps1 as ANSI and non-ASCII breaks it.
# Child processes are avoided on purpose: Start-Process fails in this session because the
# environment contains both NO_PROXY and no_proxy (PowerShell's case-insensitive dictionary),
# and previously a Word call hung for minutes. Instead each COM attempt runs in its own
# PowerShell runspace that is stopped after -TimeoutSeconds, so a hang costs only the timeout.
#
# Usage:
#   powershell -File tools/offline/word-probe.ps1 [-DocPath <file> -OutPath <utf8 txt>]
# Output: one ##WORD_PROBE## JSON line per activation variant, then, if -DocPath is given,
#         ##WORD_CONVERT## JSON plus the converted UTF-8 text at -OutPath.

param(
  [string]$DocPath = '',
  [string]$OutPath = '',
  [int]$TimeoutSeconds = 90,
  [int]$ConvertTimeoutSeconds = 240
)

$ErrorActionPreference = 'Continue'

function Invoke-WithTimeout {
  param([scriptblock]$Script, [int]$Seconds)
  # Word COM needs a single-threaded apartment: a default PowerShell runspace is MTA and
  # activating Word there fails later with TYPE_E_CANTLOADLIBRARY when documents are opened.
  $runspace = [runspacefactory]::CreateRunspace()
  $runspace.ApartmentState = [System.Threading.ApartmentState]::STA
  $runspace.ThreadOptions = [System.Management.Automation.PSThreadOptions]::ReuseThread
  $runspace.Open()
  $shell = [powershell]::Create()
  $shell.Runspace = $runspace
  $null = $shell.AddScript($Script.ToString())
  $watch = [System.Diagnostics.Stopwatch]::StartNew()
  try {
    $handle = $shell.BeginInvoke()
    if ($handle.AsyncWaitHandle.WaitOne($Seconds * 1000)) {
      try {
        $result = ($shell.EndInvoke($handle) | Out-String).Trim()
        if ($result -eq '') { $result = '(no output)' }
      } catch {
        $base = $_.Exception
        while ($base.InnerException) { $base = $base.InnerException }
        $result = "ERROR $($base.GetType().Name): $($base.Message)"
      }
    } else {
      try { $shell.Stop() } catch { }
      $result = "TIMEOUT after ${Seconds}s"
    }
  } catch {
    $result = "DISPATCH-ERROR $($_.Exception.Message)"
  } finally {
    $watch.Stop()
    try { $shell.Dispose() } catch { }
    try { $runspace.Close(); $runspace.Dispose() } catch { }
  }
  return [ordered]@{ result = $result; seconds = [Math]::Round($watch.Elapsed.TotalSeconds, 1) }
}

# 1) Three activation routes, each with its own timeout.
$variants = [ordered]@{
  newobject = { $w = New-Object -ComObject Word.Application; $v = $w.Version; $w.Quit(0); "OK version=$v" }
  progid    = { $w = [Activator]::CreateInstance([Type]::GetTypeFromProgID('Word.Application', $true)); $v = $w.Version; $w.Quit(0); "OK version=$v" }
  gettype   = { $t = [Type]::GetTypeFromProgID('Word.Application', $true); $w = [Activator]::CreateInstance($t, $true); $v = $w.Version; $w.Quit(0); "OK version=$v" }
}
$probe = [ordered]@{}
foreach ($name in $variants.Keys) {
  $attempt = Invoke-WithTimeout -Script $variants[$name] -Seconds $TimeoutSeconds
  $probe[$name] = $attempt.result
  Write-Output ('##WORD_PROBE## ' + ([ordered]@{ variant = $name; result = $attempt.result; seconds = $attempt.seconds } | ConvertTo-Json -Compress))
  Get-Process WINWORD -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
}

# 2) Optional conversion of the legacy .doc to UTF-8 text.
if ($DocPath -ne '' -and $OutPath -ne '') {
  $tempText = [System.IO.Path]::Combine([System.IO.Path]::GetTempPath(), "liuyao-word-$([guid]::NewGuid().ToString('N')).txt")
  $script = @"
`$ErrorActionPreference = 'Stop'
`$w = New-Object -ComObject Word.Application
`$w.Visible = `$false
`$w.DisplayAlerts = 0
`$w.AutomationSecurity = 3
`$d = `$w.Documents.Open('$DocPath', `$false, `$true, `$false)
`$d.SaveAs2('$tempText', 7)
`$pages = `$d.ComputeStatistics(2)
`$words = `$d.ComputeStatistics(0)
`$paras = `$d.Paragraphs.Count
`$chars = `$d.Characters.Count
`$d.Close(0)
`$w.Quit(0)
"OK pages=`$pages words=`$words paragraphs=`$paras characters=`$chars"
"@
  $conversion = Invoke-WithTimeout -Script ([scriptblock]::Create($script)) -Seconds $ConvertTimeoutSeconds
  Get-Process WINWORD -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
  $ok = Test-Path -LiteralPath $tempText
  if ($ok) {
    $text = [System.IO.File]::ReadAllText($tempText, [System.Text.Encoding]::Unicode)
    $text = $text -replace "`r`n", "`n" -replace "`r", "`n"
    $directory = Split-Path -Parent $OutPath
    if ($directory -and -not (Test-Path -LiteralPath $directory)) { New-Item -ItemType Directory -Force -Path $directory | Out-Null }
    [System.IO.File]::WriteAllText($OutPath, $text, (New-Object System.Text.UTF8Encoding($false)))
    Remove-Item -LiteralPath $tempText -Force -ErrorAction SilentlyContinue
  }
  Write-Output ('##WORD_CONVERT## ' + ([ordered]@{
        result   = $conversion.result
        seconds  = $conversion.seconds
        textFile = $(if ($ok) { $OutPath } else { $null })
        bytes    = $(if ($ok) { (Get-Item -LiteralPath $OutPath).Length } else { 0 })
        tool     = 'Microsoft Word (COM, wdFormatUnicodeText=7 -> UTF-8)'
      } | ConvertTo-Json -Compress))
}

# 3) Registry facts: does an in-process IFilter exist as a Word-independent second parser?
foreach ($path in 'HKLM:\SOFTWARE\Classes\.doc\PersistentHandler') {
  $handler = (Get-ItemProperty -Path $path -ErrorAction SilentlyContinue).'(default)'
  Write-Output ("##IFILTER## handler=" + $handler)
  if ($handler) {
    $base = "HKLM:\SOFTWARE\Classes\CLSID\$handler"
    $addins = Get-ChildItem -Path "$base\PersistentAddinsRegistered" -ErrorAction SilentlyContinue
    foreach ($addin in $addins) {
      $filterClsid = (Get-ItemProperty -Path $addin.PSPath -ErrorAction SilentlyContinue).'(default)'
      $dll = (Get-ItemProperty -Path "HKLM:\SOFTWARE\Classes\CLSID\$filterClsid\InprocServer32" -ErrorAction SilentlyContinue).'(default)'
      Write-Output ("##IFILTER## iid=" + $addin.PSChildName + " filter=" + $filterClsid + " dll=" + $dll)
    }
  }
}
