# Downscale an image to a JPEG for packaging (keeps page evidence small).
#
# Why: rendered PDF pages are large (4400x6080 PNG = ~5 MB each). The package only needs
# legible page evidence for figures/hexagram rows, so assets are stored as JPEG at a bounded
# width. The full-resolution render stays in storage/work (excluded from the package).
#
# Usage:
#   powershell -ExecutionPolicy Bypass -File tools/offline/image-downscale.ps1 `
#       -InputPath <png> -OutputPath <jpg> [-MaxWidth 1400] [-Quality 82]
#
# Output: final JSON line {"tool":"System.Drawing","input":...,"output":...,"width":..,"height":..,"bytes":..}

param(
  [Parameter(Mandatory = $true)][string]$InputPath,
  [Parameter(Mandatory = $true)][string]$OutputPath,
  [int]$MaxWidth = 1400,
  [int]$Quality = 82
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

if (-not (Test-Path -LiteralPath $InputPath)) { throw "input not found: $InputPath" }
$directory = Split-Path -Parent $OutputPath
if ($directory -and -not (Test-Path -LiteralPath $directory)) { New-Item -ItemType Directory -Force -Path $directory | Out-Null }

$source = [System.Drawing.Image]::FromFile((Resolve-Path -LiteralPath $InputPath).Path)
try {
  $ratio = [Math]::Min(1.0, $MaxWidth / [double]$source.Width)
  $width = [int][Math]::Round($source.Width * $ratio)
  $height = [int][Math]::Round($source.Height * $ratio)
  $bitmap = New-Object System.Drawing.Bitmap $width, $height
  $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
  try {
    $graphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $graphics.DrawImage($source, 0, 0, $width, $height)
  } finally {
    $graphics.Dispose()
  }
  $codec = [System.Drawing.Imaging.ImageCodecInfo]::GetImageEncoders() | Where-Object { $_.MimeType -eq 'image/jpeg' }
  $parameters = New-Object System.Drawing.Imaging.EncoderParameters 1
  $parameters.Param[0] = New-Object System.Drawing.Imaging.EncoderParameter ([System.Drawing.Imaging.Encoder]::Quality), ([int64]$Quality)
  try {
    $bitmap.Save($OutputPath, $codec, $parameters)
  } finally {
    $bitmap.Dispose()
    $parameters.Dispose()
  }
} finally {
  $source.Dispose()
}

$meta = [ordered]@{
  tool   = "System.Drawing ($([System.Environment]::OSVersion.Version))"
  input  = (Split-Path -Leaf $InputPath)
  output = (Split-Path -Leaf $OutputPath)
  width  = $width
  height = $height
  bytes  = (Get-Item -LiteralPath $OutputPath).Length
}
Write-Output ('##IMAGE_META## ' + ($meta | ConvertTo-Json -Compress))
