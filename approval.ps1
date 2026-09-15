#requires -Version 5.1
<#
  Approval dialog for guarded-computer-use-mcp.

  Shown when a tool call matches the safety gate. The MCP server blocks on this
  process and uses its exit code, so a human decision is required.

  Exit codes:
    0 = allowed once
    1 = denied
    2 = timed out (treated as denied)
    3 = dialog could not be shown (caller falls back to pending_safety_check)
    4 = allowed AND remember this target for the rest of the session

  Deliberate safety choices:
    * Enter does NOT allow. Deny is the focused default; Allow needs Alt+A or a
      mouse click. A stray keystroke must never approve a destructive action.
    * Esc and the window close button both deny.
    * The countdown auto-denies.
    * -BlockInjected 1 installs a low-level keyboard/mouse hook and swallows
      every event that carries the Windows "injected" flag (LLKHF_INJECTED /
      LLMHF_INJECTED). SendInput from any automation tool — this MCP server, a
      sibling MCP server, a script — therefore cannot press Alt+A or click
      Allow. Only physical input answers the dialog. The number of ignored
      injections is displayed, so an attempt is visible rather than silent.
      A UIAutomation InvokePattern does not go through the hook; see
      SECURITY.md for what that leaves open.

  Saved with a UTF-8 BOM so Windows PowerShell 5.1 reads the CJK labels
  correctly.
#>
param(
    [string]$Action = 'unknown action',
    [string]$Target = '',
    [string]$Detail = '',
    [string]$Reason = '',
    [int]$TimeoutMs = 30000,
    [int]$BlockInjected = 0
)

$ErrorActionPreference = 'Stop'
$result = 3

try {
    Add-Type -AssemblyName System.Windows.Forms
    Add-Type -AssemblyName System.Drawing
} catch {
    exit 3
}

# ---- DPI awareness -----------------------------------------------------------
# The injected-input filter compares the low-level hook's physical screen
# coordinates with the Allow button's rectangle. A DPI-unaware process is
# virtualised by Windows, so those two would not agree on a scaled display and a
# real click on Allow would be mistaken for a non-physical one. Declare awareness
# before any window exists.
try {
    Add-Type -TypeDefinition 'using System;using System.Runtime.InteropServices;public class GcuDpi { [DllImport("user32.dll")] public static extern bool SetProcessDPIAware(); }'
    [void][GcuDpi]::SetProcessDPIAware()
} catch { }

