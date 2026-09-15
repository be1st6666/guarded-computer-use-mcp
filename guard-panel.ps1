#requires -Version 5.1
<#
  computer-use 防护开关面板。

  双击同目录的 guard-panel.cmd 打开。开关不再直接 New-Item 一个空标记文件，而是
  调用 `node src\guard.js set <开关> on|off`，由 src/guard.js 写入**带 HMAC 签名**
  的标记；服务端每次调用都会读，所以改完立即生效，不用重启 MCP。

  为什么改成签名：以前任何能写文件的东西（包括同时拥有文件/终端工具的智能体自己）
  建一个空文件就能关掉防护，而 README 却说"模型无法绕过"。现在手写/改过的标记一律
  被忽略（fail closed），并记入 audit.jsonl（op=guard_tamper）+ 在工具结果里告警。
  面板显示的"已篡改"就是这个意思。

  密钥：环境变量 COMPUTER_USE_GUARD_SECRET 优先；否则用本目录的 guard.key
  （首次使用时自动生成）。同用户身份的攻击者仍能读到 guard.key —— 这是减速带 + 绊线，
  不是安全边界，详见 SECURITY.md。

  Saved with a UTF-8 BOM so Windows PowerShell 5.1 renders the CJK labels.
#>
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$here = $PSScriptRoot
$guardJs = Join-Path $here 'src\guard.js'

function Resolve-Node {
    $c = Get-Command node.exe -ErrorAction SilentlyContinue
    if ($c) { return $c.Source }
    $c = Get-Command node -ErrorAction SilentlyContinue
    if ($c) { return $c.Source }
    foreach ($p in @(
        (Join-Path $env:ProgramFiles 'nodejs\node.exe'),
        (Join-Path $env:LOCALAPPDATA 'Programs\nodejs\node.exe'),
        (Join-Path ${env:ProgramFiles(x86)} 'nodejs\node.exe')
    )) { if ($p -and (Test-Path $p)) { return $p } }
    return $null
}

$node = Resolve-Node
if (-not $node -or -not (Test-Path $guardJs)) {
    [System.Windows.Forms.MessageBox]::Show(
        "找不到 node.exe 或 src\guard.js，无法读写受签名保护的开关。`n`n请确认已安装 Node.js 18+ 并在本目录运行过 npm install。",
        'computer-use 防护开关', 'OK', 'Warning') | Out-Null
    exit 1
}

function Get-GuardState {
    $raw = & $node $guardJs list --json 2>$null
    if (-not $raw) { return $null }
    try { return (($raw -join "`n") | ConvertFrom-Json) } catch { return $null }
}

function Set-GuardSwitch([string]$name, [bool]$on) {
    $val = if ($on) { 'on' } else { 'off' }
    & $node $guardJs set $name $val 2>&1 | Out-Null
}

$font = New-Object System.Drawing.Font('Segoe UI', 9)
$fontTitle = New-Object System.Drawing.Font('Segoe UI', 12, [System.Drawing.FontStyle]::Bold)
$fontSmall = New-Object System.Drawing.Font('Segoe UI', 8)
$colDim = [System.Drawing.Color]::FromArgb(110, 110, 110)
$colOk = [System.Drawing.Color]::FromArgb(30, 130, 60)
$colWarn = [System.Drawing.Color]::FromArgb(190, 40, 40)

$form = New-Object System.Windows.Forms.Form
$form.Text = 'computer-use 防护开关'
$form.ClientSize = New-Object System.Drawing.Size(470, 400)
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
$title.Size = New-Object System.Drawing.Size(430, 28)
$form.Controls.Add($title)

$sub = New-Object System.Windows.Forms.Label
$sub.Text = '开关带签名，改动立即生效（无需重启 MCP）；手改的标记会被忽略'
$sub.Font = $fontSmall
$sub.ForeColor = $colDim
$sub.Location = New-Object System.Drawing.Point(22, 44)
$sub.Size = New-Object System.Drawing.Size(430, 18)
$form.Controls.Add($sub)

$script:tampered = @()
$script:syncing = $false

function Add-Toggle([string]$text, [string]$hint, [int]$y, [string]$name) {
    $cb = New-Object System.Windows.Forms.CheckBox
    $cb.Text = $text
    $cb.Font = (New-Object System.Drawing.Font('Segoe UI', 10, [System.Drawing.FontStyle]::Bold))
    $cb.Location = New-Object System.Drawing.Point(22, $y)
    $cb.Size = New-Object System.Drawing.Size(430, 24)
    $form.Controls.Add($cb)

    $h = New-Object System.Windows.Forms.Label
    $h.Text = $hint
    $h.Font = $fontSmall
    $h.ForeColor = $colDim
    $h.Location = New-Object System.Drawing.Point(42, ($y + 24))
    $h.Size = New-Object System.Drawing.Size(410, 18)
    $form.Controls.Add($h)

    $cb.Tag = @{ name = $name; hint = $h; baseHint = $hint }
    return $cb
}

$cbApproval = Add-Toggle '弹窗审批' '关闭/删除/发送、alt+f4 等动作弹窗等你确认' 74 'approval'
$cbGuard = Add-Toggle '黑名单拦截' '密码管理器、银行、加密钱包一律拒绝' 128 'guard'
$cbAudit = Add-Toggle '审计日志' '每个动作写入 audit.jsonl（脱敏 + 哈希链）' 182 'audit'
$cbPhysical = Add-Toggle '物理输入校验' '审批弹窗忽略注入的键鼠（其它自动化工具也按不动）' 236 'physical'

