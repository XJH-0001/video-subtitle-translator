# 校验项目里所有 PowerShell 脚本能否被 Windows PowerShell 5.1 正确解析。
#
#     powershell -ExecutionPolicy Bypass -File tools\check-scripts.ps1
#
# 为什么需要：
#   Windows PowerShell 5.1 按 ANSI 读取没有 BOM 的 UTF-8 文件，
#   中文会变乱码，进而把 here-string（@" "@）之类的语法搞坏，
#   报出 "Unexpected attribute 'CmdletBinding'" 这种看着毫不相关的错。
#   改完 .ps1 之后跑一下这个，比等到运行时才发现强。

$Root = Split-Path -Parent $PSScriptRoot
$bad = 0
$n = 0

foreach ($f in Get-ChildItem $Root -Recurse -Filter *.ps1 -File -ErrorAction SilentlyContinue |
        Where-Object { $_.FullName -notmatch '\\\.venv\\' }) {
    $n++
    $rel = $f.FullName.Replace("$Root\", "")
    $err = $null
    [System.Management.Automation.Language.Parser]::ParseFile($f.FullName, [ref]$null, [ref]$err) | Out-Null
    if ($err -and $err.Count -gt 0) {
        $bad++
        Write-Host "  FAIL $rel" -ForegroundColor Red
        $err | Select-Object -First 3 | ForEach-Object {
            Write-Host ("       line {0}: {1}" -f $_.Extent.StartLineNumber, $_.Message) -ForegroundColor DarkGray
        }
    } else {
        # 顺带检查 BOM —— 没有 BOM 的中文 .ps1 在 5.1 下迟早出问题
        $bytes = [System.IO.File]::ReadAllBytes($f.FullName)
        $hasBom = $bytes.Length -ge 3 -and $bytes[0] -eq 0xEF -and $bytes[1] -eq 0xBB -and $bytes[2] -eq 0xBF
        if ($hasBom) {
            Write-Host "  OK   $rel" -ForegroundColor Green
        } else {
            Write-Host "  OK   $rel  (缺 UTF-8 BOM，含中文时会乱码)" -ForegroundColor Yellow
        }
    }
}

Write-Host ""
if ($bad -eq 0) {
    Write-Host "  $n 个脚本全部通过" -ForegroundColor Green
} else {
    Write-Host "  $bad / $n 个脚本有问题" -ForegroundColor Red
}
exit $bad
