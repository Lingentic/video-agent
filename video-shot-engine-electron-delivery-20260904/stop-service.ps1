$statePath = Join-Path $PSScriptRoot ".service.json"
if (-not (Test-Path -LiteralPath $statePath)) { Write-Host "No service state found."; exit 0 }
$state = Get-Content -LiteralPath $statePath -Raw | ConvertFrom-Json
if (Get-Process -Id ([int]$state.pid) -ErrorAction SilentlyContinue) { Stop-Process -Id ([int]$state.pid) -Force }
Remove-Item -LiteralPath $statePath -Force
Write-Host "Stopped shot segmentation service."
