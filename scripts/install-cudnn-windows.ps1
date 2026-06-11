#Requires -Version 5.1
# Install cuDNN on Windows and persist the lib path to the user's LIB / PATH
# environment variables so future terminals pick it up automatically.
# Safe to re-run: exits early when cudnn.lib is already reachable.
# For the automated per-build detection, see find-cudnn-lib-path.ps1.

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Add-UserEnvPath([string]$Var, [string]$Dir) {
    $current = [Environment]::GetEnvironmentVariable($Var, 'User')
    if ($current -notlike "*$Dir*") {
        $updated = if ($current) { "$current;$Dir" } else { $Dir }
        [Environment]::SetEnvironmentVariable($Var, $updated, 'User')
        Write-Host "  Added to user $Var`: $Dir"
    } else {
        Write-Host "  Already in user $Var`: $Dir"
    }
}

# Delegate detection to the shared script, capturing its stdout (the lib dir path).
# Diagnostic messages from find-cudnn-lib-path.ps1 go to stderr and appear on console.
$libDir = & "$PSScriptRoot\find-cudnn-lib-path.ps1"
if ($LASTEXITCODE -ne 0 -or -not $libDir) {
    Write-Error "Could not locate or install cuDNN. See messages above."
    exit 1
}

Write-Host "cuDNN lib directory: $libDir"

# Persist LIB so future shells and IDEs see it without re-running make.
Add-UserEnvPath -Var 'LIB' -Dir $libDir

# Also persist bin/ (DLLs) to PATH if it exists alongside the lib directory.
$binCandidates = @(
    (Join-Path (Split-Path $libDir -Parent) 'bin'),
    (Join-Path (Split-Path $libDir -Parent) '../bin' | Resolve-Path -ErrorAction SilentlyContinue)
)
foreach ($bin in $binCandidates) {
    if ($bin -and (Test-Path $bin)) {
        Add-UserEnvPath -Var 'PATH' -Dir $bin
        break
    }
}

Write-Host ""
Write-Host "Done. Re-open your terminal / IDE for the persistent env changes to take effect."
Write-Host "(The current make session already has cuDNN on LIB via the CUDNN_LIB_DIR variable.)"