$status = New-Object System.Windows.Forms.Label
$status.Location = New-Object System.Drawing.Point(22, 292)
$status.AutoSize = $true
$status.MaximumSize = New System.Drawing.Size(440, 0)   # AutoSize: a fixed width wrapped the status line at this DPI
$status.Font = (New-Object System.Drawing.Font('Segoe UI', 10, [System.Drawing.FontStyle]::Bold))
$form.Controls.Add($status)

$tamperLabel = New-Object System.Windows.Forms.Label
$tamperLabel.Location = New-Object System.Drawing.Point(22, 324)
$tamperLabel.AutoSize = $true
$tamperLabel.MaximumSize = New-Object System.Drawing.Size(430, 52)   # wraps instead of running off the form
$tamperLabel.Font = $fontSmall
$tamperLabel.ForeColor = $colWarn
$tamperLabel.Text = ''
$form.Controls.Add($tamperLabel)

function Sync-Status {
    $on = @()
    foreach ($cb in @($cbApproval, $cbGuard, $cbAudit, $cbPhysical)) {
        if ($cb.Checked) { $on += $cb.Tag.name }
    }
    $zh = @{ approval = '审批'; guard = '黑名单'; audit = '审计'; physical = '物理输入' }
    if ($on.Count -eq 4) {
        $status.Text = '状态：全部开启'
        $status.ForeColor = $colOk
    } elseif ($on.Count -eq 0) {
        $status.Text = '状态：全部关闭 —— 智能体可不受限制地操作'
        $status.ForeColor = $colWarn
    } else {
        $status.Text = '状态：开启 ' + (($on | ForEach-Object { $zh[$_] }) -join ' / ')
        $status.ForeColor = $colOk
    }

    if ($script:tampered.Count -gt 0) {
        $tamperLabel.Text = '⚠ 检测到被篡改/手改的标记：' + ($script:tampered -join '、') +
                            '（已忽略，防护保持开启；事件已写入 audit.jsonl）'
    } else {
        $tamperLabel.Text = ''
    }
}

function Load-State {
    $script:syncing = $true
    $state = Get-GuardState
    if ($state) {
        $script:tampered = @()
        foreach ($cb in @($cbApproval, $cbGuard, $cbAudit, $cbPhysical)) {
            $name = $cb.Tag.name
            $s = $state.$name
            if ($null -eq $s) { continue }
            $cb.Checked = -not [bool]$s.off
            if ($s.tampered) {
                $script:tampered += $name
                $cb.Tag.hint.Text = $cb.Tag.baseHint + '  ← 标记无效，已忽略'
                $cb.Tag.hint.ForeColor = $colWarn
            } else {
                $cb.Tag.hint.Text = $cb.Tag.baseHint
                $cb.Tag.hint.ForeColor = $colDim
            }
        }
    }
    $script:syncing = $false
    Sync-Status
}

function Apply([System.Windows.Forms.CheckBox]$cb) {
    if ($script:syncing) { return }
    Set-GuardSwitch $cb.Tag.name $cb.Checked
    Load-State                       # 读回真实状态，不相信界面
}

$cbApproval.Add_CheckedChanged({ Apply $cbApproval })
$cbGuard.Add_CheckedChanged({ Apply $cbGuard })
$cbAudit.Add_CheckedChanged({ Apply $cbAudit })
$cbPhysical.Add_CheckedChanged({ Apply $cbPhysical })

$allOn = New-Object System.Windows.Forms.Button
$allOn.Text = '全部开启'
$allOn.Location = New-Object System.Drawing.Point(128, 360)
$allOn.Size = New-Object System.Drawing.Size(100, 30)
$allOn.Add_Click({
    foreach ($cb in @($cbApproval, $cbGuard, $cbAudit, $cbPhysical)) { Set-GuardSwitch $cb.Tag.name $true }
    Load-State
})
$form.Controls.Add($allOn)

$allOff = New-Object System.Windows.Forms.Button
$allOff.Text = '全部关闭'
$allOff.Location = New-Object System.Drawing.Point(238, 360)
$allOff.Size = New-Object System.Drawing.Size(100, 30)
$allOff.Add_Click({
    $r = [System.Windows.Forms.MessageBox]::Show(
        '确定要关闭全部防护层？智能体将不再被拦截、不再被询问。', 'computer-use',
        'YesNo', 'Warning')
    if ($r -ne [System.Windows.Forms.DialogResult]::Yes) { return }
    foreach ($cb in @($cbApproval, $cbGuard, $cbAudit, $cbPhysical)) { Set-GuardSwitch $cb.Tag.name $false }
    Load-State
})
$form.Controls.Add($allOff)

$close = New-Object System.Windows.Forms.Button
$close.Text = '关闭窗口'
$close.Location = New-Object System.Drawing.Point(348, 360)
$close.Size = New-Object System.Drawing.Size(100, 30)
$close.DialogResult = [System.Windows.Forms.DialogResult]::OK
$form.Controls.Add($close)

Load-State
$form.AcceptButton = $close
[void]$form.ShowDialog()
$form.Dispose()
