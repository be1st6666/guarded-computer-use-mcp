@echo off
rem Open the computer-use guard panel. Double-click this file.
rem 打开防护开关面板：双击本文件即可。
rem
rem "start" launches it asynchronously so this console closes immediately, and
rem -WindowStyle Hidden keeps the PowerShell console out of the way. The panel
rem itself is a separate window and still shows.
setlocal
set PS=pwsh.exe
where pwsh.exe >nul 2>nul || set PS=powershell.exe
start "" "%PS%" -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File "%~dp0guard-panel.ps1"
