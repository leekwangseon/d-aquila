param(
  [string]$Version = "0.1.0",
  [int]$Port = 8000,
  [switch]$SkipExeBuild
)

$ErrorActionPreference = "Stop"
$RepoRoot = Resolve-Path (Join-Path $PSScriptRoot "..")
$ExeDir = Join-Path $RepoRoot "dist\D-aquila-Windows"
$InnoScript = Join-Path $RepoRoot "installer\d-aquila-windows.iss"

function Find-InnoCompiler {
  $command = Get-Command iscc.exe -ErrorAction SilentlyContinue
  if ($command) {
    return $command.Source
  }

  $candidates = @(
    "${env:ProgramFiles(x86)}\Inno Setup 6\ISCC.exe",
    "${env:ProgramFiles}\Inno Setup 6\ISCC.exe",
    "${env:LOCALAPPDATA}\Programs\Inno Setup 6\ISCC.exe"
  )

  foreach ($candidate in $candidates) {
    if ($candidate -and (Test-Path $candidate)) {
      return $candidate
    }
  }

  return $null
}

if (-not $SkipExeBuild -or -not (Test-Path (Join-Path $ExeDir "D-aquila-Windows.exe"))) {
  Write-Host "[D-aquila Windows] Building application executable first." -ForegroundColor Cyan
  & (Join-Path $PSScriptRoot "package-windows.ps1") -Port $Port
}

$iscc = Find-InnoCompiler
if (-not $iscc) {
  Write-Host "Inno Setup 6 compiler was not found." -ForegroundColor Red
  Write-Host "Install it from https://jrsoftware.org/isdl.php and run this script again." -ForegroundColor Yellow
  exit 1
}

Write-Host "[D-aquila Windows] Building Setup.exe with Inno Setup." -ForegroundColor Cyan
& $iscc "/DMyAppVersion=$Version" "/DMySourceDir=$ExeDir" $InnoScript

Write-Host ""
Write-Host "Installer build completed:" -ForegroundColor Green
Write-Host "  dist\installer\D-aquila-Windows-Setup.exe" -ForegroundColor Yellow
