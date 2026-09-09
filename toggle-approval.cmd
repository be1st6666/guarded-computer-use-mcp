@echo off
rem Toggle the approval dialog on/off. Double-click this file.
rem
rem 审批开关：双击本文件即可切换。
rem ON  = risky actions pop a dialog and wait for a human click
rem OFF = risky actions are refused without interrupting you
setlocal
set PS=pwsh.exe
where pwsh.exe >nul 2>nul || set PS=powershell.exe
"%PS%" -NoProfile -ExecutionPolicy Bypass -File "%~dp0approval-toggle.ps1"
pause
