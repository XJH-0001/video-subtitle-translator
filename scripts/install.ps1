# =============================================================================
#  视频实时字幕翻译 —— 一键安装
#
#  用法（在本文件夹上右键「使用 PowerShell 运行」，或）：
#     powershell -ExecutionPolicy Bypass -File scripts\install.ps1
#
#  可选参数：
#     -Model tiny|base|small|medium|large-v3   要预下载的识别模型（默认 small）
#     -SkipModel                               只装依赖，不下载模型
#     -Mirror <url>                            换 pip 镜像源
#     -Python <path>                           指定 python.exe
# =============================================================================

[CmdletBinding()]
param(
    [string]$Model = "small",
    [switch]$SkipModel,
    [string]$Mirror = "https://pypi.tuna.tsinghua.edu.cn/simple",
    [string]$Python = ""
)

$ErrorActionPreference = "Stop"
$Root   = Split-Path -Parent $PSScriptRoot
$Server = Join-Path $Root "server"
$Venv   = Join-Path $Server ".venv"
$VPy    = Join-Path $Venv "Scripts\python.exe"

function Info($m) { Write-Host "  $m" -ForegroundColor Cyan }
function Ok($m)   { Write-Host "  [OK] $m" -ForegroundColor Green }
function Warn($m) { Write-Host "  [!] $m" -ForegroundColor Yellow }
function Die($m)  { Write-Host "  [X] $m" -ForegroundColor Red; exit 1 }

function Find-Python {
    param([string]$Explicit)
    if ($Explicit) {
        if (Test-Path $Explicit) { return (Resolve-Path $Explicit).Path }
        Die "指定的 Python 不存在：$Explicit"
    }
    # 1) py 启动器最可靠，优先挑 3.11~3.13（ctranslate2 的 wheel 覆盖到这些版本）
    $py = Get-Command py -ErrorAction SilentlyContinue
    if ($py) {
        foreach ($v in @("3.12", "3.13", "3.11", "3.10")) {
            try {
                $p = & py "-$v" -c "import sys;print(sys.executable)" 2>$null
                if ($LASTEXITCODE -eq 0 -and $p -and (Test-Path ($p.Trim()))) { return $p.Trim() }
            } catch { }
        }
    }
    # 2) PATH 里的 python / python3（要能真的跑起来，微软商店的占位程序跑不动）
    foreach ($name in @("python", "python3")) {
        $cmd = Get-Command $name -ErrorAction SilentlyContinue
        if (-not $cmd) { continue }
        try {
            $v = & $cmd.Source -c "import sys;print('%d.%d'%sys.version_info[:2])" 2>$null
            if ($LASTEXITCODE -eq 0 -and $v -match "^3\.\d+$") { return $cmd.Source }
        } catch { }
    }
    # 3) 常见安装位置兜底
    foreach ($guess in @(
        "$env:LOCALAPPDATA\Programs\Python\Python312\python.exe",
        "$env:LOCALAPPDATA\Programs\Python\Python313\python.exe",
        "$env:LOCALAPPDATA\Programs\Python\Python311\python.exe",
        "C:\Python312\python.exe",
        "C:\Python311\python.exe"
    )) {
        if (Test-Path $guess) { return $guess }
    }
    return $null
}

Write-Host ""
Write-Host "=====================================================" -ForegroundColor White
Write-Host "  视频实时字幕翻译 · 安装" -ForegroundColor White
Write-Host "=====================================================" -ForegroundColor White
Write-Host ""

# --- 1. 找 Python -------------------------------------------------------------
Info "[1/4] 查找 Python…"
$pyExe = Find-Python -Explicit $Python
if (-not $pyExe) {
    Die @"
没找到可用的 Python。
请先安装 Python 3.11 ~ 3.13（https://www.python.org/downloads/windows/ ，
安装时务必勾选 "Add python.exe to PATH"），然后重新运行本脚本。
"@
}
$ver = & $pyExe -c "import sys;print('%d.%d.%d'%sys.version_info[:3])"
Ok "Python $ver  ->  $pyExe"

