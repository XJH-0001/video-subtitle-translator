$root = 'D:\DSH-Workspace\video-subtitle-translator'
$files = @(
    'scripts\clean-caches.ps1',
    'scripts\enable-gpu.ps1',
    'scripts\install.ps1',
    'scripts\register-native-host.ps1',
    'scripts\start-server.ps1',
    'tools\measure_cpu.ps1',
    'tools\regression.ps1',
    'tools\verify_extension.mjs'
)
foreach ($f in $files) {
    if ($f -like '*.mjs') { continue }
    $p = Join-Path $root $f
    if (-not (Test-Path $p)) { Write-Output "  MISS $f"; continue }
    $err = $null
    [System.Management.Automation.Language.Parser]::ParseFile($p, [ref]$null, [ref]$err) | Out-Null
    if ($err -and $err.Count -gt 0) {
        Write-Output ("  FAIL {0}" -f $f)
        $err | Select-Object -First 2 | ForEach-Object { Write-Output ("       line {0}: {1}" -f $_.Extent.StartLineNumber, $_.Message) }
    } else {
        Write-Output ("  OK   {0}" -f $f)
    }
}
