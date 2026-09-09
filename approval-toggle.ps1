# 切换 computer-use-mcp 的弹窗审批。双击同目录的 toggle-approval.cmd 即可运行。
# 本文件带 UTF-8 BOM，所以 Windows PowerShell 5.1 也能正确显示中文。
$flag = Join-Path $PSScriptRoot '.approval-off'

if (Test-Path $flag) {
    Remove-Item $flag -Force
    Write-Host ''
    Write-Host '  审批已【开启】' -ForegroundColor Green
    Write-Host '  危险动作（alt+f4、点击「关闭/删除/发送」等）会弹窗等你确认。'
    Write-Host ''
} else {
    New-Item -ItemType File -Path $flag -Force | Out-Null
    Write-Host ''
    Write-Host '  审批已【关闭】' -ForegroundColor Yellow
    Write-Host '  危险动作不再弹窗，直接返回待确认状态（仍不会自动执行）。'
    Write-Host '  再运行一次本脚本即可恢复。'
    Write-Host ''
}