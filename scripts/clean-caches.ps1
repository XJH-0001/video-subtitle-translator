# =============================================================================
#  清理 C 盘上的下载缓存
#
#     powershell -ExecutionPolicy Bypass -File scripts\clean-caches.ps1 -DryRun
#     powershell -ExecutionPolicy Bypass -File scripts\clean-caches.ps1
#
#  背景：pip / uv 会把下载过的安装包缓存在用户目录（C 盘），
#  装 CUDA 运行库那一次就会在 uv 缓存里留下约 2GB，装在系统盘上很没必要。
#
#  重要：**清缓存不会影响已经装好的东西。**
#    真正的库在 server\.venv\Lib\site-packages 里（D 盘），缓存只是「下次重装时不用再下载」。
#    清了之后显卡加速照常能用，只有重新安装依赖时会慢一点。
# =============================================================================

[CmdletBinding()]
param([switch]$DryRun)

$ErrorActionPreference = "Continue"

function SizeMB($p) {
    if (-not (Test-Path $p)) { return 0 }
    $s = (Get-ChildItem $p -Recurse -File -ErrorAction SilentlyContinue | Measure-Object Length -Sum).Sum
    if (-not $s) { return 0 }
    return [math]::Round($s / 1MB, 0)
}

$targets = @(
    @{ name = "uv 包缓存";  path = "$env:LOCALAPPDATA\uv\cache" }
    @{ name = "pip 包缓存"; path = "$env:LOCALAPPDATA\pip\cache" }
)

Write-Host ""
Write-Host "  C 盘下载缓存清理" -ForegroundColor White
Write-Host ""

$total = 0
$toDelete = @()
foreach ($t in $targets) {
    if (-not (Test-Path $t.path)) { continue }
    $sz = SizeMB $t.path
    if ($sz -eq 0) { continue }
    Write-Host ("  {0,-14} {1,7} MB   {2}" -f $t.name, $sz, $t.path) -ForegroundColor Cyan
    $total += $sz
    $toDelete += $t.path
}

if ($total -eq 0) { Write-Host "  没有缓存需要清理" -ForegroundColor Green; exit 0 }

Write-Host ""
Write-Host ("  合计可释放：{0} MB   （当前 C 盘剩余 {1:N0} GB）" -f $total, ((Get-PSDrive C).Free / 1GB)) -ForegroundColor Yellow

if ($DryRun) {
    Write-Host ""
    Write-Host "  这是 -DryRun，什么都没删。确认后去掉 -DryRun 再跑一次。" -ForegroundColor DarkGray
    Write-Host ""
    exit 0
}

Write-Host ""
foreach ($p in $toDelete) {
    try {
        Remove-Item $p -Recurse -Force -ErrorAction Stop
        Write-Host "  已删除 $p" -ForegroundColor Green
    } catch {
        Write-Host "  删除失败 $p ：$_" -ForegroundColor Yellow
    }
}

Write-Host ""
Write-Host ("  完成。C 盘现在剩余 {0:N0} GB" -f ((Get-PSDrive C).Free / 1GB)) -ForegroundColor Green
Write-Host "  显卡加速不受影响 —— 真正的库在 server\.venv 里（D 盘）。" -ForegroundColor DarkGray
Write-Host ""
