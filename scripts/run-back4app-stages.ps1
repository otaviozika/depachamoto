param(
  [string]$TargetUrl = "https://despachefullback4apptest-3e0baw0h.b4a.run"
)

$ErrorActionPreference = "Stop"
$projectDirectory = Split-Path -Parent $PSScriptRoot
$reportDirectory = Join-Path $projectDirectory "reports"
New-Item -ItemType Directory -Path $reportDirectory -Force | Out-Null

$username = Read-Host "Usuario administrativo da homologacao"
$securePassword = Read-Host "Senha administrativa da homologacao" -AsSecureString
$passwordPointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($securePassword)

try {
  $env:TARGET_URL = $TargetUrl
  $env:LOAD_TEST_CONFIRM = "BACK4APP_READ_ONLY"
  $env:LOADTEST_USERNAME = $username
  $env:LOADTEST_PASSWORD = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($passwordPointer)
  $env:HTTP_INTERVAL_MS = "5000"
  $env:METRIC_INTERVAL_MS = "5000"

  $stages = @(
    @{ Name = "idle-60m"; Clients = 0; Seconds = 3600; Reconnect = 0; Burst = 0 },
    @{ Name = "motoboys-10-30m"; Clients = 10; Seconds = 1800; Reconnect = 300; Burst = 0 },
    @{ Name = "motoboys-20-30m"; Clients = 20; Seconds = 1800; Reconnect = 300; Burst = 0 },
    @{ Name = "motoboys-40-60m"; Clients = 40; Seconds = 3600; Reconnect = 300; Burst = 0 },
    @{ Name = "read-only-burst"; Clients = 40; Seconds = 600; Reconnect = 120; Burst = 250 },
    @{ Name = "motoboys-60-30m"; Clients = 60; Seconds = 1800; Reconnect = 180; Burst = 0 },
    @{ Name = "websocket-prolongado-60m"; Clients = 40; Seconds = 3600; Reconnect = 0; Burst = 0 },
    @{ Name = "soak-memoria-120m"; Clients = 20; Seconds = 7200; Reconnect = 600; Burst = 0 }
  )

  Set-Location $projectDirectory
  foreach ($stage in $stages) {
    $env:STAGE = $stage.Name
    $env:CLIENTS = [string]$stage.Clients
    $env:DURATION_SECONDS = [string]$stage.Seconds
    $env:RECONNECT_EVERY_SECONDS = [string]$stage.Reconnect
    $env:READ_ONLY_BURST = [string]$stage.Burst
    $env:REPORT_PATH = Join-Path $reportDirectory ("back4app-{0}.json" -f $stage.Name)

    Write-Host "Iniciando $($stage.Name)..."
    node scripts/back4app-homologation.js
    if ($LASTEXITCODE -ne 0) {
      throw "A etapa $($stage.Name) falhou antes de gerar o relatorio."
    }
  }
} finally {
  $env:LOADTEST_USERNAME = $null
  $env:LOADTEST_PASSWORD = $null
  [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($passwordPointer)
}

