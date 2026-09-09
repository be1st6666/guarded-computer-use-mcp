#requires -Version 5.1
<#
  Standalone OCR helper. Must run under Windows PowerShell 5.1: PowerShell 7
  (.NET Core) has no built-in WinRT projection, so Windows.Media.Ocr is only
  reachable from the .NET Framework shell.

  Usage:
    powershell.exe -NoProfile -ExecutionPolicy Bypass -File ocr.ps1 -X 0 -Y 0 -W 800 -H 600
    (omit X/Y/W/H for the full virtual screen)

  Output: one compact JSON object on stdout:
    {"text":"...","words":[{"t":"<word>","box":[420,310,60,28],"line":0}],"ms":123}
  Word boxes are in screen coordinates (capture origin is added back).

  THIS FILE MUST STAY PURE ASCII (PS 5.1 reads .ps1 as ANSI without a BOM).
#>
param(
    [int]$X = [int]::MinValue,
    [int]$Y = [int]::MinValue,
    [int]$W = 0,
    [int]$H = 0,
    [double]$Scale = 1.0
)

$ErrorActionPreference = 'Stop'

function Fail($msg) {
    $esc = $msg -replace '\\', '\\\\' -replace '"', '\"' -replace "`r", ' ' -replace "`n", ' '
    [Console]::Out.WriteLine('{"error":"' + $esc + '"}')
    exit 1
}

Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Runtime.WindowsRuntime
Add-Type -TypeDefinition 'using System;using System.Runtime.InteropServices;public class Dpi{[DllImport("user32.dll")]public static extern bool SetProcessDPIAware();}'
try { [void][Dpi]::SetProcessDPIAware() } catch { }

# ---- resolve capture rectangle ----
if ($X -eq [int]::MinValue -or $W -le 0 -or $H -le 0) {
    $b = [System.Windows.Forms.SystemInformation]::VirtualScreen
    $X = $b.X; $Y = $b.Y; $W = $b.Width; $H = $b.Height
}

# ---- WinRT projections ----
try {
    [void][Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType = WindowsRuntime]
    [void][Windows.Storage.StorageFile, Windows.Foundation, ContentType = WindowsRuntime]
    [void][Windows.Graphics.Imaging.BitmapDecoder, Windows.Foundation, ContentType = WindowsRuntime]
} catch { Fail ("WinRT types unavailable: " + $_.Exception.Message) }

$engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages()
if (-not $engine) { Fail 'no OCR recognizer available (install a language pack)'; }

$asTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
    $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and
    $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1' })[0]
function Await($op, $resultType) {
    $task = $asTaskGeneric.MakeGenericMethod($resultType).Invoke($null, @($op))
    $task.Wait(-1) | Out-Null
    $task.Result
}

# ---- capture to a temp png ----
$tmp = [System.IO.Path]::Combine([System.IO.Path]::GetTempPath(), 'dsh-ocr-' + [guid]::NewGuid().ToString('N') + '.png')
$sw = [System.Diagnostics.Stopwatch]::StartNew()
try {
    $bmp = New-Object System.Drawing.Bitmap $W, $H, ([System.Drawing.Imaging.PixelFormat]::Format24bppRgb)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.CopyFromScreen($X, $Y, 0, 0, (New-Object System.Drawing.Size $W, $H))
    $g.Dispose()
    # Windows OCR is tuned for document-sized text and misses very large glyphs
    # (it read the calculator's tiny labels but not its big digit buttons).
    # Downscaling first puts them back in the recognisable size range.
    if ($Scale -ne 1.0) {
        $sw2 = [int][math]::Round($W * $Scale)
        $sh2 = [int][math]::Round($H * $Scale)
        $small = New-Object System.Drawing.Bitmap $sw2, $sh2, ([System.Drawing.Imaging.PixelFormat]::Format24bppRgb)
        $g2 = [System.Drawing.Graphics]::FromImage($small)
        $g2.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
        $g2.DrawImage($bmp, 0, 0, $sw2, $sh2)
        $g2.Dispose(); $bmp.Dispose()
        $small.Save($tmp, [System.Drawing.Imaging.ImageFormat]::Png)
        $small.Dispose()
    } else {
        $bmp.Save($tmp, [System.Drawing.Imaging.ImageFormat]::Png)
        $bmp.Dispose()
    }
} catch { Remove-Item $tmp -Force -ErrorAction SilentlyContinue; Fail ("capture failed: " + $_.Exception.Message) }
$tCapture = [math]::Round($sw.Elapsed.TotalMilliseconds, 1)

# ---- recognize ----
$sw.Restart()
try {
    $file    = Await ([Windows.Storage.StorageFile]::GetFileFromPathAsync($tmp)) ([Windows.Storage.StorageFile])
    $stream  = Await ($file.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream])
    $decoder = Await ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
    $bitmap  = Await ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])
    $result  = Await ($engine.RecognizeAsync($bitmap)) ([Windows.Media.Ocr.OcrResult])
    $stream.Dispose()
} catch { Remove-Item $tmp -Force -ErrorAction SilentlyContinue; Fail ("ocr failed: " + $_.Exception.Message) }
$tOcr = [math]::Round($sw.Elapsed.TotalMilliseconds, 1)
Remove-Item $tmp -Force -ErrorAction SilentlyContinue

# ---- serialize ----
function Esc($s) {
    if ($null -eq $s) { return '' }
    $sb = New-Object System.Text.StringBuilder
    foreach ($c in $s.ToCharArray()) {
        $i = [int]$c
        if ($c -eq '"') { [void]$sb.Append('\"') }
        elseif ($c -eq '\') { [void]$sb.Append('\\') }
        elseif ($i -lt 32 -or $i -gt 126) { [void]$sb.Append('\u' + $i.ToString('x4')) }
        else { [void]$sb.Append($c) }
    }
    $sb.ToString()
}

$sb = New-Object System.Text.StringBuilder
[void]$sb.Append('{"text":"' + (Esc $result.Text) + '","words":[')
$first = $true
$lineNo = 0
foreach ($line in $result.Lines) {
    foreach ($word in $line.Words) {
        $r = $word.BoundingRect
        if (-not $first) { [void]$sb.Append(',') }
        $first = $false
        [void]$sb.Append('{"t":"' + (Esc $word.Text) + '","box":[')
        [void]$sb.Append([int]($X + $r.X / $Scale)).Append(',').Append([int]($Y + $r.Y / $Scale)).Append(',')
        [void]$sb.Append([int]($r.Width / $Scale)).Append(',').Append([int]($r.Height / $Scale)).Append(']')
        [void]$sb.Append(',"line":' + $lineNo + '}')
    }
    $lineNo++
}
[void]$sb.Append('],"ms":{"capture":' + $tCapture + ',"ocr":' + $tOcr + '}')
[void]$sb.Append(',"region":[' + $X + ',' + $Y + ',' + $W + ',' + $H + ']}')

[Console]::Out.WriteLine($sb.ToString())
