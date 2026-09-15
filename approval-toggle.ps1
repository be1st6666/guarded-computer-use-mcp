# 切换 computer-use-mcp 的弹窗审批。双击同目录的 toggle-approval.cmd 即可运行。
# 开关走 `node src\guard.js set approval on|off`，写的是带签名的标记；手改的空文件会被
# 服务端忽略并告警。本文件带 UTF-8 BOM，所以 Windows PowerShell 5.1 也能正确显示中文。
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
    Write-Host ''
    Write-Host '  找不到 node.exe 或 src\guard.js，无法切换开关。' -ForegroundColor Red
    Write-Host '  请确认已安装 Node.js 18+。'
    Write-Host ''
    exit 1
}

$raw = & $node $guardJs list --json 2>$null
$state = $null
try { $state = (($raw -join "`n") | ConvertFrom-Json) } catch { }

if (-not $state) {
    Write-Host ''
    Write-Host '  读取开关状态失败，未做任何改动。' -ForegroundColor Red
    Write-Host ''
    exit 1
}

if ($state.approval.tampered) {
    Write-Host ''
    Write-Host '  注意：.approval-off 存在但不是有效签名标记，已被忽略（防护仍开启）。' -ForegroundColor Yellow
    Write-Host '  正在用有效签名重写状态……'
}

if ($state.approval.off) {
    & $node $guardJs set approval on 2>&1 | Out-Null
    Write-Host ''
    Write-Host '  审批已【开启】' -ForegroundColor Green
    Write-Host '  危险动作（alt+f4、点击「关闭/删除/发送」等）会弹窗等你确认。'
    Write-Host '  弹窗只接受物理键鼠：注入的 Alt+A / 点击会被忽略并计数。'
    Write-Host ''
} else {
    & $node $guardJs set approval off 2>&1 | Out-Null
    Write-Host ''
    Write-Host '  审批已【关闭】' -ForegroundColor Yellow
    Write-Host '  危险动作不再弹窗，直接返回待确认状态（仍不会自动执行）。'
    Write-Host '  再运行一次本脚本即可恢复。'
    Write-Host ''
}
