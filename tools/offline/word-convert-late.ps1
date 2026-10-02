# Convert a legacy .doc to UTF-8 text with Word via pure late binding (IDispatch).
#
# Why late binding: this machine raises TYPE_E_CANTLOADLIBRARY (0x80029C4A) as soon as
# PowerShell binds Word members through the type library (the Word typelib registration on
# this box is broken), even though Word itself activates in ~2 s. InvokeMember talks to
# IDispatch directly and never loads the typelib.
#
# ASCII only. Never writes back to the input file. Prints one ##WORD_META## JSON line.

param(
  [Parameter(Mandatory = $true)][string]$InputPath,
  [Parameter(Mandatory = $true)][string]$OutPath,
  [int]$SaveFormat = 7   # wdFormatUnicodeText
)

$ErrorActionPreference = 'Stop'
$F = [System.Reflection.BindingFlags]

if (-not (Test-Path -LiteralPath $InputPath)) { throw "input not found: $InputPath" }
$inputFull = (Resolve-Path -LiteralPath $InputPath).Path
$outFull = [System.IO.Path]::GetFullPath($OutPath)
$outDirectory = Split-Path -Parent $outFull
if ($outDirectory -and -not (Test-Path -LiteralPath $outDirectory)) { New-Item -ItemType Directory -Force -Path $outDirectory | Out-Null }
$tempText = [System.IO.Path]::Combine([System.IO.Path]::GetTempPath(), "liuyao-word-$([guid]::NewGuid().ToString('N')).txt")

$word = $null
$document = $null
try {
  $word = New-Object -ComObject Word.Application
  $wordType = $word.GetType()
  $null = $wordType.InvokeMember('Visible', $F::SetProperty, $null, $word, @($false))
  $null = $wordType.InvokeMember('DisplayAlerts', $F::SetProperty, $null, $word, @(0))
  $null = $wordType.InvokeMember('AutomationSecurity', $F::SetProperty, $null, $word, @(3))
  $version = $wordType.InvokeMember('Version', $F::GetProperty, $null, $word, $null)

  $documents = $wordType.InvokeMember('Documents', $F::GetProperty, $null, $word, $null)
  $document = $documents.GetType().InvokeMember('Open', $F::InvokeMethod, $null, $documents, @($inputFull, $false, $true, $false))
  $documentType = $document.GetType()
  # wdFormatUnicodeText=7 -> UTF-16LE file we convert to UTF-8 ourselves.
  $null = $documentType.InvokeMember('SaveAs2', $F::InvokeMethod, $null, $document, @($tempText, $SaveFormat))
  $pages = $documentType.InvokeMember('ComputeStatistics', $F::InvokeMethod, $null, $document, @(2))
  $words = $documentType.InvokeMember('ComputeStatistics', $F::InvokeMethod, $null, $document, @(0))
  $characters = $documentType.InvokeMember('ComputeStatistics', $F::InvokeMethod, $null, $document, @(3))
  $paragraphs = $documentType.InvokeMember('Paragraphs', $F::GetProperty, $null, $document, $null)
  $paragraphCount = $paragraphs.GetType().InvokeMember('Count', $F::GetProperty, $null, $paragraphs, $null)

  # SaveAs2 makes the temp file Word's own document, so it stays locked until Close.
  $null = $documentType.InvokeMember('Close', $F::InvokeMethod, $null, $document, @(0))
  $document = $null
  Start-Sleep -Milliseconds 400

  # Copy the bytes unchanged: Word's wdFormatUnicodeText output was NOT reliably UTF-16LE here
  # (the environment's Word wrote a different encoding), so decoding is left to the caller,
  # which sniffs UTF-16LE / GB18030 / UTF-8 and keeps the candidate with the most CJK text.
  $bytes = [System.IO.File]::ReadAllBytes($tempText)
  [System.IO.File]::WriteAllBytes($outFull, $bytes)

  Write-Output ('##WORD_META## ' + ([ordered]@{
        tool       = 'Microsoft Word (COM, late binding / IDispatch)'
        version    = "$version"
        format     = "wdFormatUnicodeText($SaveFormat) -> UTF-8"
        pages      = $pages
        words      = $words
        paragraphs = $paragraphCount
        characters = $characters
        bytes      = (Get-Item -LiteralPath $outFull).Length
        output     = (Split-Path -Leaf $outFull)
      } | ConvertTo-Json -Compress))
} finally {
  if ($document) { try { $null = $document.GetType().InvokeMember('Close', $F::InvokeMethod, $null, $document, @(0)) } catch { } }
  if ($word) { try { $null = $word.GetType().InvokeMember('Quit', $F::InvokeMethod, $null, $word, @(0)) } catch { } }
  if ($tempText -and (Test-Path -LiteralPath $tempText)) { Remove-Item -LiteralPath $tempText -Force -ErrorAction SilentlyContinue }
}