if ($ver -match "^3\.(\d+)") {
    $minor = [int]$Matches[1]
    if ($minor -ge 14) {
        Warn "Python $ver 可能还没有 ctranslate2 的预编译包。如果安装依赖失败，请改用 Python 3.12。"
    }
}

# --- 2. 建虚拟环境 -----------------------------------------------------------
Info "[2/4] 创建虚拟环境（server\.venv）…"
if (Test-Path $VPy) {
    Ok "已存在，跳过"
} else {
    & $pyExe -m venv $Venv
    if (-not (Test-Path $VPy)) { Die "虚拟环境创建失败" }
    Ok "已创建"
}

# --- 3. 装依赖 ---------------------------------------------------------------
Info "[3/4] 安装依赖（faster-whisper / FastAPI / httpx / numpy）…"
Write-Host "        镜像源：$Mirror" -ForegroundColor DarkGray
& $VPy -m pip install --upgrade pip --quiet --disable-pip-version-check -i $Mirror 2>&1 | Out-Null

$reqFile = Join-Path $Server "requirements.txt"
& $VPy -m pip install -r $reqFile -i $Mirror --disable-pip-version-check
if ($LASTEXITCODE -ne 0) {
    Warn "镜像源安装失败，改用官方 PyPI 再试一次…"
    & $VPy -m pip install -r $reqFile --disable-pip-version-check
    if ($LASTEXITCODE -ne 0) { Die "依赖安装失败。请把上面的报错发出来看看。" }
}
Ok "依赖安装完成"

# --- 4. 下载模型 -------------------------------------------------------------
if ($SkipModel) {
    Info "[4/4] 跳过模型下载（第一次启动服务时会自动下载）"
} else {
    Info "[4/4] 下载识别模型「$Model」（首次约需几十秒到几分钟）…"
    $env:PYTHONUTF8 = "1"
    & $VPy -c @"
import sys
sys.path.insert(0, r'$Server')
from config import load_settings
from asr import WhisperEngine
s = load_settings()
s.model = '$Model'
e = WhisperEngine(s)
e.load()
print('MODEL_OK', e.device, e.compute_type)
"@
    if ($LASTEXITCODE -ne 0) {
        Warn "模型下载失败。不影响安装，启动服务时会自动重试。"
        Warn "如果一直失败，手动指定镜像后重试：`$env:HF_ENDPOINT='https://hf-mirror.com'"
    } else {
        Ok "模型就绪"
    }
}

# --- 5. 注册「自动启动本地服务」组件（Native Messaging）---------------------
# 具体逻辑在 register-native-host.ps1 里（可以单独运行、单独撤销）
Info "[5/5] 注册自动启动组件（Native Messaging）…"
$regScript = Join-Path $PSScriptRoot "register-native-host.ps1"
if (Test-Path $regScript) {
    & powershell -NoProfile -ExecutionPolicy Bypass -File $regScript -Quiet
    if ($LASTEXITCODE -eq 0) {
        Ok "自动启动组件已注册 —— 以后点「开启实时字幕」，本地服务会自动起来"
    } else {
        Warn "自动启动组件注册失败，照旧双击 scripts\start-server.bat 也能用"
    }
} else {
    Warn "找不到 register-native-host.ps1，跳过自动启动组件"
}
Write-Host ""
Write-Host "=====================================================" -ForegroundColor Green
Write-Host "  安装完成！" -ForegroundColor Green
Write-Host "=====================================================" -ForegroundColor Green
Write-Host ""
Write-Host "接下来：" -ForegroundColor White
Write-Host "  1. 在 Edge 里加载扩展：edge://extensions → 打开「开发人员模式」"
Write-Host "     → 点「加载解压缩的扩展」→ 选择这个文件夹：" -NoNewline
Write-Host " $ExtDir" -ForegroundColor Yellow
Write-Host "  2. 打开视频，点扩展图标 →「开启实时字幕」（本地服务会自动启动）"
Write-Host ""
Write-Host "  详细说明见 README.md" -ForegroundColor DarkGray
Write-Host ""