# ---- injected-input filter --------------------------------------------------
# Installed before the dialog appears; the hook needs the message loop that
# ShowDialog is about to run on this same thread.
$injectedFilter = 'off'
if ($BlockInjected -eq 1) {
    $injectedFilter = 'unavailable'
    try {
        if (-not ('DshInputGuard' -as [type])) {
            Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

public static class DshInputGuard
{
    private const int WH_KEYBOARD_LL = 13;
    private const int WH_MOUSE_LL = 14;
    private const uint LLKHF_INJECTED = 0x10;
    private const uint LLMHF_INJECTED = 0x01;

    private delegate IntPtr HookProc(int nCode, IntPtr wParam, IntPtr lParam);

    [StructLayout(LayoutKind.Sequential)]
    private struct KBDLLHOOKSTRUCT
    {
        public uint vkCode; public uint scanCode; public uint flags; public uint time; public IntPtr dwExtraInfo;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct MSLLHOOKSTRUCT
    {
        public int ptX; public int ptY; public uint mouseData; public uint flags; public uint time; public IntPtr dwExtraInfo;
    }

    [DllImport("user32.dll", SetLastError = true)]
    private static extern IntPtr SetWindowsHookEx(int idHook, HookProc lpfn, IntPtr hMod, uint dwThreadId);

    [DllImport("user32.dll", SetLastError = true)]
    private static extern bool UnhookWindowsHookEx(IntPtr hhk);

    [DllImport("user32.dll")]
    private static extern IntPtr CallNextHookEx(IntPtr hhk, int nCode, IntPtr wParam, IntPtr lParam);

    [DllImport("kernel32.dll", CharSet = CharSet.Auto)]
    private static extern IntPtr GetModuleHandle(string lpModuleName);

    private static HookProc kbProc;
    private static HookProc mouseProc;
    private static IntPtr kbHook = IntPtr.Zero;
    private static IntPtr mouseHook = IntPtr.Zero;

    public static int Swallowed;
    public static bool Installed;

    // A human decision must be a PHYSICAL event, not a window message. A plain
    // WinForms button can be activated by PostMessage(BM_CLICK) or
    // WM_KEYDOWN from any same-user process without ever producing an injected
    // input event, so the button's Click handler is not proof of anything while
    // the filter is on. These two hooks see the real input, so they are what
    // grants the allow; the Click handler only checks the flag they set.
    public static bool PhysicalAllow;
    public static int RectX, RectY, RectW, RectH;
    private static bool altDown;

    public static void SetAllowRect(int x, int y, int w, int h)
    {
        RectX = x; RectY = y; RectW = w; RectH = h;
    }

    public static bool Install()
    {
        kbProc = new HookProc(KbCallback);
        mouseProc = new HookProc(MouseCallback);
        IntPtr mod = GetModuleHandle(null);
        kbHook = SetWindowsHookEx(WH_KEYBOARD_LL, kbProc, mod, 0);
        mouseHook = SetWindowsHookEx(WH_MOUSE_LL, mouseProc, mod, 0);
        Installed = (kbHook != IntPtr.Zero) && (mouseHook != IntPtr.Zero);
        return Installed;
    }

    public static void Uninstall()
    {
        if (kbHook != IntPtr.Zero) { UnhookWindowsHookEx(kbHook); kbHook = IntPtr.Zero; }
        if (mouseHook != IntPtr.Zero) { UnhookWindowsHookEx(mouseHook); mouseHook = IntPtr.Zero; }
        Installed = false;
    }

    private static IntPtr KbCallback(int nCode, IntPtr wParam, IntPtr lParam)
    {
        if (nCode >= 0)
        {
            KBDLLHOOKSTRUCT k = (KBDLLHOOKSTRUCT)Marshal.PtrToStructure(lParam, typeof(KBDLLHOOKSTRUCT));
            if ((k.flags & LLKHF_INJECTED) != 0) { Swallowed = Swallowed + 1; return (IntPtr)1; }

            // Physical Alt+A. VK_MENU = 0x12, 'A' = 0x41.
            int msg = wParam.ToInt32();
            bool keyDown = (msg == 0x0100) || (msg == 0x0104);   // WM_KEYDOWN / WM_SYSKEYDOWN
            bool keyUp = (msg == 0x0101) || (msg == 0x0105);     // WM_KEYUP   / WM_SYSKEYUP
            if (k.vkCode == 0x12) { altDown = keyDown; }
            else if (keyDown && k.vkCode == 0x41 && altDown) { PhysicalAllow = true; }
            else if (keyUp && k.vkCode == 0x41) { /* nothing */ }
        }
        return CallNextHookEx(kbHook, nCode, wParam, lParam);
    }

    private static IntPtr MouseCallback(int nCode, IntPtr wParam, IntPtr lParam)
    {
        if (nCode >= 0)
        {
            MSLLHOOKSTRUCT m = (MSLLHOOKSTRUCT)Marshal.PtrToStructure(lParam, typeof(MSLLHOOKSTRUCT));
            if ((m.flags & LLMHF_INJECTED) != 0) { Swallowed = Swallowed + 1; return (IntPtr)1; }

            // Physical left click inside the Allow button.
            if (wParam.ToInt32() == 0x0201 && RectW > 0)     // WM_LBUTTONDOWN
            {
                if (m.ptX >= RectX && m.ptX <= RectX + RectW && m.ptY >= RectY && m.ptY <= RectY + RectH)
                {
                    PhysicalAllow = true;
                }
            }
        }
        return CallNextHookEx(mouseHook, nCode, wParam, lParam);
    }
}
'@
        }
        if ([DshInputGuard]::Install()) { $injectedFilter = 'on' } else { $injectedFilter = 'unavailable' }
    } catch {
        $injectedFilter = 'unavailable'
    }
}

# Line the server parses to learn whether the filter is really active.
Write-Output "injected-input=$injectedFilter"

# ---- localization: follow the OS UI language -------------------------------
$zh = ([System.Globalization.CultureInfo]::CurrentUICulture.Name -like 'zh*')
# Single language, not bilingual: two languages side by side overflow the label
# column and clip the values.
function T([string]$en, [string]$cn) { if ($zh) { $cn } else { $en } }

# ---- attention: flash the taskbar and beep ---------------------------------
try {
    [System.Media.SystemSounds]::Exclamation.Play()
} catch { }

$font = New-Object System.Drawing.Font('Segoe UI', 9)
$fontTitle = New-Object System.Drawing.Font('Segoe UI', 12, [System.Drawing.FontStyle]::Bold)
$fontMono = New-Object System.Drawing.Font('Consolas', 9)
$fontBold = New-Object System.Drawing.Font('Segoe UI', 9, [System.Drawing.FontStyle]::Bold)
$colLabel = [System.Drawing.Color]::FromArgb(110, 110, 110)
$colWarn = [System.Drawing.Color]::FromArgb(190, 40, 40)

$form = New-Object System.Windows.Forms.Form
$form.Text = T 'Approval required - computer-use' '需要确认 - computer-use'
$form.ClientSize = New-Object System.Drawing.Size(580, 336)
$form.StartPosition = 'CenterScreen'
$form.FormBorderStyle = 'FixedDialog'
$form.MaximizeBox = $false
$form.MinimizeBox = $false
$form.TopMost = $true
$form.Font = $font
$form.BackColor = [System.Drawing.Color]::White

$title = New-Object System.Windows.Forms.Label
$title.Text = T 'The agent wants to run a risky action' '智能体请求执行危险动作'
$title.Font = $fontTitle
$title.ForeColor = $colWarn
$title.Location = New-Object System.Drawing.Point(20, 16)
$title.Size = New-Object System.Drawing.Size(540, 30)
$form.Controls.Add($title)

function Add-Row([string]$label, [string]$value, [int]$y, [int]$h, $valueFont) {
    $l = New-Object System.Windows.Forms.Label
    $l.Text = $label
    $l.Location = New-Object System.Drawing.Point(20, $y)
    $l.Size = New-Object System.Drawing.Size(84, 20)
    $l.ForeColor = $colLabel
    $form.Controls.Add($l)

    $v = New-Object System.Windows.Forms.Label
    $v.Text = $value
    $v.Location = New-Object System.Drawing.Point(108, $y)
    $v.Size = New-Object System.Drawing.Size(452, $h)
    if ($valueFont) { $v.Font = $valueFont }
    $form.Controls.Add($v)
}

Add-Row (T 'Action:' '动作:') $Action 54 22 $fontBold
Add-Row (T 'Target:' '目标:') $Target 78 22 $fontBold
Add-Row (T 'Detail:' '参数:') $Detail 102 44 $fontMono
Add-Row (T 'Reason:' '原因:') $Reason 150 34 $null

$remember = New-Object System.Windows.Forms.CheckBox
$remember.Text = T 'Remember this target for the rest of this session' '本次会话内记住这个目标'
$remember.Location = New-Object System.Drawing.Point(20, 196)
$remember.Size = New-Object System.Drawing.Size(520, 24)
$form.Controls.Add($remember)

$hint = New-Object System.Windows.Forms.Label
if ($injectedFilter -eq 'on') {
    $hint.Text = T 'Enter does not approve. Esc denies, Alt+A allows. Synthetic (injected) input is ignored.' `
                  '回车不会放行；Esc 拒绝，Alt+A 允许。注入的键鼠输入会被忽略。'
} elseif ($injectedFilter -eq 'unavailable') {
    $hint.Text = T 'Enter does not approve. Esc denies, Alt+A allows. WARNING: injected-input filter unavailable.' `
                  '回车不会放行；Esc 拒绝，Alt+A 允许。警告：注入输入过滤不可用。'
} else {
    $hint.Text = T 'Enter does not approve. Esc denies, Alt+A allows.' `
                  '回车不会放行；Esc 拒绝，Alt+A 允许。'
}
$hint.Location = New-Object System.Drawing.Point(20, 224)
$hint.Size = New-Object System.Drawing.Size(520, 20)
$hint.ForeColor = $colLabel
$form.Controls.Add($hint)

$countdown = New-Object System.Windows.Forms.Label
$countdown.Location = New-Object System.Drawing.Point(20, 272)
$countdown.Size = New-Object System.Drawing.Size(280, 24)
$countdown.ForeColor = $colWarn
$countdown.Font = $fontBold
$form.Controls.Add($countdown)

$injectNote = New-Object System.Windows.Forms.Label
$injectNote.Location = New-Object System.Drawing.Point(20, 246)
$injectNote.Size = New-Object System.Drawing.Size(540, 20)
$injectNote.ForeColor = $colWarn
$injectNote.Font = $fontBold
$injectNote.Visible = $false
$form.Controls.Add($injectNote)

$deny = New-Object System.Windows.Forms.Button
$deny.Text = T 'Deny (Esc)' '拒绝 (Esc)'
$deny.Location = New-Object System.Drawing.Point(300, 270)
$deny.Size = New-Object System.Drawing.Size(118, 34)
$deny.DialogResult = [System.Windows.Forms.DialogResult]::Cancel
$form.Controls.Add($deny)

$allow = New-Object System.Windows.Forms.Button
# "&A" gives the Alt+A mnemonic; there is deliberately no Enter shortcut.
$allow.Text = T 'Allow (&A)' '允许 (&A)'
$allow.Location = New-Object System.Drawing.Point(426, 270)
$allow.Size = New-Object System.Drawing.Size(118, 34)
$form.Controls.Add($allow)

# Deny is the default: a stray Enter must never approve.
$form.CancelButton = $deny
$form.AcceptButton = $null

$script:allowed = $false
$allow.Add_Click({
    # With the filter on, only a PHYSICAL event counts. A same-user process can
    # PostMessage(BM_CLICK) to this button (or post WM_KEYDOWN to the form) and
    # the Click event fires without any injected input event — so the click
    # handler asks the hook whether a human really pressed it.
    if ($injectedFilter -eq 'on' -and ('DshInputGuard' -as [type]) -and -not [DshInputGuard]::PhysicalAllow) {
        $injectNote.Text = if ($zh) { '已忽略一次非物理的「允许」触发' } else { 'ignored a non-physical allow trigger' }
        $injectNote.Visible = $true
        # Console.Out, not Write-Output: output written from an event handler does
        # not reach the script's stdout stream. The server captures this line.
        try { [Console]::Out.WriteLine('ignored-non-physical-allow'); [Console]::Out.Flush() } catch { }
        return
    }
    $script:allowed = $true
    $script:result = if ($remember.Checked) { 4 } else { 0 }
    $form.Close()
})

$deadline = (Get-Date).AddMilliseconds($TimeoutMs)
$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 200
$timer.Add_Tick({
    $left = [int][math]::Ceiling(($deadline - (Get-Date)).TotalSeconds)
    if ($left -le 0) {
        $script:result = 2
        $timer.Stop()
        $form.Close()
        return
    }
    $countdown.Text = if ($zh) { "还有 $left 秒自动拒绝" } else { "auto-deny in $left s" }

    # The hook saw a physical Alt+A or a physical click on Allow.
    if ($injectedFilter -eq 'on' -and ('DshInputGuard' -as [type]) -and [DshInputGuard]::PhysicalAllow) {
        $script:allowed = $true
        $script:result = if ($remember.Checked) { 4 } else { 0 }
        $timer.Stop()
        $form.Close()
        return
    }

    # Show bypass attempts instead of hiding them.
    if (('DshInputGuard' -as [type]) -and [DshInputGuard]::Swallowed -gt 0) {
        $n = [DshInputGuard]::Swallowed
        $injectNote.Text = if ($zh) { "已忽略 $n 次注入的键鼠输入（不是你在操作）" } `
                           else { "ignored $n injected input event(s) - not you" }
        $injectNote.Visible = $true
    }
})
$timer.Start()

