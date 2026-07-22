param(
  [string]$Name = "D-aquila-Windows-Setup",
  [int]$Port = 8000
)

$ErrorActionPreference = "Stop"
$RepoRoot = Resolve-Path (Join-Path $PSScriptRoot "..")
$VenvPython = Join-Path $RepoRoot ".venv\Scripts\python.exe"
$Launcher = Join-Path $RepoRoot "windows_launcher.py"
$OutputDir = Join-Path $RepoRoot "dist\release"

if (-not (Test-Path $VenvPython)) {
  Write-Host "[D-aquila Windows] venv not found. Running install-windows.ps1 first." -ForegroundColor Yellow
  & (Join-Path $PSScriptRoot "install-windows.ps1") -Port $Port
}

Write-Host "[D-aquila Windows] Installing PyInstaller." -ForegroundColor Cyan
& $VenvPython -m pip install pyinstaller

$addData = @(
  "index.html;.",
  "app.js;.",
  "styles.css;.",
  "hardware3d.js;.",
  "assets;assets",
  "backend;backend",
  "requirements-windows.txt;."
)

$pyInstallerArgs = @(
  "-m", "PyInstaller",
  "--noconfirm",
  "--clean",
  "--onefile",
  "--windowed",
  "--name", $Name,
  "--distpath", $OutputDir
)

foreach ($item in $addData) {
  $pyInstallerArgs += "--add-data"
  $pyInstallerArgs += $item
}

$pyInstallerArgs += $Launcher

Write-Host "[D-aquila Windows] Building single-file installer: dist\release\$Name.exe" -ForegroundColor Cyan
& $VenvPython @pyInstallerArgs

Write-Host ""
Write-Host "Single-file installer build completed:" -ForegroundColor Green
Write-Host "  dist\release\$Name.exe" -ForegroundColor Yellow
Write-Host ""
Write-Host "Upload this EXE to GitHub Releases. End users only need to download and double-click it." -ForegroundColor Cyan
