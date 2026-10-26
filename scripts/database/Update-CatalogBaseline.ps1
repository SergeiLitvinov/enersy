param([string]$GoImage = 'golang:1.26.10-alpine@sha256:27f2d3b83cfc5803c8078f8e730af0f7c431bf067afaec8f60a36fb763187cba')
. (Join-Path $PSScriptRoot 'DockerTools.ps1')
$root = (Resolve-Path (Join-Path $PSScriptRoot '../..')).Path
$project = 'enersy-catalog-baseline-' + [Guid]::NewGuid().ToString('N')
$compose = Join-Path $root 'tests/integration/native-compose.yml'
try {
    $null = Invoke-DatabaseDocker -Arguments @('compose', '-p', $project, '-f', $compose, 'up', '-d', '--wait', 'postgres')
    # Only the baseline output directory is writable; runtime sources stay read-only.
    # The test always creates its own fresh schema from the complete migration chain.
    $argsList = @('run', '--rm', '--network', "${project}_default", '-v', "${root}:/workspace:ro", '-v', "${root}/database:/workspace/database",
        '-v', "${root}/.cache/go-mod:/go/pkg/mod", '-v', "${root}/.cache/go-build:/root/.cache/go-build", '-w', '/workspace/backend-go',
        '-e', 'GOTOOLCHAIN=local', '-e', 'GOMAXPROCS=2', '-e', 'UPDATE_CATALOG_BASELINE=1',
        '-e', 'TEST_DATABASE_URL=host=postgres port=5432 user=acceptance password=disposable_acceptance dbname=native_acceptance sslmode=disable',
        $GoImage, 'go', 'test', '-run', '^TestCatalogBaselinePostgres$', '-v', '-count=1', './...')
    $null = Invoke-DatabaseDocker -Arguments $argsList
    Write-Host 'Catalog baseline regenerated from a fresh migrated database. Review the JSON diff; this is a seed baseline, not physical validation.'
} finally {
    $null = Invoke-DatabaseDocker -Arguments @('compose', '-p', $project, '-f', $compose, 'down')
}
