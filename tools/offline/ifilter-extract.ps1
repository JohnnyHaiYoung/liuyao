# Extract text with the Windows/Office IFilter installed for the file's extension.
#
# Why: this machine has no network (PyPI and npm registries are unreachable) but Windows ships
# independent text filters - OffFilt.dll (.doc), OFFFILTX.DLL (.docx), Windows.Data.Pdf.dll
# (.pdf). They are Microsoft's own parsers, so they act as an independent oracle for cross
# checking the hand-written Node parsers in tools/lib/. ASCII only.
#
# Usage: powershell -File tools/offline/ifilter-extract.ps1 -InputPath <file> -OutPath <utf8 txt>

param(
  [Parameter(Mandatory = $true)][string]$InputPath,
  [Parameter(Mandatory = $true)][string]$OutPath
)

$ErrorActionPreference = 'Stop'
if (-not (Test-Path -LiteralPath $InputPath)) { throw "input not found: $InputPath" }
$inputFull = (Resolve-Path -LiteralPath $InputPath).Path

$source = @'
using System;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;

public static class NativeFilter
{
    private const int CHUNK_TEXT = 0x1;

    [DllImport("query.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern int LoadIFilter(string path, IntPtr outer, out IFilter filter);

    [ComImport, Guid("89BCB740-6119-101A-BCB7-00DD010655AF"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IFilter
    {
        void Init(uint grfFlags, uint cAttributes, IntPtr aAttributes, out uint pdwFlags);
        void GetChunk(out STAT_CHUNK stat);
        void GetText(ref uint bufferSize, [Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder buffer);
        void GetValue(IntPtr propVar);
        void BindRegion(IntPtr region, ref Guid riid, out IntPtr ppunk);
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct FULLPROPSPEC { public Guid guidPropSet; public IntPtr propIdOrName; }

    [StructLayout(LayoutKind.Sequential)]
    private struct STAT_CHUNK
    {
        public uint idChunk;
        public uint breakType;
        public uint flags;
        public uint locale;
        public FULLPROPSPEC attribute;
        public uint idChunkSource;
        public uint cwcStartSource;
        public uint cwcLenSource;
    }

    public static string Extract(string path)
    {
        IFilter filter;
        int hr = LoadIFilter(path, IntPtr.Zero, out filter);
        if (hr != 0 || filter == null) { throw new Exception("LoadIFilter failed, hr=0x" + hr.ToString("X8")); }

        uint initFlags;
        filter.Init(0, 0, IntPtr.Zero, out initFlags);

        var builder = new StringBuilder();
        int guard = 0;
        while (guard++ < 2000000)
        {
            STAT_CHUNK chunk;
            try { filter.GetChunk(out chunk); }
            catch { break; }               // FILTER_E_END_OF_CHUNKS
            if (chunk.flags != CHUNK_TEXT) { continue; }
            for (;;)
            {
                // A fresh buffer per call is essential: reusing one StringBuilder and only
                // clearing its Length leaves the previous capacity/content behind, which made
                // the marshaller append stale text plus junk (inflating counts ~23x).
                const int capacity = 65536;
                var chunkBuffer = new StringBuilder(capacity);
                uint size = capacity;
                try { filter.GetText(ref size, chunkBuffer); }
                catch { break; }           // FILTER_E_NO_MORE_TEXT in this chunk
                int take = (int)Math.Min(size, (uint)chunkBuffer.Length);
                if (take <= 0) { break; }
                builder.Append(chunkBuffer.ToString(0, take));
            }
        }
        return builder.ToString();
    }
}
'@

Add-Type -TypeDefinition $source -Language CSharp | Out-Null
$text = [NativeFilter]::Extract($inputFull)

$directory = Split-Path -Parent $OutPath
if ($directory -and -not (Test-Path -LiteralPath $directory)) { New-Item -ItemType Directory -Force -Path $directory | Out-Null }
[System.IO.File]::WriteAllText($OutPath, $text, (New-Object System.Text.UTF8Encoding($false)))

$cjk = ([regex]::Matches($text, '[\u4e00-\u9fff]')).Count
Write-Output ('##IFILTER_META## ' + ([ordered]@{
      filter = 'Windows/Office IFilter (query.dll!LoadIFilter)'
      file   = (Split-Path -Leaf $inputFull)
      chars  = $text.Length
      cjk    = $cjk
      bytes  = (Get-Item -LiteralPath $OutPath).Length
      output = (Split-Path -Leaf $OutPath)
    } | ConvertTo-Json -Compress))
