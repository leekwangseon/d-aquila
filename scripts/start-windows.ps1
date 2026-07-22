param(
  [string]$HostAddress = "0.0.0.0",
  [int]$Port = 8000
)

$ErrorActionPreference = "Stop"
$RepoRoot = Resolve-Path (Join-Path $PSScriptRoot "..")
$VenvPython = Join-Path $RepoRoot ".venv\Scripts\python.exe"

if (-not (Test-Path $VenvPython)) {
  Write-Host "[D-aquila] Windows venv not found. Run scripts\install-windows.ps1 first." -ForegroundColor Yellow
  exit 1
}

$env:D_AQUILA_AUTH_MODE = if ($env:D_AQUILA_AUTH_MODE) { $env:D_AQUILA_AUTH_MODE } else { "disabled" }
$env:D_AQUILA_ENABLE_SUBMIT = "false"
$env:D_AQUILA_HOST_SLURM_FALLBACK = "false"
$env:D_AQUILA_PROMETHEUS_URL = if ($env:D_AQUILA_PROMETHEUS_URL) { $env:D_AQUILA_PROMETHEUS_URL } else { "http://127.0.0.1:9090" }
$env:D_AQUILA_DISK_PATH = if ($env:D_AQUILA_DISK_PATH) { $env:D_AQUILA_DISK_PATH } else { (Get-Location).Path.Substring(0, 3) }

Write-Host "[D-aquila] Starting Windows Edition on http://$HostAddress`:$Port" -ForegroundColor Cyan
Write-Host "[D-aquila] Open http://localhost:$Port in this server browser." -ForegroundColor Cyan
& $VenvPython -m uvicorn backend.d_aquila:app --host $HostAddress --port $Port
