param(
    [ValidatePattern('^[a-zA-Z0-9][a-zA-Z0-9_.-]*$')][string]$Container = 'go-api',
    [string]$OutputFile,
    [switch]$Catalog
)
. (Join-Path $PSScriptRoot 'DockerTools.ps1')
# The operator CLI branches before initDB: no migration, enrollment or HTTP server.
$mode = if ($Catalog) { '-audit-catalog' } else { '-audit-database' }
$scope = if ($Catalog) { 'catalog-seed-comparison' } else { 'legacy-bootstrap-and-migration-inventory' }
$json = (Invoke-DatabaseDocker -Arguments @('exec', $Container, '/app/server', $mode)) -join [Environment]::NewLine
$report = $json | ConvertFrom-Json
if ($report.formatVersion -ne 1 -or $report.scope -ne $scope -or $report.readOnly -ne $true) {
    throw 'Database audit did not confirm the expected read-only report format.'
}
if ($OutputFile) {
    $parent = Split-Path -Parent $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($OutputFile)
    if (-not (Test-Path -LiteralPath $parent -PathType Container)) { throw 'Audit output directory must already exist.' }
    $json | Set-Content -Encoding UTF8 -LiteralPath $OutputFile
}
return $report
