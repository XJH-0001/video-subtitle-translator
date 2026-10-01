# =============================================================================
#  启动本地识别服务
#
#     powershell -ExecutionPolicy Bypass -File scripts\start-server.ps1
#
#  常用参数：
#     -Port 8765              改端口（改完记得在扩展设置里同步改服务地址）
#     -Model small            换识别模型：tiny / base / small / medium / large-v3
#     -Language en            强制指定视频语言，默认自动检测
#     -Target zh              翻译成什么语言
#     -Translator auto        翻译服务：auto / bing / google / youdao / mymemory / deepl / openai / none
#     -NoPreload              启动时不预加载模型（省内存，第一条字幕会慢十几秒）
#     -Cuda                   强制尝试用 N 卡（需要装好 CUDA 12 的 cuBLAS + cuDNN 9）
# =============================================================================

[CmdletBinding()]
param(
    [int]$Port = 8765,
    [string]$Model = "",
    [string]$Language = "",
    [string]$Target = "",
    [string]$Translator = "",
    [switch]$NoPreload,
    [switch]$Cuda
)

$ErrorActionPreference = "Stop"
$Root   = Split-Path -Parent $PSScriptRoot
$Server = Join-Path $Root "server"
$VPy    = Join-Path $Server ".venv\Scripts\python.exe"

function Die($m) { Write-Host "  [X] $m" -ForegroundColor Red; exit 1 }

if (-not (Test-Path $VPy)) {
    Write-Host ""
    Write-Host "  还没安装。请先运行：scripts\install.ps1" -ForegroundColor Yellow
    Write-Host ""
    exit 1
}

# 中文日志在部分终端会乱码，强制 UTF-8
$env:PYTHONUTF8 = "1"
$env:PYTHONIOENCODING = "utf-8"
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }

$serverArgs = @("app.py", "--port", "$Port")
if ($Model)      { $serverArgs += @("--model", $Model) }
if ($Language)   { $serverArgs += @("--language", $Language) }
if ($Target)     { $serverArgs += @("--target", $Target) }
if ($Translator) { $serverArgs += @("--translator", $Translator) }
if ($Cuda)       { $serverArgs += @("--device", "cuda") }
if (-not $NoPreload) { $serverArgs += "--preload" }

Set-Location $Server
Write-Host ""
Write-Host "  正在启动本地识别服务…（这个窗口请保持打开，关掉字幕就停了）" -ForegroundColor Cyan
Write-Host ""

& $VPy @serverArgs
$code = $LASTEXITCODE

Write-Host ""
if ($code -ne 0) {
    Write-Host "  服务异常退出（代码 $code）。常见原因：" -ForegroundColor Yellow
    Write-Host "    · 端口 $Port 被占用 → 换一个端口：-Port 8766" -ForegroundColor DarkGray
    Write-Host "    · 依赖没装全   → 重新运行 scripts\install.ps1" -ForegroundColor DarkGray
    Write-Host "    · 模型下载失败 → 设置环境变量 HF_ENDPOINT=https://hf-mirror.com 后重试" -ForegroundColor DarkGray
}
Write-Host ""
Read-Host "按回车关闭"
