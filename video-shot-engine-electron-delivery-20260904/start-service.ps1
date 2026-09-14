$ErrorActionPreference = "Stop"
$projectRoot = $PSScriptRoot
$statePath = Join-Path $projectRoot ".service.json"
$logDir = Join-Path $projectRoot "service-logs"
$port = if ($env:PORT) { $env:PORT } else { "3141" }
if (Test-Path -LiteralPath $statePath) {
  $old = Get-Content -LiteralPath $statePath -Raw | ConvertFrom-Json
  if (Get-Process -Id ([int]$old.pid) -ErrorAction SilentlyContinue) { Write-Host "Service already running (PID $($old.pid), port $($old.port))."; exit 0 }
  Remove-Item -LiteralPath $statePath -Force
}
New-Item -ItemType Directory -Path $logDir -Force | Out-Null
$env:PORT = $port
$proc = Start-Process -FilePath "node" -ArgumentList @("src/server.mjs") -WorkingDirectory $projectRoot -RedirectStandardOutput (Join-Path $logDir "service.out.log") -RedirectStandardError (Join-Path $logDir "service.err.log") -WindowStyle Hidden -PassThru
@{ pid=$proc.Id; port=[int]$port; startedAt=(Get-Date).ToString("o") } | ConvertTo-Json | Set-Content -LiteralPath $statePath -Encoding UTF8
Start-Sleep -Milliseconds 500
if ($proc.HasExited) { Remove-Item -LiteralPath $statePath -Force; throw "Service exited during startup." }
Write-Host "Started shot segmentation service: http://localhost:$port/ (PID $($proc.Id))"