$form.Add_Shown({
    $countdown.Text = if ($zh) { "还有 $([int][math]::Ceiling($TimeoutMs / 1000)) 秒自动拒绝" } `
                            else { "auto-deny in $([int][math]::Ceiling($TimeoutMs / 1000)) s" }
    $form.Activate()
    $deny.Focus() | Out-Null          # deny has focus, not allow
    # Tell the hook where "Allow" is, so a physical click there can be told apart
    # from a posted message.
    if ($injectedFilter -eq 'on' -and ('DshInputGuard' -as [type])) {
        $r = $allow.RectangleToScreen($allow.ClientRectangle)
        [DshInputGuard]::SetAllowRect($r.X, $r.Y, $r.Width, $r.Height)
    }
})

$answer = $form.ShowDialog()
$timer.Stop()
$timer.Dispose()
$form.Dispose()

if ('DshInputGuard' -as [type]) {
    try { [DshInputGuard]::Uninstall() } catch { }
    $swallowed = [DshInputGuard]::Swallowed
    Write-Output "injected-swallowed=$swallowed"
}

if ($script:result -eq 2) { exit 2 }
if ($script:result -eq 4) { exit 4 }
if ($script:result -eq 0 -and $script:allowed) { exit 0 }
if ($answer -eq [System.Windows.Forms.DialogResult]::OK) { exit 0 }
exit 1
