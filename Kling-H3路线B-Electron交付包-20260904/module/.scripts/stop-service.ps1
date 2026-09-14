$ErrorActionPreference = "Stop"

$project = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$serverPath = Join-Path $project "server.mjs"
$pidFile = Join-Path $project ".runtime\service.json"

if (-not (Test-Path -LiteralPath $pidFile)) {
  Write-Host "Service is not recorded as running."
  exit 0
}

$saved = Get-Content -LiteralPath $pidFile -Raw | ConvertFrom-Json
$servicePid = [int]$saved.nodePid
$process = Get-CimInstance Win32_Process -Filter "ProcessId=$servicePid"

if (-not $process) {
  Remove-Item -LiteralPath $pidFile -Force
  Write-Host "Service was already stopped."
  exit 0
}

$expectedServer = [Regex]::Escape($serverPath)
$workingDirectorySignature = [Regex]::Escape($project)
$belongsToProject = $process.Name -eq "node.exe" -and (
  $process.CommandLine -match $expectedServer -or
  ($saved.adopted -and $process.CommandLine -match "server\.mjs" -and $process.ExecutablePath -match "node\.exe$")
)

if (-not $belongsToProject) {
  throw "Recorded PID does not belong to this project; refusing to stop it."
}

Stop-Process -Id $servicePid -Force
Remove-Item -LiteralPath $pidFile -Force
Write-Host "Service stopped."
