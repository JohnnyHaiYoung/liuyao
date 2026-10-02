# Convert a legacy .doc / .docx / .pdf into plain UTF-8 text or .docx with Microsoft Word (COM).
#
# Why this tool: the machine has no LibreOffice, no antiword/catdoc and no usable pip, but it
# does have Microsoft Office 16. Word can open the legacy binary .doc format (and, for PDFs,
# import the text layer) and re-save it, which is far more faithful than home-grown parsing.
#
# Usage:
#   powershell -ExecutionPolicy Bypass -File tools/offline/word-convert.ps1 `
#       -InputPath <file> -OutPath <file> -Format txt|docx
#
# Notes:
#   * Opens read-only and never saves back to the input path (F: originals stay untouched).
#   * Writes a JSON line as the last output line: {"tool":"Word","version":"16.0",...}
#   * Word is automation-hostile: DisplayAlerts is disabled and the document is closed without
#     saving; if it still hangs, the caller is responsible for killing WINWORD.EXE.

param(
  [Parameter(Mandatory = $true)][string]$InputPath,
  [Parameter(Mandatory = $true)][string]$OutPath,
  [ValidateSet('txt', 'docx')][string]$Format = 'txt'
)

$ErrorActionPreference = 'Stop'

if (-not (Test-Path -LiteralPath $InputPath)) { throw "input not found: $InputPath" }
$inputFull = (Resolve-Path -LiteralPath $InputPath).Path
$outFull = [System.IO.Path]::GetFullPath($OutPath)
$outDir = Split-Path -Parent $outFull
if ($outDir -and -not (Test-Path -LiteralPath $outDir)) { New-Item -ItemType Directory -Force -Path $outDir | Out-Null }

$word = $null
$document = $null
$tempText = $null
try {
  $word = New-Object -ComObject Word.Application
  $word.Visible = $false
  $word.DisplayAlerts = 0
  $word.AutomationSecurity = 3   # msoAutomationSecurityForceDisable (no macros)

  # Open(FileName, ConfirmConversions, ReadOnly, AddToRecentFiles, ...)
  $document = $word.Documents.Open($inputFull, $false, $true, $false)

  if ($Format -eq 'txt') {
    # wdFormatUnicodeText = 7 (UTF-16LE). Convert to UTF-8 ourselves to keep one text encoding.
    $tempText = [System.IO.Path]::Combine([System.IO.Path]::GetTempPath(), "liuyao-word-$([guid]::NewGuid().ToString('N')).txt")
    $document.SaveAs2($tempText, 7)
    $text = [System.IO.File]::ReadAllText($tempText, [System.Text.Encoding]::Unicode)
    # Word writes CR; normalise to LF so the extracted layer is stable across tools.
    $text = $text -replace "`r`n", "`n" -replace "`r", "`n"
    [System.IO.File]::WriteAllText($outFull, $text, (New-Object System.Text.UTF8Encoding($false)))
    $meta = [ordered]@{
      tool       = 'Microsoft Word (COM)'
      version    = $word.Version
      format     = 'wdFormatUnicodeText(7) -> UTF-8'
      paragraphs = $document.Paragraphs.Count
      pages      = $document.ComputeStatistics(2)   # wdStatisticPages
      words      = $document.ComputeStatistics(0)   # wdStatisticWords
      chars      = $text.Length
      input      = (Split-Path -Leaf $inputFull)
      output     = (Split-Path -Leaf $outFull)
    }
  } else {
    # wdFormatXMLDocument = 12 (.docx)
    $document.SaveAs2($outFull, 12)
    $meta = [ordered]@{
      tool       = 'Microsoft Word (COM)'
      version    = $word.Version
      format     = 'wdFormatXMLDocument(12)'
      paragraphs = $document.Paragraphs.Count
      pages      = $document.ComputeStatistics(2)
      words      = $document.ComputeStatistics(0)
      input      = (Split-Path -Leaf $inputFull)
      output     = (Split-Path -Leaf $outFull)
    }
  }

  Write-Output ('##WORD_META## ' + ($meta | ConvertTo-Json -Compress))
} finally {
  if ($document) { try { $document.Close(0) } catch { } }   # wdDoNotSaveChanges = 0
  if ($word) { try { $word.Quit(0) } catch { } }
  foreach ($comObject in @($document, $word)) {
    if ($comObject) { try { [System.Runtime.InteropServices.Marshal]::ReleaseComObject($comObject) | Out-Null } catch { } }
  }
  if ($tempText -and (Test-Path -LiteralPath $tempText)) { Remove-Item -LiteralPath $tempText -Force -ErrorAction SilentlyContinue }
  [GC]::Collect()
}
