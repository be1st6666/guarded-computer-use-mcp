#requires -Version 5.1
<#
  computer-use 防护开关面板。

  双击同目录的 guard-panel.cmd 打开。三个开关直接写/删标记文件，服务端每次调用
  都会读取，所以**改完立即生效，不用重启 MCP**。

  Saved with a UTF-8 BOM so Windows PowerShell 5.1 renders the CJK labels.
#>
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$here = $PSScriptRoot
$flagGuard = Join-Path $here '.guard-off'
$flagApproval = Join-Path $here '.approval-off'
$flagAudit = Join-Path $here '.audit-off'

$font = New-Object System.Drawing.Font('Segoe UI', 9)
$fontTitle = New-Object System.Drawing.Font('Segoe UI', 12, [System.Drawing.FontStyle]::Bold)
$fontSmall = New-Object System.Drawing.Font('Segoe UI', 8)
$colDim = [System.Drawing.Color]::FromArgb(110, 110, 110)
$colOk = [System.Drawing.Color]::FromArgb(30, 130, 60)
$colWarn = [System.Drawing.Color]::FromArgb(190, 40, 40)

$form = New-Object System.Windows.Forms.Form
$form.Text = 'computer-use 防护开关'
$form.ClientSize = New-Object System.Drawing.Size(460, 316)
$form.StartPosition = 'CenterScreen'
$form.FormBorderStyle = 'FixedDialog'
$form.MaximizeBox = $false
$form.MinimizeBox = $false
$form.Font = $font
$form.BackColor = [System.Drawing.Color]::White

$title = New-Object System.Windows.Forms.Label
$title.Text = 'computer-use 防护开关'
$title.Font = $fontTitle
$title.Location = New-Object System.Drawing.Point(20, 16)
$title.Size = New-Object System.Drawing.Size(420, 28)
$form.Controls.Add($title)

$sub = New-Object System.Windows.Forms.Label
$sub.Text = '改动立即生效，无需重启 MCP'
$sub.Font = $fontSmall
$sub.ForeColor = $colDim
$sub.Location = New-Object System.Drawing.Point(22, 44)
$sub.Size = New-Object System.Drawing.Size(420, 18)
$form.Controls.Add($sub)

function Add-Toggle([string]$text, [string]$hint, [int]$y, [string]$flag) {
    $cb = New-Object System.Windows.Forms.CheckBox
    $cb.Text = $text
    $cb.Font = (New-Object System.Drawing.Font('Segoe UI', 10, [System.Drawing.FontStyle]::Bold))
    $cb.Location = New-Object System.Drawing.Point(22, $y)
    $cb.Size = New-Object System.Drawing.Size(420, 24)
    $cb.Checked = -not (Test-Path $flag)
    $form.Controls.Add($cb)

    $h = New-Object System.Windows.Forms.Label
    $h.Text = $hint
    $h.Font = $fontSmall
    $h.ForeColor = $colDim
    $h.Location = New-Object System.Drawing.Point(42, ($y + 24))
    $h.Size = New-Object System.Drawing.Size(400, 18)
    $form.Controls.Add($h)

    $cb.Tag = @{ flag = $flag; hint = $h }
    return $cb
}

$cbApproval = Add-Toggle '弹窗审批' '关闭/删除/发送、alt+f4 等动作弹窗等你确认' 74 $flagApproval
$cbGuard = Add-Toggle '黑名单拦截' '密码管理器、银行、加密钱包一律拒绝' 130 $flagGuard
$cbAudit = Add-Toggle '审计日志' '每个动作连同目标进程写入 audit.jsonl' 186 $flagAudit

$status = New-Object System.Windows.Forms.Label
$status.Location = New-Object System.Drawing.Point(22, 236)
$status.Size = New-Object System.Drawing.Size(420, 24)
$status.Font = (New-Object System.Drawing.Font('Segoe UI', 10, [System.Drawing.FontStyle]::Bold))
$form.Controls.Add($status)

function Sync-Status {
    $on = @()
    if ($cbApproval.Checked) { $on += '审批' }
    if ($cbGuard.Checked) { $on += '黑名单' }
    if ($cbAudit.Checked) { $on += '审计' }
    if ($on.Count -eq 3) {
        $status.Text = '状态：全部开启'
        $status.ForeColor = $colOk
    } elseif ($on.Count -eq 0) {
        $status.Text = '状态：全部关闭 —— 智能体可不受限制地操作'
        $status.ForeColor = $colWarn
    } else {
        $status.Text = '状态：开启 ' + ($on -join ' / ')
        $status.ForeColor = $colOk
    }
}

function Apply([System.Windows.Forms.CheckBox]$cb) {
    $flag = $cb.Tag.flag
    if ($cb.Checked) {
        if (Test-Path $flag) { Remove-Item $flag -Force -ErrorAction SilentlyContinue }
    } else {
        New-Item -ItemType File -Path $flag -Force | Out-Null
    }
    Sync-Status
}

$cbApproval.Add_CheckedChanged({ Apply $cbApproval })
$cbGuard.Add_CheckedChanged({ Apply $cbGuard })
$cbAudit.Add_CheckedChanged({ Apply $cbAudit })

$allOn = New-Object System.Windows.Forms.Button
$allOn.Text = '全部开启'
$allOn.Location = New-Object System.Drawing.Point(118, 272)
$allOn.Size = New-Object System.Drawing.Size(100, 30)
$allOn.Add_Click({
    $cbApproval.Checked = $true
    $cbGuard.Checked = $true
    $cbAudit.Checked = $true
})
$form.Controls.Add($allOn)

$allOff = New-Object System.Windows.Forms.Button
$allOff.Text = '全部关闭'
$allOff.Location = New-Object System.Drawing.Point(228, 272)
$allOff.Size = New-Object System.Drawing.Size(100, 30)
$allOff.Add_Click({
    $cbApproval.Checked = $false
    $cbGuard.Checked = $false
    $cbAudit.Checked = $false
})
$form.Controls.Add($allOff)

$close = New-Object System.Windows.Forms.Button
$close.Text = '关闭窗口'
$close.Location = New-Object System.Drawing.Point(338, 272)
$close.Size = New-Object System.Drawing.Size(100, 30)
$close.DialogResult = [System.Windows.Forms.DialogResult]::OK
$form.Controls.Add($close)

Sync-Status
$form.AcceptButton = $close
[void]$form.ShowDialog()
$form.Dispose()
