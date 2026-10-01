# =============================================================================
#  测「跑字幕时到底占多少 CPU / 内存」
#
#     powershell -ExecutionPolicy Bypass -File tools\measure_cpu.ps1
#     powershell -ExecutionPolicy Bypass -File tools\measure_cpu.ps1 -Models small,base
#
#  做法：按真实速度推 21 秒音频，采样服务进程消耗的 CPU 时间与内存峰值。
#  Whisper 的负载是「一阵一阵」的（说话时才算），所以平均值和瞬时峰值要分开看。
# =============================================================================

[CmdletBinding()]
param(
    [string[]]$Models = @("small", "base"),
    [int]$Port = 8798
)

$ErrorActionPreference = "Continue"
$Root   = Split-Path -Parent $PSScriptRoot
$Server = Join-Path $Root "server"
$VPy    = Join-Path $Server ".venv\Scripts\python.exe"
$env:PYTHONUTF8 = "1"
$env:PYTHONIOENCODING = "utf-8"

$cores = [Environment]::ProcessorCount

function Stop-Port($p) {
    $c = Get-NetTCPConnection -LocalPort $p -State Listen -ErrorAction SilentlyContinue
    if ($c) { Stop-Process -Id ($c.OwningProcess | Select-Object -First 1) -Force -ErrorAction SilentlyContinue; Start-Sleep -Seconds 1 }
}

# 按命令行找「真正在跑 app.py」的所有进程并累计 CPU/内存。
# 不能只看 Start-Process 返回的那个 PID —— uv 建的 venv 里 python.exe 是个转发器，
# 真正干活的是它拉起来的子进程；直接采那个壳子会得到 0 CPU / 5MB 这种假数据。
function Get-ServerStat($port) {
    $cpu = 0.0
    $mem = 0
    $n = 0
    $procs = Get-CimInstance Win32_Process -Filter "Name='python.exe'" -ErrorAction SilentlyContinue |
        Where-Object { $_.CommandLine -and $_.CommandLine -match 'app\.py' -and $_.CommandLine -match "--port\s+$port" }
    foreach ($p in $procs) {
        $cpu += ($p.UserModeTime + $p.KernelModeTime) / 10000000.0   # 100ns → 秒
        $mem += [int64]$p.WorkingSetSize
        $n++
    }
    return [pscustomobject]@{ cpu = $cpu; mem = $mem; count = $n }
}

Write-Host ""
Write-Host "  本机逻辑核心数：$cores" -ForegroundColor Cyan
Write-Host ""

$results = @()

foreach ($model in $Models) {
    Write-Host ("=" * 62) -ForegroundColor DarkGray
    Write-Host "  测试模型：$model" -ForegroundColor White
    Write-Host ("=" * 62) -ForegroundColor DarkGray
    Stop-Port $Port

    $proc = Start-Process -FilePath $VPy `
        -ArgumentList @("app.py", "--port", "$Port", "--model", $model, "--log-level", "warning") `
        -WorkingDirectory $Server -PassThru -WindowStyle Hidden

    try {
        # 等服务就绪
        $ready = $false
        for ($i = 0; $i -lt 180; $i++) {
            Start-Sleep -Milliseconds 500
            try { if ((Invoke-WebRequest "http://127.0.0.1:$Port/health" -TimeoutSec 2 -UseBasicParsing).StatusCode -eq 200) { $ready = $true; break } } catch { }
        }
        if (-not $ready) { Write-Host "  服务没起来，跳过" -ForegroundColor Red; continue }

        $st0 = Get-ServerStat $Port
        $memPeak = $st0.mem
        $wallStart = Get-Date

        # 另起一个进程按真实速度推音频；同时每 200ms 采样一次内存峰值
        $job = Start-Job -ScriptBlock {
            param($py, $srv, $p)
            Set-Location $srv
            $env:PYTHONUTF8 = "1"; $env:PYTHONIOENCODING = "utf-8"
            & $py "tests\measure_latency.py" --port $p --external --wav sample_en.wav 2>&1 |
                Select-String -Pattern "原文延迟|收到最终字幕"
        } -ArgumentList $VPy, $Server, $Port

        while ($job.State -eq "Running") {
            Start-Sleep -Milliseconds 200
            $s = Get-ServerStat $Port
            if ($s.mem -gt $memPeak) { $memPeak = $s.mem }
        }
        Receive-Job $job | ForEach-Object { Write-Host "    $_" -ForegroundColor DarkGray }
        Remove-Job $job -Force

        $wall = ((Get-Date) - $wallStart).TotalSeconds
        $cpuUsed = (Get-ServerStat $Port).cpu - $st0.cpu
        if ($st0.count -eq 0) { Write-Host "  [警告] 没匹配到服务进程，数字不可信" -ForegroundColor Red }

        $avgOfOneCore = $cpuUsed / $wall * 100            # 占「一个核心」的百分比
        $avgOfMachine = $cpuUsed / ($wall * $cores) * 100 # 占整机的百分比
        # 瞬时峰值：解码时 ctranslate2 会用满 cpu_threads 个线程
        $threads = [Math]::Max(1, [Math]::Floor($cores / 2))
        $peakOfMachine = $threads / $cores * 100

        Write-Host ""
        Write-Host ("  推了 {0:N1}s 音频，服务进程消耗 CPU {1:N1}s" -f $wall, $cpuUsed) -ForegroundColor White
        Write-Host ("    平均占用：{0:N0}% 单核   ≈ 整机 {1:N1}%（{2} 核）" -f $avgOfOneCore, $avgOfMachine, $cores) -ForegroundColor Green
        Write-Host ("    瞬时峰值：解码那 1 秒多里会跑满 {0} 个线程 ≈ 整机 {1:N0}%" -f $threads, $peakOfMachine) -ForegroundColor Yellow
        Write-Host ("    内存峰值：{0:N0} MB" -f ($memPeak / 1MB)) -ForegroundColor Green
        Write-Host ""

        $results += [pscustomobject]@{
            模型       = $model
            '平均%单核' = [Math]::Round($avgOfOneCore)
            '平均%整机' = [Math]::Round($avgOfMachine, 1)
            '峰值%整机' = [Math]::Round($peakOfMachine)
            '内存MB'   = [Math]::Round($memPeak / 1MB)
        }
    } finally {
        if ($proc -and -not $proc.HasExited) { Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue }
        Stop-Port $Port
    }
}

Write-Host ("=" * 62) -ForegroundColor Cyan
$results | Format-Table -AutoSize
Write-Host "  说明：Whisper 是「说话时才算」的，所以平均占用不高，但解码那一下会有明显峰值。" -ForegroundColor DarkGray
Write-Host "        嫌吵/嫌热就把模型换成 base 或 tiny（弹窗里可切）。" -ForegroundColor DarkGray
Write-Host ""
