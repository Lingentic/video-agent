$ErrorActionPreference = "Stop"

$project = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$serverPath = Join-Path $project "server.mjs"
$runtime = Join-Path $project ".runtime"
$pidFile = Join-Path $runtime "service.json"
$logFile = Join-Path $runtime "service.log"
$errorLog = Join-Path $runtime "service-error.log"
$healthUrl = "http://127.0.0.1:8794/api/config"
$envFile = Join-Path $project ".env"

New-Item -ItemType Directory -Force -Path $runtime | Out-Null
$nodePath = (Get-Command node -ErrorAction Stop).Source
$expectedVideoModel = "MiniMax-H3-open"
if (Test-Path -LiteralPath $envFile) {
  $modelLine = Get-Content -LiteralPath $envFile | Where-Object { $_ -match '^XINHANKR_H3_MODEL=' } | Select-Object -First 1
  if ($modelLine) { $expectedVideoModel = $modelLine.Substring($modelLine.IndexOf('=') + 1).Trim() }
}

function Get-HealthyService {
  try {
    $config = Invoke-RestMethod -Uri $healthUrl -TimeoutSec 1
    $listener = Get-NetTCPConnection -LocalPort 8794 -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($listener -and $config.imageModel -eq "kling-image-o1" -and $config.videoModel -eq $expectedVideoModel) {
      return @{ Pid = [int]$listener.OwningProcess; Config = $config }
    }
  } catch {}
  return $null
}

$existing = Get-HealthyService
if ($existing) {
  @{ nodePid = $existing.Pid; adopted = $true; startedAt = (Get-Date).ToString("o") } |
    ConvertTo-Json | Set-Content -LiteralPath $pidFile -Encoding UTF8
  Write-Host "Service already running at http://127.0.0.1:8794/"
  exit 0
}

if (Test-Path -LiteralPath $pidFile) {
  Remove-Item -LiteralPath $pidFile -Force
}

$process = Start-Process -FilePath $nodePath -ArgumentList ('"{0}"' -f $serverPath) `
  -WorkingDirectory $project -WindowStyle Hidden `
  -RedirectStandardOutput $logFile -RedirectStandardError $errorLog -PassThru

@{ nodePid = $process.Id; adopted = $false; startedAt = (Get-Date).ToString("o") } |
  ConvertTo-Json | Set-Content -LiteralPath $pidFile -Encoding UTF8

for ($attempt = 0; $attempt -lt 30; $attempt += 1) {
  Start-Sleep -Milliseconds 300
  if ($process.HasExited) { break }
  $ready = Get-HealthyService
  if ($ready -and $ready.Pid -eq $process.Id) {
    Write-Host "Service started at http://127.0.0.1:8794/ (PID $($process.Id))"
    exit 0
  }
}

throw "Service did not start. Check .runtime/service-error.log."
