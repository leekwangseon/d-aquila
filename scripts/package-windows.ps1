param(
  [string]$Name = "D-aquila-Windows",
  [int]$Port = 8000
)

$ErrorActionPreference = "Stop"
$RepoRoot = Resolve-Path (Join-Path $PSScriptRoot "..")
$VenvPython = Join-Path $RepoRoot ".venv\Scripts\python.exe"
$Launcher = Join-Path $RepoRoot "windows_launcher.py"

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
  "--onedir",
  "--name", $Name,
  "--windowed",
  "--hidden-import", "backend.d_aquila",
  "--hidden-import", "psutil",
  "--hidden-import", "fastapi",
  "--hidden-import", "pydantic",
  "--hidden-import", "uvicorn",
  "--collect-all", "psutil"
)

foreach ($item in $addData) {
  $pyInstallerArgs += "--add-data"
  $pyInstallerArgs += $item
}

$pyInstallerArgs += $Launcher

Write-Host "[D-aquila Windows] Building dist\$Name\$Name.exe" -ForegroundColor Cyan
& $VenvPython @pyInstallerArgs

Write-Host ""
Write-Host "Windows executable build completed:" -ForegroundColor Green
Write-Host "  dist\$Name\$Name.exe" -ForegroundColor Yellow
