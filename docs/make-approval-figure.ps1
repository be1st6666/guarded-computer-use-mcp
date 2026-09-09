# 生成 README 用的审批弹窗截图：启动对话框 → 按窗口实际矩形精确截取 → 放大 2 倍保存。
Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Windows.Forms
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;
public class WinCap {
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr p);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  public delegate bool EnumProc(IntPtr h, IntPtr p);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }
  public static IntPtr Find(string sub) {
    IntPtr found = IntPtr.Zero;
    EnumWindows(delegate(IntPtr h, IntPtr p) {
      if (!IsWindowVisible(h)) return true;
      StringBuilder sb = new StringBuilder(512);
      GetWindowText(h, sb, 512);
      if (sb.ToString().IndexOf(sub, StringComparison.OrdinalIgnoreCase) >= 0) { found = h; return false; }
      return true;
    }, IntPtr.Zero);
    return found;
  }
}
'@
[void][WinCap]::SetProcessDPIAware()

$d = 'D:\dsh-workspace\computer-use-mcp'
$out = "$d\docs"

# 起一个演示用的对话框（20 秒后自动关闭）
# 注意：不能加 -WindowStyle Hidden —— 它会让对话框本身也不可见
Start-Process -FilePath 'C:\Users\18858\PowerShell7\PowerShell\7\pwsh.exe' -ArgumentList `
  '-NoProfile', '-File', "`"$d\approval.ps1`"",
  '-Action', 'click_element',
  '-Target', '"chrome  |  Online Banking - Transfer"',
  '-Reason', '"target window title looks sensitive"',
  '-TimeoutMs', '20000'

$h = [IntPtr]::Zero
for ($i = 0; $i -lt 40; $i++) {
    Start-Sleep -Milliseconds 250
    $h = [WinCap]::Find('approval required')
    if ($h -ne [IntPtr]::Zero) { break }
}
if ($h -eq [IntPtr]::Zero) { Write-Output 'DIALOG_NOT_FOUND'; exit 1 }

$r = New-Object WinCap+RECT
[void][WinCap]::GetWindowRect($h, [ref]$r)
$w = $r.R - $r.L; $hh = $r.B - $r.T
Write-Output "dialog rect: $($r.L),$($r.T) ${w}x${hh}"

Start-Sleep -Milliseconds 400   # 让窗口完全绘制
$bmp = New-Object System.Drawing.Bitmap $w, $hh, ([System.Drawing.Imaging.PixelFormat]::Format24bppRgb)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen($r.L, $r.T, 0, 0, (New-Object System.Drawing.Size $w, $hh))
$g.Dispose()

$scale = 2
$big = New-Object System.Drawing.Bitmap ($w * $scale), ($hh * $scale), ([System.Drawing.Imaging.PixelFormat]::Format24bppRgb)
$g2 = [System.Drawing.Graphics]::FromImage($big)
$g2.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
$g2.DrawImage($bmp, 0, 0, $big.Width, $big.Height)
$g2.Dispose()

$big.Save("$out\approval-dialog.png", [System.Drawing.Imaging.ImageFormat]::Png)
$big.Dispose(); $bmp.Dispose()

# 关掉对话框
Add-Type -TypeDefinition 'using System;using System.Runtime.InteropServices;public class Wc{[DllImport("user32.dll")]public static extern bool PostMessage(IntPtr h,uint m,IntPtr w,IntPtr l);}'
[void][Wc]::PostMessage($h, 0x0010, [IntPtr]::Zero, [IntPtr]::Zero)   # WM_CLOSE
Write-Output "saved: $out\approval-dialog.png  ($($w*$scale)x$($hh*$scale))"
