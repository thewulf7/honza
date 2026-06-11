#Requires -Version 5.1
# Outputs the directory containing cudnn.lib to stdout.
# All diagnostic messages go to stderr so make's $(shell ...) capture stays clean.
# Strategy:
#   1. Check LIB paths and CUDA toolkit for an existing cudnn*.lib
#   2. Check if we already generated one in src-tauri/.cudnn-lib/
#   3. Generate cudnn.lib from the DLL in nvidia-cudnn-cu12 (pip) using MSVC lib.exe
#   4. Install nvidia-cudnn-cu12 via pip first if not present, then generate
# Exit 0 + path on success; exit 1 on failure.

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Continue'   # pip warnings must not abort the script

function Log([string]$msg) { [Console]::Error.WriteLine($msg) }

# Local cache dir for the generated import library (gitignored).
# NOTE: keep $CacheDir a plain string — emitting a PathInfo object followed by
# an immediate `exit` races the output formatter and stdout ends up empty.
$CacheDir = (Join-Path $PSScriptRoot '..\src-tauri\.cudnn-lib' | Resolve-Path -ErrorAction SilentlyContinue).Path
if (-not $CacheDir) {
    $CacheDir = Join-Path $PSScriptRoot '..\src-tauri\.cudnn-lib'
    New-Item -ItemType Directory -Force -Path $CacheDir | Out-Null
    $CacheDir = (Resolve-Path $CacheDir).Path
}

# ── 1. Existing cudnn*.lib on LIB ────────────────────────────────────────────
foreach ($dir in ($env:LIB -split ';' | Where-Object { $_ -ne '' })) {
    if (Get-ChildItem $dir -Filter 'cudnn*.lib' -ErrorAction SilentlyContinue | Select-Object -First 1) {
        Write-Output $dir; exit 0
    }
}

# ── 2. CUDA toolkit ──────────────────────────────────────────────────────────
$cudaBase = 'C:\Program Files\NVIDIA GPU Computing Toolkit\CUDA'
if (Test-Path $cudaBase) {
    foreach ($v in (Get-ChildItem $cudaBase -Directory | Sort-Object Name -Descending)) {
        $libDir = Join-Path $v.FullName 'lib\x64'
        if (Get-ChildItem $libDir -Filter 'cudnn*.lib' -ErrorAction SilentlyContinue | Select-Object -First 1) {
            Write-Output $libDir; exit 0
        }
    }
}

# ── 3. Already-generated import lib cache ────────────────────────────────────
if (Test-Path (Join-Path $CacheDir 'cudnn.lib')) {
    Write-Output $CacheDir; exit 0
}

# ── Helper: find cudnn64*.dll from the pip package ───────────────────────────
function Get-CudnnDllPath {
    $p = python -c @'
import importlib.metadata, sys
try:
    dist = importlib.metadata.distribution('nvidia-cudnn-cu12')
    for f in dist.files:
        n = f.name.lower()
        if n.startswith('cudnn64') and n.endswith('.dll'):
            print(str(f.locate().resolve()))
            sys.exit(0)
except importlib.metadata.PackageNotFoundError:
    pass
sys.exit(1)
'@ 2>$null
    if ($LASTEXITCODE -eq 0 -and $p) { return $p.Trim() }
    return $null
}

# ── Helper: generate cudnn.lib from a DLL using MSVC tools ───────────────────
function New-CudnnImportLib([string]$DllPath, [string]$OutDir) {
    $vswhere = 'C:\Program Files (x86)\Microsoft Visual Studio\Installer\vswhere.exe'
    if (-not (Test-Path $vswhere)) { Log "vswhere.exe not found"; return $null }

    $vsPath = (& $vswhere -latest -property installationPath 2>$null | Select-Object -Last 1)
    if (-not $vsPath) { Log "Visual Studio not found via vswhere"; return $null }

    $libExe = Get-ChildItem (Join-Path $vsPath 'VC\Tools\MSVC') -Recurse -Filter 'lib.exe' -ErrorAction SilentlyContinue |
              Where-Object { $_.FullName -like '*Hostx64\x64*' } |
              Select-Object -First 1 -ExpandProperty FullName
    if (-not $libExe) { Log "lib.exe not found in VS installation"; return $null }

    $dumpbin = Join-Path (Split-Path $libExe) 'dumpbin.exe'
    if (-not (Test-Path $dumpbin)) { Log "dumpbin.exe not found"; return $null }

    # Parse exports
    $raw     = & $dumpbin /exports $DllPath 2>$null
    $exports = $raw | Where-Object { $_ -match '^\s+\d+\s+[0-9A-Fa-f]+\s+[0-9A-Fa-f]+\s+(\S+)\s*$' } |
               ForEach-Object { $Matches[1] }
    if (-not $exports -or @($exports).Count -eq 0) { Log "No exports found in $DllPath"; return $null }

    Log "Generating cudnn.lib from $(Split-Path $DllPath -Leaf) ($(@($exports).Count) exports)..."

    $dllBase = [System.IO.Path]::GetFileNameWithoutExtension($DllPath)
    $defLines = @("LIBRARY `"$dllBase`"", 'EXPORTS') + @($exports)
    $defFile  = Join-Path $OutDir 'cudnn.def'
    [System.IO.File]::WriteAllLines($defFile, $defLines, [System.Text.Encoding]::ASCII)

    $libFile = Join-Path $OutDir 'cudnn.lib'
    & $libExe "/def:$defFile" "/out:$libFile" /machine:x64 2>$null | Out-Null

    if (-not (Test-Path $libFile)) { Log "lib.exe failed to produce cudnn.lib"; return $null }
    Log "Generated: $libFile"

    # Copy all cuDNN DLLs into the cache dir so PATH only needs one entry for
    # both link-time (cudnn.lib) and run-time (cudnn*.dll) resolution.
    $dllDir = Split-Path $DllPath
    Get-ChildItem $dllDir -Filter 'cudnn*.dll' | ForEach-Object {
        $dest = Join-Path $OutDir $_.Name
        if (-not (Test-Path $dest)) {
            Copy-Item $_.FullName $dest
            Log "Copied $($_.Name) to cache"
        }
    }

    return $OutDir
}

# ── 4. Try to generate from already-installed pip package ────────────────────
$dllPath = Get-CudnnDllPath
if ($dllPath) {
    $result = New-CudnnImportLib -DllPath $dllPath -OutDir $CacheDir
    if ($result) { Write-Output $result; exit 0 }
}

# ── 5. Install pip package then generate ─────────────────────────────────────
$pkg = 'nvidia-cudnn-cu12'
try {
    $v = & nvcc --version 2>&1 | Out-String
    if ($v -match 'release 11\.') { $pkg = 'nvidia-cudnn-cu11' }
} catch { }

Log "Installing $pkg via pip..."
pip install $pkg --quiet 2>$null
$pipExit = $LASTEXITCODE
if ($pipExit -ne 0) {
    Log "ERROR: pip install $pkg failed (exit $pipExit)."
    exit 1
}

$dllPath = Get-CudnnDllPath
if (-not $dllPath) {
    Log "ERROR: $pkg installed but cudnn64*.dll not found in package."
    exit 1
}

$result = New-CudnnImportLib -DllPath $dllPath -OutDir $CacheDir
if ($result) { Write-Output $result; exit 0 }

Log "ERROR: Could not generate cudnn.lib. Install the NVIDIA cuDNN SDK manually"
Log "       and add its lib\x64 directory to the LIB environment variable."
exit 1
