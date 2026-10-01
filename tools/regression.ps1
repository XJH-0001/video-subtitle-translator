# =============================================================================
#  全量回归测试：改完代码跑这一条就够了
#
#     powershell -ExecutionPolicy Bypass -File tools\regression.ps1
#     powershell -ExecutionPolicy Bypass -File tools\regression.ps1 -Model small -SkipBrowser
# =============================================================================

[CmdletBinding()]
param(
    [string]$Model = "tiny",
    [switch]$SkipBrowser,
    [switch]$Realtime
)

$ErrorActionPreference = "Continue"
$Root   = Split-Path -Parent $PSScriptRoot
$Server = Join-Path $Root "server"
$VPy    = Join-Path $Server ".venv\Scripts\python.exe"

$env:PYTHONUTF8 = "1"
$env:PYTHONIOENCODING = "utf-8"
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }

$script:Failed = @()
$script:Passed = @()

function Step($name) {
    Write-Host ""
    Write-Host ("─" * 62) -ForegroundColor DarkGray
    Write-Host "  $name" -ForegroundColor White
    Write-Host ("─" * 62) -ForegroundColor DarkGray
}
function Verdict($name, $code) {
    if ($code -eq 0) { $script:Passed += $name; Write-Host "  ✔ $name" -ForegroundColor Green }
    else { $script:Failed += $name; Write-Host "  ✘ $name (exit=$code)" -ForegroundColor Red }
}

if (-not (Test-Path $VPy)) {
    Write-Host "找不到虚拟环境，请先运行 scripts\install.ps1" -ForegroundColor Red
    exit 1
}

Write-Host ""
Write-Host ("=" * 62) -ForegroundColor Cyan
Write-Host "  全量回归测试" -ForegroundColor Cyan
Write-Host ("=" * 62) -ForegroundColor Cyan

# --- 1. 扩展 JS 语法 ---------------------------------------------------------
Step "1/6  扩展 JS 语法检查"
$bad = 0
Get-ChildItem (Join-Path $Root "extension") -Filter *.js | ForEach-Object {
    $null = & node --check $_.FullName 2>&1
    if ($LASTEXITCODE -ne 0) { Write-Host "     语法错误: $($_.Name)" -ForegroundColor Red; $bad++ }
}
# manifest 可解析 + 引用的文件都存在
try {
    $extDir = Join-Path $Root "extension"
    $manifest = Get-Content (Join-Path $extDir "manifest.json") -Raw -Encoding UTF8 | ConvertFrom-Json
    $refs = @($manifest.background.service_worker, $manifest.action.default_popup, $manifest.options_page)
    $refs += @($manifest.content_scripts[0].js)
    $refs += @($manifest.icons.PSObject.Properties.Value)
    $missing = @($refs | Select-Object -Unique | Where-Object { $_ -and -not (Test-Path (Join-Path $extDir $_)) })
    if ($missing.Count -gt 0) {
        Write-Host "     缺少文件: $($missing -join ', ')" -ForegroundColor Red
        $bad++
    } else {
        Write-Host "     manifest 合法，引用的 $((@($refs | Select-Object -Unique)).Count) 个文件都在"
    }
} catch {
    Write-Host "     manifest.json 解析失败: $_" -ForegroundColor Red
    $bad++
}
Verdict "扩展静态检查" $bad

# --- 2. 文本过滤单元测试 ------------------------------------------------------
Step "2/6  文本过滤单元测试（幻觉 / 重复折叠）"
Push-Location $Server
& $VPy "tests\test_text_filters.py"
Verdict "文本过滤单元测试" $LASTEXITCODE
Pop-Location

# --- 3. 环境自检 -------------------------------------------------------------
Step "3/6  环境自检（依赖 / 模型 / 识别 / 翻译）"
Push-Location $Server
& $VPy "selftest.py" --model $Model
Verdict "环境自检" $LASTEXITCODE
Pop-Location

