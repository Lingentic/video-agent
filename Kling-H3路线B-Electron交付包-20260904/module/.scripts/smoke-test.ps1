$ErrorActionPreference = "Stop"

$baseUrl = "http://127.0.0.1:8794"
$before = Invoke-RestMethod -Uri "$baseUrl/api/config" -TimeoutSec 3

$notFoundStatus = 0
try {
  Invoke-WebRequest -Uri "$baseUrl/favicon.ico" -UseBasicParsing -TimeoutSec 3 | Out-Null
} catch {
  if ($_.Exception.Response) {
    $notFoundStatus = [int]$_.Exception.Response.StatusCode
  }
}

$after = Invoke-RestMethod -Uri "$baseUrl/api/config" -TimeoutSec 3
if ($notFoundStatus -ne 404) { throw "Expected favicon.ico to return 404, got $notFoundStatus." }
if (-not $before.configured -or -not $after.configured) { throw "Service configuration health check failed." }

[pscustomobject]@{
  MissingAssetStatus = $notFoundStatus
  ServiceSurvived = $true
  Configured = $after.configured
  Mock = $after.mock
}
