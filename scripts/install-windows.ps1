param(
  [int]$Port = 8000,
  [switch]$OpenFirewall,
  [switch]$CreateDesktopShortcut
)

$ErrorActionPreference = "Stop"
$RepoRoot = Resolve-Path (Join-Path $PSScriptRoot "..")
$VenvPath = Join-Path $RepoRoot ".venv"
$PythonExe = Join-Path $VenvPath "Scripts\python.exe"
$Requirements = Join-Path $RepoRoot "requirements-windows.txt"
$StartScript = Join-Path $RepoRoot "scripts\start-windows.ps1"

function Write-Step($Message) {
  Write-Host "[D-aquila Windows] $Message" -ForegroundColor Cyan
}

Write-Step "Preparing D-aquila Windows Edition."

$python = Get-Command python -ErrorAction SilentlyContinue
if (-not $python) {
  $python = Get-Command py -ErrorAction SilentlyContinue
}
if (-not $python) {
  Write-Host "Python 3.11+ is required. Install Python from https://www.python.org/downloads/windows/ and run this script again." -ForegroundColor Red
  exit 1
}

if (-not (Test-Path $PythonExe)) {
  Write-Step "Creating Python virtual environment."
  if ($python.Name -eq "py.exe") {
    & $python.Source -3 -m venv $VenvPath
  } else {
    & $python.Source -m venv $VenvPath
  }
}

Write-Step "Installing Windows runtime packages."
& $PythonExe -m pip install --upgrade pip
& $PythonExe -m pip install -r $Requirements

if ($OpenFirewall) {
  Write-Step "Opening Windows Firewall port $Port/tcp."
  New-NetFirewallRule -DisplayName "D-aquila Windows Edition $Port" -Direction Inbound -Protocol TCP -LocalPort $Port -Action Allow -ErrorAction SilentlyContinue | Out-Null
}

if ($CreateDesktopShortcut) {
  Write-Step "Creating desktop shortcut."
  $Desktop = [Environment]::GetFolderPath("Desktop")
  $ShortcutPath = Join-Path $Desktop "D-aquila Windows Edition.lnk"
  $Shell = New-Object -ComObject WScript.Shell
  $Shortcut = $Shell.CreateShortcut($ShortcutPath)
  $Shortcut.TargetPath = "powershell.exe"
  $Shortcut.Arguments = "-ExecutionPolicy Bypass -NoExit -File `"$StartScript`" -Port $Port"
  $Shortcut.WorkingDirectory = $RepoRoot
  $Shortcut.IconLocation = "powershell.exe,0"
  $Shortcut.Save()
}

Write-Host ""
Write-Host "D-aquila Windows Edition is ready." -ForegroundColor Green
Write-Host "Start command:" -ForegroundColor White
Write-Host "  powershell -ExecutionPolicy Bypass -File `"$StartScript`" -Port $Port" -ForegroundColor Yellow
Write-Host ""
Write-Host "Then open:" -ForegroundColor White
Write-Host "  http://localhost:$Port" -ForegroundColor Yellow
