@echo off
chcp 65001 >nul
REM 打开扩展文件夹，并把路径放进剪贴板 —— 方便「加载解压缩的扩展」时直接 Ctrl+V
set "EXTPATH=%~dp0..\extension"
cd /d "%EXTPATH%"
set "EXTPATH=%CD%"
echo %EXTPATH%| clip
echo.
echo   扩展文件夹：%EXTPATH%
echo   路径已复制到剪贴板。
echo.
echo   接下来在 Edge 里：
echo     1. 地址栏输入 edge://extensions 回车
echo     2. 打开左下角「开发人员模式」
echo     3. 点「加载解压缩的扩展」
echo     4. 在文件选择框里按 Ctrl+V，回车
echo.
start "" explorer.exe "%EXTPATH%"
