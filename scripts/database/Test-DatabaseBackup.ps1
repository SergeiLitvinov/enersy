param([string]$Image = 'postgres:15')
. (Join-Path $PSScriptRoot 'DockerTools.ps1')
$container = 'enersy-backup-test-' + [Guid]::NewGuid().ToString('N')
$root = (Resolve-Path (Join-Path $PSScriptRoot '../..')).Path
$work = Join-Path $root ('.cache/backup-test-' + [Guid]::NewGuid().ToString('N'))
$null = New-Item -ItemType Directory -Force -Path $work
$started = $false
try {
    $null = Invoke-DatabaseDocker -Arguments @('run', '-d', '--rm', '--name', $container, '--network=none', '--tmpfs', '/var/lib/postgresql/data', '--env', 'POSTGRES_HOST_AUTH_METHOD=trust', '--env', 'POSTGRES_USER=app_user', '--env', 'POSTGRES_DB=source_db', $Image)
    $started = $true
    $ready = $false
    for ($attempt = 0; $attempt -lt 40; $attempt++) {
        try {
            $null = Invoke-DatabaseDocker -Arguments @('exec', $container, 'pg_isready', '-U', 'app_user', '-d', 'source_db')
            $ready = $true
            break
        } catch { }
        Start-Sleep -Seconds 1
    }
    if (-not $ready) { throw 'Temporary PostgreSQL did not become ready.' }
    $migrations = Get-ChildItem -LiteralPath (Join-Path $root 'database/migrations') -Filter '*.up.sql' | Sort-Object Name
    foreach ($migration in $migrations) {
        $null = Invoke-DatabaseDocker -Arguments @('cp', $migration.FullName, "${container}:/tmp/migration.sql")
        $null = Invoke-DatabaseDocker -Arguments @('exec', $container, 'psql', '-X', '-U', 'app_user', '-d', 'source_db', '-v', 'ON_ERROR_STOP=1', '-f', '/tmp/migration.sql')
    }
    $fixture = @'
INSERT INTO circuit_schemes(name) VALUES ('Backup fixture');
INSERT INTO scheme_components(scheme_id,component_type_id,custom_name,pos_x,pos_y,rotation)
SELECT s.id,t.id,'Источник резервного теста',12.5,-7.25,90 FROM circuit_schemes s CROSS JOIN component_types t WHERE t.code='generator';
INSERT INTO scheme_component_params(scheme_component_id,param_key,param_value) SELECT id,'p','12.345' FROM scheme_components;
CREATE TABLE schema_migrations(version BIGINT PRIMARY KEY, dirty BOOLEAN NOT NULL);
CREATE TABLE schema_migration_integrity(version BIGINT PRIMARY KEY, sha256 CHAR(64) NOT NULL, origin VARCHAR(16) NOT NULL CHECK(origin IN ('applied','legacy-baseline')), recorded_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP);
'@
    $latestVersion = [Int64]($migrations[-1].BaseName.Split('_')[0])
    $fixture += "`nINSERT INTO schema_migrations VALUES($latestVersion,false);`n"
    foreach ($migration in $migrations) {
        $version = [Int64]($migration.BaseName.Split('_')[0])
        $content = [IO.File]::ReadAllText($migration.FullName).Replace("`r`n", "`n")
        $algorithm = [Security.Cryptography.SHA256]::Create()
        try { $digest = [BitConverter]::ToString($algorithm.ComputeHash([Text.Encoding]::UTF8.GetBytes($content))).Replace('-', '').ToLowerInvariant() } finally { $algorithm.Dispose() }
        $fixture += "INSERT INTO schema_migration_integrity(version,sha256,origin) VALUES($version,'$digest','applied');`n"
    }
    $fixture | Set-Content -Encoding UTF8 -LiteralPath (Join-Path $work 'fixture.sql')
    $null = Invoke-DatabaseDocker -Arguments @('cp', (Join-Path $work 'fixture.sql'), "${container}:/tmp/fixture.sql")
    $null = Invoke-DatabaseDocker -Arguments @('exec', $container, 'psql', '-X', '-U', 'app_user', '-d', 'source_db', '-v', 'ON_ERROR_STOP=1', '-f', '/tmp/fixture.sql')
    $dump = & (Join-Path $PSScriptRoot 'Backup-EnersyDatabase.ps1') -Container $container -Database source_db -OutputDirectory $work
    & (Join-Path $PSScriptRoot 'Restore-EnersyDatabase.ps1') -Backup $dump -Container $container -NewDatabase restored_db
    # Restore refusing an existing target must leave the restored data intact.
    $refused = $false
    try { & (Join-Path $PSScriptRoot 'Restore-EnersyDatabase.ps1') -Backup $dump -Container $container -NewDatabase restored_db } catch { $refused = $true }
    if (-not $refused) { throw 'Restore unexpectedly accepted an existing database.' }
    foreach ($database in @('source_db','restored_db')) {
        $null = Invoke-DatabaseDocker -Arguments @('exec', $container, 'pg_dump', '-U', 'app_user', '-d', $database, '--no-owner', '--no-privileges', '--file', "/tmp/$database.sql")
        $null = Invoke-DatabaseDocker -Arguments @('cp', "${container}:/tmp/$database.sql", (Join-Path $work "$database.sql"))
    }
    # PostgreSQL adds random psql restriction keys in recent minor releases.
    $sourceText = Get-Content -LiteralPath (Join-Path $work 'source_db.sql') | Where-Object { $_ -notmatch '^\\(un)?restrict ' }
    $restoredText = Get-Content -LiteralPath (Join-Path $work 'restored_db.sql') | Where-Object { $_ -notmatch '^\\(un)?restrict ' }
    # PostgreSQL can deparse equivalent ANY-array casts differently after
    # restore. Compare this one constraint by its exact allowed values and
    # verify enforcement independently, while preserving every other line.
    foreach ($database in @('source_db','restored_db')) {
        foreach ($origin in @('applied','legacy-baseline')) {
            $null = Invoke-DatabaseDocker -Arguments @('exec', $container, 'psql', '-X', '-U', 'app_user', '-d', $database, '-v', 'ON_ERROR_STOP=1', '-c', "BEGIN; INSERT INTO schema_migration_integrity(version,sha256,origin) VALUES(-1,repeat('a',64),'$origin'); ROLLBACK;")
        }
        $invalidRefused = $false
        try { $null = Invoke-DatabaseDocker -Arguments @('exec', $container, 'psql', '-X', '-U', 'app_user', '-d', $database, '-v', 'ON_ERROR_STOP=1', '-c', "BEGIN; INSERT INTO schema_migration_integrity(version,sha256,origin) VALUES(-1,repeat('a',64),'invalid'); ROLLBACK;") } catch {
            if ($_.Exception.Message -notmatch 'schema_migration_integrity_origin_check') { throw }
            $invalidRefused = $true
        }
        if (-not $invalidRefused) { throw 'Restored integrity constraint did not reject an invalid origin.' }
    }
    $originConstraint = '^\s+CONSTRAINT schema_migration_integrity_origin_check CHECK '
    $sourceConstraint = @($sourceText | Where-Object { $_ -match $originConstraint })
    $restoredConstraint = @($restoredText | Where-Object { $_ -match $originConstraint })
    if ($sourceConstraint.Count -ne 1 -or $restoredConstraint.Count -ne 1) { throw 'Integrity constraint missing or duplicated.' }
    # Strip only PostgreSQL casts and parentheses from this named expression.
    $normalizeConstraint = { param($line) ($line -replace '::character varying|::text\[\]|::text|[()]', '') -replace '\s+', '' }
    if ((& $normalizeConstraint $sourceConstraint[0]) -cne (& $normalizeConstraint $restoredConstraint[0])) { throw 'Integrity constraint changed.' }
    $sourceText = $sourceText | Where-Object { $_ -notmatch $originConstraint }
    $restoredText = $restoredText | Where-Object { $_ -notmatch $originConstraint }
    if (($sourceText -join "`n") -cne ($restoredText -join "`n")) { throw "Restored SQL differs; evidence kept in $work" }
    foreach ($database in @('source_db','restored_db')) {
        $next = Invoke-DatabaseDocker -Arguments @('exec', $container, 'psql', '-X', '-U', 'app_user', '-d', $database, '-At', '-v', 'ON_ERROR_STOP=1', '-c', "INSERT INTO circuit_schemes(name) VALUES('Sequence test') RETURNING id")
        if ($next[0].ToString() -ne '2') { throw 'Sequence not preserved.' }
    }
    # A damaged backup must be rejected before creating its target database.
    [IO.File]::AppendAllText($dump, 'damaged')
    $refused = $false
    try { & (Join-Path $PSScriptRoot 'Restore-EnersyDatabase.ps1') -Backup $dump -Container $container -NewDatabase corrupted_db } catch { $refused = $true }
    if (-not $refused) { throw 'Restore accepted a damaged dump.' }
    $created = Invoke-DatabaseDocker -Arguments @('exec', $container, 'psql', '-X', '-U', 'app_user', '-d', 'source_db', '-At', '-c', "SELECT count(*) FROM pg_database WHERE datname='corrupted_db'")
    if (($created -join '').Trim() -ne '0') { throw 'Damaged dump created a database.' }
    Write-Host "PASS: schema, catalog, Cyrillic, saved parameters, sequences, existing target refusal and damaged dump refusal. Evidence: $work"
} finally {
    if ($started) { $null = Invoke-DatabaseDocker -Arguments @('stop', $container) }
}