# --- 4. 端到端联调 -----------------------------------------------------------
Step "4/6  端到端联调（WebSocket + 流式识别 + 翻译）"
Push-Location $Server
if ($Realtime) { & $VPy "tests\e2e_test.py" --model $Model --realtime }
else           { & $VPy "tests\e2e_test.py" --model $Model }
Verdict "端到端联调" $LASTEXITCODE
Pop-Location

# --- 5. 真实浏览器加载扩展 -----------------------------------------------------
if ($SkipBrowser) {
    Step "5/6  真实浏览器验证（已跳过）"
} else {
    Step "5/6  真实浏览器加载扩展（无头 Edge + CDP）"
    # 8765 上可能已经有一个服务在跑（比如用户自己开着的），能复用就复用：
    # 否则会撞端口，而且不该为了跑测试把用户的服务干掉。
    $existing = $false
    try {
        $r = Invoke-WebRequest -Uri "http://127.0.0.1:8765/health" -TimeoutSec 2 -UseBasicParsing
        if ($r.StatusCode -eq 200) { $existing = $true }
    } catch { }

    if ($existing) {
        Write-Host "     检测到 8765 上已有服务在运行，直接复用" -ForegroundColor DarkGray
        Push-Location $Root
        & node "tools\verify_extension.mjs"
        Verdict "浏览器验证" $LASTEXITCODE
        Pop-Location
    } else {
        $srv = Start-Process -FilePath $VPy -ArgumentList @("app.py","--port","8765","--model",$Model,"--log-level","warning") `
            -WorkingDirectory $Server -PassThru -WindowStyle Hidden
        try {
            $ok = $false
            for ($i = 0; $i -lt 40; $i++) {
                Start-Sleep -Milliseconds 600
                try {
                    $r = Invoke-WebRequest -Uri "http://127.0.0.1:8765/health" -TimeoutSec 2 -UseBasicParsing
                    if ($r.StatusCode -eq 200) { $ok = $true; break }
                } catch { }
            }
            if (-not $ok) { Write-Host "     本地服务没起来" -ForegroundColor Red; Verdict "浏览器验证" 1 }
            else {
                Push-Location $Root
                & node "tools\verify_extension.mjs"
                Verdict "浏览器验证" $LASTEXITCODE
                Pop-Location
            }
        } finally {
            if ($srv -and -not $srv.HasExited) { Stop-Process -Id $srv.Id -Force -ErrorAction SilentlyContinue }
        }
    }
}

# --- 6. 扩展设置迁移 ----------------------------------------------------------
# 老版本把 translator 存成 "auto"（免费接口竞速），而扩展发过来的值会**覆盖**服务端配置。
# 如果不做迁移，用户重载扩展后依然走免费接口 —— 服务端明明配了 DeepSeek 也没用。
# 这个测试用真实存储值跑一遍 loadSettings()，确认会纠正成 openai / deepseek-flash。
Step "6/6  扩展设置迁移（老配置 → DeepSeek）"
Push-Location $Root
& node "tools\test_settings_migration.mjs"
Verdict "扩展设置迁移" $LASTEXITCODE
Pop-Location

# --- 汇总 -------------------------------------------------------------------
Get-ChildItem $Root -Recurse -Directory -Filter '__pycache__' -ErrorAction SilentlyContinue |
    Remove-Item -Recurse -Force -ErrorAction SilentlyContinue

Write-Host ""
Write-Host ("=" * 62) -ForegroundColor Cyan
foreach ($p in $script:Passed) { Write-Host "  ✔ $p" -ForegroundColor Green }
foreach ($f in $script:Failed) { Write-Host "  ✘ $f" -ForegroundColor Red }
if ($script:Failed.Count -eq 0) {
    Write-Host "`n  全部通过 ✅" -ForegroundColor Green
} else {
    Write-Host "`n  $($script:Failed.Count) 项失败 ❌" -ForegroundColor Red
}
Write-Host ("=" * 62) -ForegroundColor Cyan
exit $script:Failed.Count
