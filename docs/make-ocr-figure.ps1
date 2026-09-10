# 生成 README 用的示意图：截取计算器数字键盘，把 OCR 识别到的框和置信度画上去。
Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Windows.Forms
Add-Type -TypeDefinition 'using System;using System.Runtime.InteropServices;public class Dp2{[DllImport("user32.dll")]public static extern bool SetProcessDPIAware();}'
[void][Dp2]::SetProcessDPIAware()

# 裁剪区域必须**完全落在计算器窗口内**（窗口 rect 约 59,48 - 561,858）。
# 早先裁 60..560 时边缘带进了约 15px 桌面壁纸和图标，所以向内收了 10px。
$RX = 70; $RY = 520; $RW = 480; $RH = 320
$scale = 2   # 放大 2 倍输出，GitHub 上更清晰

# OCR 结果（来自 RapidOCR，屏幕坐标）
$boxes = @(
    @{ t = '7';   x = 124; y = 553; w = 20; h = 27; s = 1.000 },
    @{ t = '8';   x = 243; y = 553; w = 18; h = 27; s = 0.995 },
    @{ t = '9';   x = 360; y = 553; w = 18; h = 27; s = 0.999 },
    @{ t = '4';   x = 126; y = 631; w = 18; h = 27; s = 0.997 },
    @{ t = '5';   x = 242; y = 631; w = 20; h = 28; s = 1.000 },
    @{ t = '6';   x = 362; y = 632; w = 17; h = 27; s = 0.980 },
    @{ t = '1';   x = 126; y = 712; w = 17; h = 25; s = 1.000 },
    @{ t = '2';   x = 243; y = 712; w = 18; h = 27; s = 0.966 },
    @{ t = '3';   x = 361; y = 712; w = 17; h = 26; s = 0.998 },
    @{ t = '+';   x = 478; y = 712; w = 20; h = 22; s = 0.777 },
    @{ t = '+/-'; x = 120; y = 789; w = 30; h = 28; s = 0.881 },
    @{ t = '0';   x = 243; y = 792; w = 18; h = 24; s = 0.968 }
)

$out = $PSScriptRoot
New-Item -ItemType Directory -Force -Path $out | Out-Null

$bmp = New-Object System.Drawing.Bitmap $RW, $RH, ([System.Drawing.Imaging.PixelFormat]::Format24bppRgb)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen($RX, $RY, 0, 0, (New-Object System.Drawing.Size $RW, $RH))
$g.Dispose()

$big = New-Object System.Drawing.Bitmap ($RW * $scale), ($RH * $scale), ([System.Drawing.Imaging.PixelFormat]::Format24bppRgb)
$g2 = [System.Drawing.Graphics]::FromImage($big)
$g2.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
$g2.DrawImage($bmp, 0, 0, $big.Width, $big.Height)

$pen = New-Object System.Drawing.Pen ([System.Drawing.Color]::FromArgb(230, 220, 40, 40)), (2.4 * $scale)
$font = [System.Drawing.Font]::new('Consolas', [float](7 * $scale), [System.Drawing.FontStyle]::Bold)
$brush = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(230, 220, 40, 40))
$bgBrush = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(210, 255, 255, 255))

foreach ($b in $boxes) {
    $x = ($b.x - $RX) * $scale
    $y = ($b.y - $RY) * $scale
    $w = $b.w * $scale
    $h = $b.h * $scale
    $g2.DrawRectangle($pen, $x, $y, $w, $h)

    $label = '{0} {1:N2}' -f $b.t, $b.s
    $sz = $g2.MeasureString($label, $font)
    $ly = $y - $sz.Height
    if ($ly -lt 0) { $ly = $y + $h }
    $g2.FillRectangle($bgBrush, $x, $ly, $sz.Width, $sz.Height)
    $g2.DrawString($label, $font, $brush, $x, $ly)
}

$g2.Dispose(); $bmp.Dispose()

$big.Save("$out\ocr-boxes.png", [System.Drawing.Imaging.ImageFormat]::Png)
$big.Dispose()
$pen.Dispose(); $font.Dispose(); $brush.Dispose(); $bgBrush.Dispose()
"saved: $out\ocr-boxes.png  ($($RW*$scale)x$($RH*$scale))"
