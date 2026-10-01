# =============================================================================
#  注册「自动启动本地服务」组件（Native Messaging Host）
#
#     powershell -ExecutionPolicy Bypass -File scripts\register-native-host.ps1
#     powershell -ExecutionPolicy Bypass -File scripts\register-native-host.ps1 -Unregister
#
#  为什么需要它：
#    浏览器扩展**不能**直接启动进程，这是 Chromium 的安全边界。
#    官方给的唯一通道是 Native Messaging —— 扩展调用一个注册在注册表里的本地程序，
#    由那个程序把 server\app.py 拉起来。
#
#  这个脚本做四件事：
#    1. 用 csc.exe 把 native\ServerLauncher.cs 编译成 ServerLauncher.exe
#    2. 算出扩展 ID（未打包扩展的 ID 由绝对路径推导，见下）
#    3. 生成 native\com.vst.server_launcher.json 白名单
#    4. 写注册表 HKCU\Software\Microsoft\Edge\NativeMessagingHosts\...
# =============================================================================

[CmdletBinding()]
param(
    [switch]$Unregister,
    [switch]$Quiet
)

$ErrorActionPreference = "Continue"
$Root      = Split-Path -Parent $PSScriptRoot
$NativeDir = Join-Path $Root "native"
$SrcCs     = Join-Path $NativeDir "ServerLauncher.cs"
$HostExe   = Join-Path $NativeDir "ServerLauncher.exe"
$HostName  = "com.vst.server_launcher"
$ExtDir    = Join-Path $Root "extension"

function Info($m) { if (-not $Quiet) { Write-Host "  $m" -ForegroundColor Cyan } }
function Ok($m)   { Write-Host "  [OK] $m" -ForegroundColor Green }
function Warn($m) { Write-Host "  [!] $m" -ForegroundColor Yellow }
function Die($m)  { Write-Host "  [X] $m" -ForegroundColor Red; exit 1 }

$regKeys = @(
    "HKCU:\Software\Microsoft\Edge\NativeMessagingHosts\$HostName",
    "HKCU:\Software\Google\Chrome\NativeMessagingHosts\$HostName"
)

# --- 注销 ---------------------------------------------------------------------
if ($Unregister) {
    foreach ($k in $regKeys) {
        if (Test-Path $k) {
            Remove-Item $k -Force -Recurse
            Ok "已移除 $k"
        }
    }
    exit 0
}

Write-Host ""
Write-Host "  注册自动启动组件（Native Messaging）" -ForegroundColor White

# --- 1. 编译 ------------------------------------------------------------------
if (-not (Test-Path $SrcCs)) { Die "找不到 $SrcCs" }

$needBuild = $true
if (Test-Path $HostExe) {
    $needBuild = (Get-Item $SrcCs).LastWriteTime -gt (Get-Item $HostExe).LastWriteTime
}
if ($needBuild) {
    $csc = @(
        "$env:WINDIR\Microsoft.NET\Framework64\v4.0.30319\csc.exe",
        "$env:WINDIR\Microsoft.NET\Framework\v4.0.30319\csc.exe"
    ) | Where-Object { Test-Path $_ } | Select-Object -First 1
    if (-not $csc) { Die "找不到 .NET 编译器 csc.exe（Windows 自带 .NET Framework 才有）" }
    Info "编译 ServerLauncher.exe …"
    & $csc /nologo /target:exe /optimize+ /platform:anycpu "/out:$HostExe" $SrcCs | Out-Null
    if ($LASTEXITCODE -ne 0 -or -not (Test-Path $HostExe)) { Die "编译失败" }
}
Ok "ServerLauncher.exe 就绪（$([math]::Round((Get-Item $HostExe).Length/1KB,1)) KB）"

# --- 2. 推导扩展 ID -----------------------------------------------------------
# Chromium 对未打包扩展：ID = SHA256(绝对路径的 UTF-16LE 字节) 的前 16 字节，
# 转十六进制后把每个 hex 位映射成 a~p。
function Get-ExtensionIdFromPath {
    param([string]$Path)
    $bytes = [System.Text.Encoding]::Unicode.GetBytes($Path)
    $sha = [System.Security.Cryptography.SHA256]::Create()
    try { $hash = $sha.ComputeHash($bytes) } finally { $sha.Dispose() }
    $hex = -join ($hash[0..15] | ForEach-Object { $_.ToString("x2") })
    $chars = $hex.ToCharArray() | ForEach-Object { [char]([int][char]'a' + [Convert]::ToInt32($_, 16)) }
    return -join $chars
}

$extPath = (Resolve-Path $ExtDir).Path
$extId = Get-ExtensionIdFromPath -Path $extPath
if ($extId.Length -ne 32 -or $extId -notmatch '^[a-p]{32}$') { Die "扩展 ID 推导异常：$extId" }
Ok "扩展 ID：$extId"

# --- 3. 生成白名单 manifest ---------------------------------------------------
$manifestPath = Join-Path $NativeDir "$HostName.json"
$manifest = [ordered]@{
    name            = $HostName
    description     = "视频实时字幕翻译 - 本地服务启动器"
    path            = $HostExe
    type            = "stdio"
    allowed_origins = @("chrome-extension://$extId/")
}
[System.IO.File]::WriteAllText($manifestPath, ($manifest | ConvertTo-Json -Depth 5),
                               (New-Object System.Text.UTF8Encoding($false)))
Ok "白名单：$manifestPath"

# --- 4. 写注册表 --------------------------------------------------------------
foreach ($k in $regKeys) {
    try {
        New-Item -Path $k -Force | Out-Null
        Set-ItemProperty -Path $k -Name "(default)" -Value $manifestPath
    } catch {
        Die "写注册表失败 $k : $_"
    }
}
Ok "已注册 Edge / Chrome"

Write-Host ""
Write-Host "  完成。以后点「开启实时字幕」，本地服务会自动起来。" -ForegroundColor Green
Write-Host "  想撤销：scripts\register-native-host.ps1 -Unregister" -ForegroundColor DarkGray
Write-Host ""
exit 0
