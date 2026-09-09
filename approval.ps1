#requires -Version 5.1
<#
  Approval dialog for computer-use-mcp.

  Shown when a tool call matches the safety gate. The MCP server blocks on this
  process and uses its exit code, so only a real human click can allow the
  action - the model cannot forge it.

  Exit codes:  0 = allowed   1 = denied   2 = timed out (treated as denied)
               3 = dialog could not be shown (caller falls back to pending)

  THIS FILE MUST STAY PURE ASCII.
#>
param(
    [string]$Action = 'unknown action',
    [string]$Target = '',
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

$font = New-Object System.Drawing.Font('Segoe UI', 9)
$fontBold = New-Object System.Drawing.Font('Segoe UI', 11, [System.Drawing.FontStyle]::Bold)

$form = New-Object System.Windows.Forms.Form
$form.Text = 'computer-use  approval required'
$form.ClientSize = New-Object System.Drawing.Size(470, 250)
$form.StartPosition = 'CenterScreen'
$form.FormBorderStyle = 'FixedDialog'
$form.MaximizeBox = $false
$form.MinimizeBox = $false
$form.TopMost = $true
$form.Font = $font

$title = New-Object System.Windows.Forms.Label
$title.Text = 'The agent wants to run a risky action'
$title.Font = $fontBold
$title.Location = New-Object System.Drawing.Point(18, 14)
$title.Size = New-Object System.Drawing.Size(434, 30)
$form.Controls.Add($title)

function Add-Row([string]$label, [string]$value, [int]$y, [int]$h) {
    $l = New-Object System.Windows.Forms.Label
    $l.Text = $label
    $l.Location = New-Object System.Drawing.Point(18, $y)
    $l.Size = New-Object System.Drawing.Size(70, 20)
    $l.ForeColor = [System.Drawing.Color]::DimGray
    $form.Controls.Add($l)

    $v = New-Object System.Windows.Forms.Label
    $v.Text = $value
    $v.Location = New-Object System.Drawing.Point(92, $y)
    $v.Size = New-Object System.Drawing.Size(360, $h)
    $form.Controls.Add($v)
}

Add-Row 'Action:' $Action 50 20
Add-Row 'Target:' $Target 74 40
Add-Row 'Reason:' $Reason 118 40

$countdown = New-Object System.Windows.Forms.Label
$countdown.Location = New-Object System.Drawing.Point(18, 166)
$countdown.Size = New-Object System.Drawing.Size(200, 20)
$countdown.ForeColor = [System.Drawing.Color]::Firebrick
$form.Controls.Add($countdown)

$allow = New-Object System.Windows.Forms.Button
$allow.Text = 'Allow'
$allow.Location = New-Object System.Drawing.Point(242, 200)
$allow.Size = New-Object System.Drawing.Size(100, 32)
$allow.DialogResult = [System.Windows.Forms.DialogResult]::OK
$form.Controls.Add($allow)

$deny = New-Object System.Windows.Forms.Button
$deny.Text = 'Deny'
$deny.Location = New-Object System.Drawing.Point(352, 200)
$deny.Size = New-Object System.Drawing.Size(100, 32)
$deny.DialogResult = [System.Windows.Forms.DialogResult]::Cancel
$form.Controls.Add($deny)

$form.AcceptButton = $allow
$form.CancelButton = $deny

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
    $countdown.Text = "auto-deny in $left s"
})
$timer.Start()

$form.Add_Shown({
    $countdown.Text = "auto-deny in $([int][math]::Ceiling($TimeoutMs / 1000)) s"
    $form.Activate()
    $deny.Focus() | Out-Null
})

$answer = $form.ShowDialog()
$timer.Stop()
$timer.Dispose()
$form.Dispose()

if ($script:result -eq 2) { exit 2 }
if ($answer -eq [System.Windows.Forms.DialogResult]::OK) { exit 0 }
exit 1
