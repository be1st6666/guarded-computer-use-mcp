#requires -Version 5.1
<#
  Approval dialog for guarded-computer-use-mcp.

  Shown when a tool call matches the safety gate. The MCP server blocks on this
  process and uses its exit code, so only a real human action can allow the
  action - the model cannot forge one.

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

  Saved with a UTF-8 BOM so Windows PowerShell 5.1 reads the CJK labels
  correctly; the English labels are always shown alongside.
#>
param(
    [string]$Action = 'unknown action',
    [string]$Target = '',
    [string]$Detail = '',
    [string]$Reason = '',
    [int]$TimeoutMs = 30000
)

$ErrorActionPreference = 'Stop'
$result = 3

try {
    Add-Type -AssemblyName System.Windows.Forms
    Add-Type -AssemblyName System.Drawing
} catch {
    exit 3
}

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
$form.ClientSize = New-Object System.Drawing.Size(580, 330)
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
$hint.Text = T 'Enter does not approve. Press Esc to deny, Alt+A to allow.' `
                '回车不会放行；Esc 拒绝，Alt+A 允许。'
$hint.Location = New-Object System.Drawing.Point(20, 224)
$hint.Size = New-Object System.Drawing.Size(520, 20)
$hint.ForeColor = $colLabel
$form.Controls.Add($hint)

$countdown = New-Object System.Windows.Forms.Label
$countdown.Location = New-Object System.Drawing.Point(20, 254)
$countdown.Size = New-Object System.Drawing.Size(280, 24)
$countdown.ForeColor = $colWarn
$countdown.Font = $fontBold
$form.Controls.Add($countdown)

$deny = New-Object System.Windows.Forms.Button
$deny.Text = T 'Deny (Esc)' '拒绝 (Esc)'
$deny.Location = New-Object System.Drawing.Point(300, 252)
$deny.Size = New-Object System.Drawing.Size(118, 34)
$deny.DialogResult = [System.Windows.Forms.DialogResult]::Cancel
$form.Controls.Add($deny)

$allow = New-Object System.Windows.Forms.Button
# "&A" gives the Alt+A mnemonic; there is deliberately no Enter shortcut.
$allow.Text = T 'Allow (&A)' '允许 (&A)'
$allow.Location = New-Object System.Drawing.Point(426, 252)
$allow.Size = New-Object System.Drawing.Size(118, 34)
$form.Controls.Add($allow)

# Deny is the default: a stray Enter must never approve.
$form.CancelButton = $deny
$form.AcceptButton = $null

$script:allowed = $false
$allow.Add_Click({
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
})
$timer.Start()

$form.Add_Shown({
    $countdown.Text = if ($zh) { "还有 $([int][math]::Ceiling($TimeoutMs / 1000)) 秒自动拒绝" } `
                            else { "auto-deny in $([int][math]::Ceiling($TimeoutMs / 1000)) s" }
    $form.Activate()
    $deny.Focus() | Out-Null          # deny has focus, not allow
})

$answer = $form.ShowDialog()
$timer.Stop()
$timer.Dispose()
$form.Dispose()

if ($script:result -eq 2) { exit 2 }
if ($script:result -eq 4) { exit 4 }
if ($script:result -eq 0 -and $script:allowed) { exit 0 }
if ($answer -eq [System.Windows.Forms.DialogResult]::OK) { exit 0 }
exit 1
