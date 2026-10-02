# OCR one image with the built-in Windows OCR engine (Windows.Media.Ocr), offline.
#
# Why this tool: the machine has no tesseract / LibreOffice / poppler and PyPI is
# unreachable, but Windows ships an offline OCR engine. zh-Hans-CN is available here,
# so scanned Chinese pages can be recognised without any cloud service.
#
# Usage:
#   powershell -ExecutionPolicy Bypass -File tools/offline/ocr-image.ps1 `
#       -ImagePath <png|jpg> -Language zh-Hans-CN [-Scale 2] [-OutText <file>]
#
# Output: one line per recognised text line (no OCR boxes), plus a final JSON line:
#   {"engine":"...","language":"...","lines":N,"chars":M,"scale":S,"image":"..."}
# The caller (tools/corpus-cli.mjs) writes page markers around this output.

param(
  [Parameter(Mandatory = $true)][string]$ImagePath,
  [string]$Language = 'zh-Hans-CN',
  [double]$Scale = 2,
  [string]$OutText = '',
  [string]$OutMeta = ''
)

$ErrorActionPreference = 'Stop'

Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Runtime.WindowsRuntime

$null = [Windows.Storage.StorageFile, Windows.Storage, ContentType = WindowsRuntime]
$null = [Windows.Graphics.Imaging.BitmapDecoder, Windows.Graphics.Imaging, ContentType = WindowsRuntime]
$null = [Windows.Media.Ocr.OcrEngine, Windows.Media, ContentType = WindowsRuntime]
$null = [Windows.Globalization.Language, Windows.Globalization, ContentType = WindowsRuntime]

# PS 5.1 cannot await WinRT IAsyncOperation directly; wrap AsTask<T>().
$asTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
    $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
  })[0]

function Await($operation, $resultType) {
  $asTask = $asTaskGeneric.MakeGenericMethod($resultType)
  $task = $asTask.Invoke($null, @($operation))
  $task.Wait(-1) | Out-Null
  return $task.Result
}

if (-not (Test-Path -LiteralPath $ImagePath)) { throw "image not found: $ImagePath" }

# The engine refuses images larger than MaxImageDimension (typically 10000 px). Rendering a
# scanned PDF at scale 2 and then scaling again here easily exceeds it, so clamp the factor.
$maxDimension = [int][Windows.Media.Ocr.OcrEngine]::MaxImageDimension
$sourceInfo = [System.Drawing.Image]::FromFile((Resolve-Path -LiteralPath $ImagePath).Path)
$sourceWidth = $sourceInfo.Width
$sourceHeight = $sourceInfo.Height
$sourceInfo.Dispose()
$effectiveScale = $Scale
while ($effectiveScale -gt 1 -and ([Math]::Max($sourceWidth, $sourceHeight) * $effectiveScale) -gt $maxDimension) {
  $effectiveScale = [Math]::Round($effectiveScale - 0.5, 1)
}
if ([Math]::Max($sourceWidth, $sourceHeight) -gt $maxDimension) { $effectiveScale = 0 }  # engine reads the file as-is
if ($effectiveScale -ne $Scale) {
  Write-Host ("note: OCR scale reduced from {0} to {1} (MaxImageDimension={2}, source {3}x{4})" -f $Scale, $effectiveScale, $maxDimension, $sourceWidth, $sourceHeight)
}

# Upscale small scans: the Windows engine does noticeably better on larger glyphs.
$tempImage = $null
if ($effectiveScale -gt 1) {
  $source = [System.Drawing.Image]::FromFile((Resolve-Path -LiteralPath $ImagePath).Path)
  $width = [int]($source.Width * $effectiveScale)
  $height = [int]($source.Height * $effectiveScale)
  $bitmap = New-Object System.Drawing.Bitmap $width, $height
  $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
  $graphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $graphics.DrawImage($source, 0, 0, $width, $height)
  $graphics.Dispose()
  $source.Dispose()
  $tempImage = [System.IO.Path]::Combine([System.IO.Path]::GetTempPath(), "liuyao-ocr-$([guid]::NewGuid().ToString('N')).png")
  $bitmap.Save($tempImage, [System.Drawing.Imaging.ImageFormat]::Png)
  $bitmap.Dispose()
} else {
  $tempImage = (Resolve-Path -LiteralPath $ImagePath).Path
}

try {
  $file = Await ([Windows.Storage.StorageFile]::GetFileFromPathAsync($tempImage)) ([Windows.Storage.StorageFile])
  $stream = Await ($file.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream])
  $decoder = Await ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
  $softwareBitmap = Await ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])

  # NOTE: PowerShell 5.1 marshals WinRT `Language` objects unreliably: both
  # `New-Object Windows.Globalization.Language 'zh-Hans-CN'` and a Where-Object pipeline
  # produced an object with an empty tag. The user-profile engine and a plain foreach over
  # AvailableRecognizerLanguages both work, so try those in order.
  $engine = $null
  $profileEngine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages()
  if ($null -ne $profileEngine -and $profileEngine.RecognizerLanguage.LanguageTag -eq $Language) {
    $engine = $profileEngine
  }
  if ($null -eq $engine) {
    foreach ($candidate in [Windows.Media.Ocr.OcrEngine]::AvailableRecognizerLanguages) {
      if ($candidate.LanguageTag -eq $Language) {
        $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromLanguage($candidate)
        break
      }
    }
  }
  if ($null -eq $engine) {
    $available = @()
    foreach ($candidate in [Windows.Media.Ocr.OcrEngine]::AvailableRecognizerLanguages) { $available += $candidate.LanguageTag }
    throw "Windows OCR language '$Language' not installed (available: $($available -join ', '))"
  }

  $result = Await ($engine.RecognizeAsync($softwareBitmap)) ([Windows.Media.Ocr.OcrResult])
  $lines = @()
  foreach ($line in $result.Lines) { $lines += $line.Text }

  $chars = 0
  foreach ($line in $lines) { $chars += $line.Length }

  if ($OutText -ne '') {
    $directory = Split-Path -Parent $OutText
    if ($directory -and -not (Test-Path -LiteralPath $directory)) { New-Item -ItemType Directory -Force -Path $directory | Out-Null }
    [System.IO.File]::WriteAllLines($OutText, $lines, (New-Object System.Text.UTF8Encoding($false)))
  }

  foreach ($line in $lines) { Write-Output $line }
  $meta = [ordered]@{
    engine     = "Windows.Media.Ocr ($($engine.RecognizerLanguage.LanguageTag))"
    language   = $Language
    lines      = $lines.Count
    chars      = $chars
    scale      = $effectiveScale
    maxDim     = $maxDimension
    image      = (Split-Path -Leaf $ImagePath)
    imageBytes = (Get-Item -LiteralPath $ImagePath).Length
  }
  $metaJson = $meta | ConvertTo-Json -Compress
  if ($OutMeta -ne '') {
    $metaDirectory = Split-Path -Parent $OutMeta
    if ($metaDirectory -and -not (Test-Path -LiteralPath $metaDirectory)) { New-Item -ItemType Directory -Force -Path $metaDirectory | Out-Null }
    [System.IO.File]::WriteAllText($OutMeta, $metaJson, (New-Object System.Text.UTF8Encoding($false)))
  }
  Write-Output ('##OCR_META## ' + $metaJson)
} finally {
  if ($effectiveScale -gt 1 -and $tempImage -and (Test-Path -LiteralPath $tempImage)) {
    Remove-Item -LiteralPath $tempImage -Force -ErrorAction SilentlyContinue
  }
}
