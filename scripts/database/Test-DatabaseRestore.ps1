param(
    [Parameter(Mandatory)][string]$Backup,
    [string]$ExpectedFingerprint,
    [string]$Image = 'postgres:15.19@sha256:baa22e6286bf832cb147b8bb5aa9d8bc999846d69c21d11bf63f58fbeed1fa48',
    [string]$OutputFile
)
. (Join-Path $PSScriptRoot 'DockerTools.ps1')
$container = 'enersy-restore-check-' + [Guid]::NewGuid().ToString('N')
$started = $false
$expected = $null
if ($ExpectedFingerprint) {
    $expected = Get-Content -Raw -LiteralPath $ExpectedFingerprint | ConvertFrom-Json
    if ($expected.formatVersion -ne 1 -or $null -eq $expected.records) { throw 'Unsupported fingerprint format.' }
}
try {
    $null = Invoke-DatabaseDocker -Arguments @('run', '-d', '--rm', '--name', $container, '--network=none', '--tmpfs', '/var/lib/postgresql/data', '--env', 'POSTGRES_HOST_AUTH_METHOD=trust', '--env', 'POSTGRES_USER=app_user', '--env', 'POSTGRES_DB=restore_control', $Image)
    $started = $true
    $ready = $false
    for ($attempt = 0; $attempt -lt 40; $attempt++) {
        try {
            # The entrypoint's temporary init server has no TCP listener.
            $null = Invoke-DatabaseDocker -Arguments @('exec', $container, 'pg_isready', '-h', '127.0.0.1', '-U', 'app_user', '-d', 'restore_control')
            $ready = $true
            break
        } catch { }
        Start-Sleep -Seconds 1
    }
    if (-not $ready) { throw 'Restore-check PostgreSQL did not become ready.' }
    & (Join-Path $PSScriptRoot 'Restore-EnersyDatabase.ps1') -Backup $Backup -Container $container -NewDatabase restored_db
    $schema = if ($expected) { $expected.schema } else { 'public' }
    $actual = (& (Join-Path $PSScriptRoot 'Get-DatabaseDataFingerprint.ps1') -Container $container -Database restored_db -Schema $schema) | ConvertFrom-Json
    if ($expected -and ($actual.records | ConvertTo-Json -Depth 8 -Compress) -cne ($expected.records | ConvertTo-Json -Depth 8 -Compress)) { throw 'Restored table contents or sequence states differ from the expected fingerprint.' }
    $version = (Invoke-DatabaseDocker -Arguments @('exec', $container, 'postgres', '--version')) -join ''
    $manifest = Get-Content -Raw -LiteralPath "$Backup.json" | ConvertFrom-Json
    $report = [ordered]@{
        formatVersion = 1
        postgres = $version
        backupSha256 = $manifest.sha256
        schema = $schema
        relations = $actual.records.Count
        fingerprintCompared = [bool]$expected
        dataMatch = if ($expected) { $true } else { $null }
        rolesIncluded = $manifest.rolesIncluded
    } | ConvertTo-Json -Depth 4
    if ($OutputFile) { [IO.File]::WriteAllText([IO.Path]::GetFullPath($OutputFile), $report, [Text.UTF8Encoding]::new($false)) }
    return $report
} finally {
    if ($started) { $null = Invoke-DatabaseDocker -Arguments @('stop', $container) }
}
