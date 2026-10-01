# =============================================================================
#  开启显卡加速
#
#     powershell -ExecutionPolicy Bypass -File scripts\enable-gpu.ps1
#
#  做了什么：
#    1. 检测 N 卡和驱动
#    2. 装 CUDA 12 的运行库（cuBLAS / cuDNN 9 / cudart）—— **用 pip 装，不用装 CUDA 工具包**
#    3. 验证 ctranslate2 真的能调用显卡
#
#  为什么推荐 pip 版运行库，而不是系统级 CUDA 工具包：
#    · 体积：工具包安装包 ~3GB、装完 6~7GB；pip 版只拉真正需要的三个运行库，约 1.3GB
#    · 不用管理员权限，不用改 PATH，不用重启
#    · 版本一定对（ctranslate2 要 CUDA 12 + cuDNN 9，工具包自己装容易装成 11.x）
#    · 只装在 venv 里，卸载干净，也不会影响系统里其他用 CUDA 的程序
#
#  你已经有系统级 CUDA 工具包也完全可以 —— 服务端两条路都会自动找：
#  （CUDA_PATH\bin、Program Files 里的默认安装位置、pip 版目录，谁有用谁）
#  那就没必要再跑这个脚本了。
# =============================================================================

[CmdletBinding()]
param([switch]$Force)

$ErrorActionPreference = "Continue"
$Root   = Split-Path -Parent $PSScriptRoot
$Server = Join-Path $Root "server"
$VPy    = Join-Path $Server ".venv\Scripts\python.exe"
$Mirror = "https://pypi.tuna.tsinghua.edu.cn/simple"

function Ok($m)   { Write-Host "  [OK] $m" -ForegroundColor Green }
function Info($m) { Write-Host "  $m" -ForegroundColor Cyan }
function Warn($m) { Write-Host "  [!] $m" -ForegroundColor Yellow }
function Die($m)  { Write-Host "  [X] $m" -ForegroundColor Red; exit 1 }

Write-Host ""
Write-Host "  开启显卡加速" -ForegroundColor White
Write-Host ""

# 把包管理器的下载缓存也放进项目目录（D 盘），别往 C 盘用户目录堆。
# 实测 CUDA 运行库会在 uv 缓存里占掉约 2GB，堆在系统盘上很没必要。
$env:UV_CACHE_DIR = Join-Path $Root ".cache\uv"
$env:PIP_CACHE_DIR = Join-Path $Root ".cache\pip"
New-Item -ItemType Directory -Force -Path $env:UV_CACHE_DIR | Out-Null

if (-not (Test-Path $VPy)) { Die "找不到 $VPy，请先运行 scripts\install.ps1" }

# --- 1. 有没有 N 卡 -----------------------------------------------------------
$smi = Get-Command nvidia-smi -ErrorAction SilentlyContinue
if (-not $smi) {
    Warn "没检测到 NVIDIA 显卡（找不到 nvidia-smi）"
    Info "AMD / Intel 核显目前用不了 CTranslate2 的加速，只能用 CPU。"
    exit 0
}
$gpuLine = (& nvidia-smi --query-gpu=name,driver_version,memory.total,compute_cap --format=csv,noheader 2>&1 | Select-Object -First 1)
Ok "显卡：$gpuLine"

$cap = ($gpuLine -split ',')[3].Trim()
$capVal = 0.0
[void][double]::TryParse($cap, [ref]$capVal)
if ($capVal -gt 0 -and $capVal -lt 7.0) {
    Warn "算力 $cap 偏老，CTranslate2 的 float16 可能不支持，会自动降到 int8_float16 或 CPU。"
}

# --- 2. 已经能用了吗 ----------------------------------------------------------
# 注意：不能用 -eq 直接比 Select-String 的结果 —— 那是 MatchInfo 对象不是字符串，
# 比出来永远是 false，结果就是「明明装好了还白装一遍」。
Info "检查现有 CUDA 运行库…"
$probeOut = (& $VPy -c @"
import sys
sys.path.insert(0, r'$Server')
from asr import _cuda_libs_present
print('YES' if _cuda_libs_present() else 'NO')
"@ 2>$null | Out-String)
if (($probeOut -match '(?m)^YES\s*$') -and -not $Force) {
    Ok "CUDA 运行库已就绪（系统级工具包或之前的 pip 安装），不需要再装"
    Write-Host ""
    Write-Host "  直接启动服务就是显卡加速。想强制重装可以加 -Force" -ForegroundColor DarkGray
    Write-Host ""
    exit 0
}

# --- 3. 装运行库 --------------------------------------------------------------
Info "安装 CUDA 12 运行库（约 1.3GB，几分钟；走清华镜像）…"
$uv = Join-Path $env:USERPROFILE ".local\bin\uv.exe"
if (Test-Path $uv) {
    & $uv pip install --python $VPy -i $Mirror nvidia-cublas-cu12 nvidia-cudnn-cu12 nvidia-cuda-runtime-cu12 2>&1 |
        Where-Object { $_ -notmatch '^\s*(Using Python|Resolved|Checked|Prepared|Audited|Downloading|Downloaded)' }
} else {
    & $VPy -m pip install -i $Mirror nvidia-cublas-cu12 nvidia-cudnn-cu12 nvidia-cuda-runtime-cu12 2>&1 |
        Where-Object { $_ -notmatch 'already satisfied' }
}
if ($LASTEXITCODE -ne 0) { Die "安装失败，检查网络或换镜像" }
Ok "运行库安装完成"

# --- 4. 真跑一次验证 ----------------------------------------------------------
Write-Host ""
Info "验证显卡能不能真的用来识别…"
$verify = & $VPy -c @"
import sys, time
sys.path.insert(0, r'$Server')
from asr import _add_nvidia_dll_dirs, _cuda_libs_present
_add_nvidia_dll_dirs()
if not _cuda_libs_present():
    print('FAIL 运行库还是加载不了'); raise SystemExit(1)
import ctranslate2
n = ctranslate2.get_cuda_device_count()
if n < 1:
    print('FAIL CTranslate2 看不到显卡'); raise SystemExit(1)
from faster_whisper import WhisperModel
from pathlib import Path
from selftest import read_wav_16k
audio = read_wav_16k(Path(r'$Server\tests\sample_en.wav'))[5*16000:10*16000]
m = WhisperModel('tiny', device='cuda', compute_type='float16', num_workers=1, download_root=r'$Server\models')
segs, _ = m.transcribe(audio, language='en', beam_size=1, without_timestamps=True, vad_filter=False)
list(segs)
best = None
for _ in range(3):
    t0 = time.time()
    segs, _ = m.transcribe(audio, language='en', beam_size=1, without_timestamps=True, vad_filter=False)
    list(segs)
    d = time.time() - t0
    best = d if best is None else min(best, d)
print(f'OK {best*1000:.0f}')
"@ 2>&1
$okLine = $verify | Select-String -Pattern '^OK ' | Select-Object -First 1
if ($okLine) {
    $ms = ($okLine -replace '^OK ', '').Trim()
    Ok "显卡可用！tiny 模型一次解码 $ms ms（CPU 上要 200ms 以上）"
    Write-Host ""
    Write-Host "  下次点「开启实时字幕」就是显卡加速了，字幕延迟约 0.5 秒。" -ForegroundColor Green
} else {
    Write-Host $verify
    Warn "显卡验证没通过，服务会自动回退到 CPU（不影响使用）"
}
Write-Host ""
