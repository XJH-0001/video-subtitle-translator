# =============================================================================
#  更新 API Key（输入时不回显，也不会被打印到任何地方）
#
#     powershell -ExecutionPolicy Bypass -File scripts\set-api-key.ps1
#     powershell -ExecutionPolicy Bypass -File scripts\set-api-key.ps1 -Show   # 只看当前配置（打码）
#
#  为什么单独写这个脚本：
#    直接手改 config.json 当然也行，但更常见的是把 Key 粘到聊天/终端里让人帮忙改 ——
#    那样 Key 就留在了会话记录、命令历史里。这个脚本用安全输入读 Key，
#    全程不显示、不写日志，只落进 server\config.json（该文件已被 .gitignore 挡住）。
# =============================================================================

[CmdletBinding()]
param([switch]$Show)

$ErrorActionPreference = "Stop"
$Root      = Split-Path -Parent $PSScriptRoot
$ConfigDir = Join-Path $Root "server"
$Config    = Join-Path $ConfigDir "config.json"
$Example   = Join-Path $ConfigDir "config.example.json"

function Info($m) { Write-Host "  $m" -ForegroundColor Cyan }
function Ok($m)   { Write-Host "  [OK] $m" -ForegroundColor Green }
function Warn($m) { Write-Host "  [!] $m" -ForegroundColor Yellow }
function Die($m)  { Write-Host "  [X] $m" -ForegroundColor Red; exit 1 }

function MaskKey($k) {
    if (-not $k) { return "(未设置)" }
    if ($k.Length -le 12) { return "(太短，可能不完整)" }
    return $k.Substring(0, 7) + "…" + $k.Substring($k.Length - 4)
}

Write-Host ""
Write-Host "  API Key 管理" -ForegroundColor White
Write-Host ""

# --- 只查看模式 ---------------------------------------------------------------
if ($Show) {
    if (-not (Test-Path $Config)) { Warn "还没有 server\config.json，跑一次不带 -Show 的即可创建"; exit 0 }
    $cfg = Get-Content $Config -Raw -Encoding UTF8 | ConvertFrom-Json
    Ok "配置文件：$Config"
    Info "翻译服务 ：$($cfg.translator)"
    Info "接口地址 ：$($cfg.openai_base_url)"
    Info "模型     ：$($cfg.openai_model)"
    Info "当前 Key ：$(MaskKey $cfg.openai_api_key)"
    Write-Host ""
    exit 0
}

# --- 先确认要往哪写 -----------------------------------------------------------
if (Test-Path $Config) {
    Ok "已找到 $Config"
} else {
    if (-not (Test-Path $Example)) { Die "既没有 config.json 也没有 config.example.json，请先跑 scripts\install.ps1" }
    Copy-Item $Example $Config
    Ok "已从模板创建 $Config"
}

Write-Host ""
Write-Host "  请到 DeepSeek 控制台拿到新 Key 后再运行本脚本：" -ForegroundColor DarkGray
Write-Host "    https://platform.deepseek.com/api_keys" -ForegroundColor DarkGray
Write-Host ""

# --- 安全读取（不回显）--------------------------------------------------------
$secure = Read-Host "  粘贴新的 API Key（输入时不显示，直接回车取消）" -AsSecureString
$bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
try {
    $key = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr)
} finally {
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr)
}

$key = ($key -replace '\s', '')          # 粘进来常带换行/空格
if (-not $key) { Warn "没有输入，什么都没改"; exit 0 }
if ($key.Length -lt 20) { Die "这个 Key 看着太短（$($key.Length) 位），是不是复制漏了？" }
if ($key -notmatch '^sk-') { Warn "DeepSeek 的 Key 一般以 sk- 开头，确认一下是不是复制错了" }

# --- 写进 config.json（保留其它字段）------------------------------------------
$cfg = Get-Content $Config -Raw -Encoding UTF8 | ConvertFrom-Json
$old = MaskKey $cfg.openai_api_key
$cfg.openai_api_key = $key

# 顺手把翻译服务指向 openai，免得换了 Key 却发现没在用
if (-not $cfg.translator -or $cfg.translator -eq 'auto') { $cfg.translator = 'openai' }

# 保持 UTF-8 无 BOM、缩进 2、中文不转义
$json = $cfg | ConvertTo-Json -Depth 10
[System.IO.File]::WriteAllText($Config, $json, (New-Object System.Text.UTF8Encoding($false)))

Ok "已更新：$old  →  $(MaskKey $key)"
Info "翻译服务：$($cfg.translator) / $($cfg.openai_model)"

# --- 确认 git 不会把它提交出去 -------------------------------------------------
Push-Location $Root
$ignored = & git check-ignore -v "server/config.json" 2>$null
Pop-Location
if ($ignored) {
    Ok "git 已忽略该文件：$ignored"
} else {
    Warn "⚠ 这个文件没有被 .gitignore 挡住！提交前务必确认"
}

Write-Host ""
Write-Host "  下一步：到 edge://extensions 重新加载扩展，让服务读新配置。" -ForegroundColor Green
Write-Host "          （重载扩展会自动重启本地服务，不用手动开窗口）" -ForegroundColor DarkGray
Write-Host ""
