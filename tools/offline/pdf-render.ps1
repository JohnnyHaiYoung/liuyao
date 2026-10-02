# Render PDF pages to PNG with the built-in Windows PDF renderer (Windows.Data.Pdf), offline.
#
# Why this tool: the machine has no poppler / mupdf / PyMuPDF, and the scanned candidate uses
# CCITTFaxDecode (G4 fax) images that would need a full fax decoder to rasterise by hand.
# Windows ships a PDF rasteriser, so scanned pages can be turned into images for OCR without
# any cloud service and without third-party binaries.
#
# Usage:
#   powershell -ExecutionPolicy Bypass -File tools/offline/pdf-render.ps1 `
#       -PdfPath <file> -OutDir <dir> -Pages 1-5 [-Scale 2] [-Prefix page]
#
# Output: one PNG per rendered page named <Prefix>-<pageNumber:000>.png plus a final JSON line:
#   {"pageCount":5,"rendered":[1,2,3],"scale":2,"engine":"Windows.Data.Pdf"}

param(
  [Parameter(Mandatory = $true)][string]$PdfPath,
  [Parameter(Mandatory = $true)][string]$OutDir,
  [Parameter(Mandatory = $true)][string]$Pages,      # 1-based, e.g. "1-5" or "1,3,5"
  [double]$Scale = 1,
  [string]$Prefix = 'page',
  [string]$OutMeta = ''
)

$ErrorActionPreference = 'Stop'

Add-Type -AssemblyName System.Runtime.WindowsRuntime
Add-Type -AssemblyName System.Drawing
$null = [Windows.Data.Pdf.PdfDocument, Windows.Data.Pdf, ContentType = WindowsRuntime]
$null = [Windows.Storage.StorageFile, Windows.Storage, ContentType = WindowsRuntime]
$null = [Windows.Storage.StorageFolder, Windows.Storage, ContentType = WindowsRuntime]
$null = [Windows.Storage.Streams.IRandomAccessStream, Windows.Storage.Streams, ContentType = WindowsRuntime]

$methods = [System.WindowsRuntimeSystemExtensions].GetMethods()
$asTaskOperation = ($methods | Where-Object {
    $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
  })[0]
$asTaskAction = ($methods | Where-Object {
    $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncAction'
  })[0]

function Await($operation, $resultType) {
  $task = $asTaskOperation.MakeGenericMethod($resultType).Invoke($null, @($operation))
  $task.Wait(-1) | Out-Null
  return $task.Result
}
function AwaitAction($action) {
  $task = $asTaskAction.Invoke($null, @($action))
  $task.Wait(-1) | Out-Null
}

function Expand-PageSpec([string]$spec, [int]$max) {
  $list = @()
  foreach ($part in $spec -split ',') {
    $piece = $part.Trim()
    if ($piece -match '^(\d+)\s*-\s*(\d+)$') {
      for ($i = [int]$Matches[1]; $i -le [int]$Matches[2]; $i++) { if ($i -ge 1 -and $i -le $max) { $list += $i } }
    } elseif ($piece -match '^\d+$') {
      $i = [int]$piece
      if ($i -ge 1 -and $i -le $max) { $list += $i }
    }
  }
  return ($list | Sort-Object -Unique)
}

if (-not (Test-Path -LiteralPath $PdfPath)) { throw "pdf not found: $PdfPath" }
$pdfFull = (Resolve-Path -LiteralPath $PdfPath).Path
if (-not (Test-Path -LiteralPath $OutDir)) { New-Item -ItemType Directory -Force -Path $OutDir | Out-Null }
$outFull = (Resolve-Path -LiteralPath $OutDir).Path

$file = Await ([Windows.Storage.StorageFile]::GetFileFromPathAsync($pdfFull)) ([Windows.Storage.StorageFile])
$document = Await ([Windows.Data.Pdf.PdfDocument]::LoadFromFileAsync($file)) ([Windows.Data.Pdf.PdfDocument])
$pageCount = [int]$document.PageCount
$targets = Expand-PageSpec $Pages $pageCount

$folder = Await ([Windows.Storage.StorageFolder]::GetFolderFromPathAsync($outFull)) ([Windows.Storage.StorageFolder])
$rendered = @()
foreach ($pageNumber in $targets) {
  $page = $document.GetPage($pageNumber - 1)
  $options = New-Object Windows.Data.Pdf.PdfPageRenderOptions
  $options.DestinationWidth = [uint32][Math]::Round($page.Size.Width * $Scale)
  $options.DestinationHeight = [uint32][Math]::Round($page.Size.Height * $Scale)

  $name = ('{0}-{1:D3}.png' -f $Prefix, $pageNumber)
  $outFile = Await ($folder.CreateFileAsync($name, [Windows.Storage.CreationCollisionOption]::ReplaceExisting)) ([Windows.Storage.StorageFile])
  $stream = Await ($outFile.OpenAsync([Windows.Storage.FileAccessMode]::ReadWrite)) ([Windows.Storage.Streams.IRandomAccessStream])
  try {
    AwaitAction ($page.RenderToStreamAsync($stream, $options))
  } finally {
    # PdfPage has no projected Close()/Dispose() in PowerShell 5.1; the stream must be
    # disposed to flush the image to disk, and the COM page object is freed by GC.
    $stream.Dispose()
  }
  $path = Join-Path $outFull $name
  $image = [System.Drawing.Image]::FromFile($path)
  $pixels = "$($image.Width)x$($image.Height)"
  $image.Dispose()
  $rendered += [ordered]@{ page = $pageNumber; file = $name; pixels = $pixels; bytes = (Get-Item -LiteralPath $path).Length }
  Write-Output ("rendered page {0} -> {1} ({2} px, {3:N0} bytes)" -f $pageNumber, $name, $pixels, (Get-Item -LiteralPath $path).Length)
}

$meta = [ordered]@{
  engine    = "Windows.Data.Pdf (Windows $([System.Environment]::OSVersion.Version))"
  pageCount = $pageCount
  rendered  = $rendered
  scale     = $Scale
  pdf       = (Split-Path -Leaf $pdfFull)
}
$metaJson = $meta | ConvertTo-Json -Compress -Depth 5
if ($OutMeta -ne '') {
  $metaDirectory = Split-Path -Parent $OutMeta
  if ($metaDirectory -and -not (Test-Path -LiteralPath $metaDirectory)) { New-Item -ItemType Directory -Force -Path $metaDirectory | Out-Null }
  [System.IO.File]::WriteAllText($OutMeta, $metaJson, (New-Object System.Text.UTF8Encoding($false)))
}
Write-Output ('##PDF_RENDER_META## ' + $metaJson)
