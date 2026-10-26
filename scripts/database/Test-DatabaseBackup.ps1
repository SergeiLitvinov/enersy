param(
    [string]$Image = 'postgres:15.19@sha256:baa22e6286bf832cb147b8bb5aa9d8bc999846d69c21d11bf63f58fbeed1fa48',
    [string]$UpgradeImage
)
. (Join-Path $PSScriptRoot 'DockerTools.ps1')
$container = 'enersy-backup-test-' + [Guid]::NewGuid().ToString('N')
$root = (Resolve-Path (Join-Path $PSScriptRoot '../..')).Path
$work = Join-Path $root ('.cache/backup-test-' + [Guid]::NewGuid().ToString('N'))
$null = New-Item -ItemType Directory -Force -Path $work
$started = $false
$upgradeVolume = ''
$upgradeToken = [Guid]::NewGuid().ToString('N')
function Wait-BackupTestDatabase {
    for ($attempt = 0; $attempt -lt 40; $attempt++) {
        try {
            $null = Invoke-DatabaseDocker -Arguments @('exec', $container, 'pg_isready', '-h', '127.0.0.1', '-U', 'app_user', '-d', 'source_db')
            return
        } catch { }
        Start-Sleep -Seconds 1
    }
    throw 'Temporary PostgreSQL did not become ready.'
}
try {
    $storage = @('--tmpfs', '/var/lib/postgresql/data')
    if ($UpgradeImage) {
        $versions = foreach ($candidate in @($Image, $UpgradeImage)) {
            $versionText = (Invoke-DatabaseDocker -Arguments @('run', '--rm', '--network=none', '--entrypoint', 'postgres', $candidate, '--version')) -join ''
            if ($versionText -notmatch '^postgres \(PostgreSQL\) (\d+\.\d+)\b') { throw 'Unrecognized PostgreSQL version.' }
            [version]$Matches[1]
        }
        if ($versions[0].Major -ne $versions[1].Major -or $versions[1] -le $versions[0]) { throw 'UpgradeImage must be a higher minor version of the same PostgreSQL major.' }
        $upgradeVolume = "enersy-backup-upgrade-$upgradeToken"
        $null = Invoke-DatabaseDocker -Arguments @('volume', 'create', '--label', "enersy.acceptance=$upgradeToken", $upgradeVolume)
        $storage = @('--mount', "type=volume,source=$upgradeVolume,target=/var/lib/postgresql/data")
    }
    $runArguments = @('run', '-d', '--rm', '--name', $container, '--network=none') + $storage + @('--env', 'POSTGRES_HOST_AUTH_METHOD=trust', '--env', 'POSTGRES_USER=app_user', '--env', 'POSTGRES_DB=source_db')
    $null = Invoke-DatabaseDocker -Arguments ($runArguments + @($Image))
    $started = $true
    Wait-BackupTestDatabase
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
-- Storage fixture only: a captured empty source is not a physical result.
INSERT INTO auth_accounts(display_name) VALUES ('Study backup fixture');
INSERT INTO projects(owner_account_id,name) SELECT id,'Study backup fixture' FROM auth_accounts;
INSERT INTO circuit_schemes(project_id,name,description) SELECT id,'Study backup source','' FROM projects;
BEGIN;
INSERT INTO project_studies(project_id,scheme_id,current_revision,created_by)
SELECT p.id,s.id,1,p.owner_account_id FROM projects p JOIN circuit_schemes s ON s.project_id=p.id;
INSERT INTO project_study_versions(study_id,project_id,revision,author_account_id,command_id,command_sha256,topology_revision,scheme_name,document,input_body,provenance_body)
SELECT id,project_id,1,created_by,'11111111-1111-4111-8111-111111111111',repeat('a',64),0,'Study backup source',
'{"formatVersion":1,"name":"Резервный Study","modelGroup":"three-phase","method":"newton-raphson","computeBackend":"julia","maxTimeMs":20000,"base":{"s_base_mva":100,"v_base_kv":10},"solverOptions":{"tolerance":1e-8,"max_iterations":50},"operatingLimits":[]}'::jsonb,
convert_to('{"components":[],"connections":[],"modelGroup":"three-phase","method":"newton-raphson","computeBackend":"julia","executionOptions":{"max_time_ms":20000},"base":{"s_base_mva":100,"v_base_kv":10},"solverOptions":{"tolerance":1e-8,"max_iterations":50},"operatingLimits":[],"studyReference":{"formatVersion":1,"id":"1","revision":"1"}}','UTF8'),
convert_to('{"formatVersion":1,"components":[]}','UTF8') FROM project_studies;
COMMIT;
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
    $fingerprintScript = Join-Path $PSScriptRoot 'Get-DatabaseDataFingerprint.ps1'
    $sourceFingerprint = (& $fingerprintScript -Container $container -Database source_db -OutputFile (Join-Path $work 'source-fingerprint-before.json')) | ConvertFrom-Json
    $expectedFingerprint = $sourceFingerprint.records | ConvertTo-Json -Depth 8 -Compress
    $dump = & (Join-Path $PSScriptRoot 'Backup-EnersyDatabase.ps1') -Container $container -Database source_db -OutputDirectory $work
    if ($UpgradeImage) {
        # Stop cleanly before replacing the binary. The owned test volume stays;
        # no pg_upgrade, initdb or logical restore is used for source_db.
        $null = Invoke-DatabaseDocker -Arguments @('stop', '--time', '30', $container)
        $started = $false
        $null = Invoke-DatabaseDocker -Arguments ($runArguments + @($UpgradeImage))
        $started = $true
        Wait-BackupTestDatabase
        Write-Host "PostgreSQL $($versions[0]) -> $($versions[1]) started on the same disposable volume; validating data and restore."
    }
    & (Join-Path $PSScriptRoot 'Restore-EnersyDatabase.ps1') -Backup $dump -Container $container -NewDatabase restored_db
    foreach ($database in @('source_db', 'restored_db')) {
        $fingerprint = (& $fingerprintScript -Container $container -Database $database -OutputFile (Join-Path $work "$database-fingerprint-after.json")) | ConvertFrom-Json
        if (($fingerprint.records | ConvertTo-Json -Depth 8 -Compress) -cne $expectedFingerprint) { throw "Data or sequence state changed in $database." }
    }
    # A value change with unchanged row count must be detected. Use a separate
    # clone: reverting coordinates would not undo the object's revision trigger.
    $null = Invoke-DatabaseDocker -Arguments @('exec', $container, 'createdb', '-U', 'app_user', '--template=restored_db', 'fingerprint_drift')
    $null = Invoke-DatabaseDocker -Arguments @('exec', $container, 'psql', '-X', '-U', 'app_user', '-d', 'fingerprint_drift', '-v', 'ON_ERROR_STOP=1', '-c', 'UPDATE scheme_components SET pos_x=pos_x+1')
    $changedFingerprint = (& $fingerprintScript -Container $container -Database fingerprint_drift) | ConvertFrom-Json
    if (($changedFingerprint.records | ConvertTo-Json -Depth 8 -Compress) -ceq $expectedFingerprint) { throw 'Data fingerprint missed a changed coordinate.' }
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
        if ($next[0].ToString() -ne '3') { throw 'Sequence not preserved.' }
        $studySequence = Invoke-DatabaseDocker -Arguments @('exec', $container, 'psql', '-X', '-U', 'app_user', '-d', $database, '-At', '-v', 'ON_ERROR_STOP=1', '-c', "SELECT nextval(pg_get_serial_sequence('project_studies','id'))")
        if (($studySequence -join '').Trim() -ne '2') { throw 'Study sequence not preserved.' }
        $studyHash = Invoke-DatabaseDocker -Arguments @('exec', $container, 'psql', '-X', '-U', 'app_user', '-d', $database, '-At', '-v', 'ON_ERROR_STOP=1', '-c', "SELECT count(*) FROM project_study_versions WHERE input_sha256=encode(sha256(input_body),'hex') AND provenance_sha256=encode(sha256(provenance_body),'hex')")
        if (($studyHash -join '').Trim() -ne '1') { throw 'Study bytes/digests not preserved.' }
        $studyEditRefused = $false
        try { $null = Invoke-DatabaseDocker -Arguments @('exec', $container, 'psql', '-X', '-U', 'app_user', '-d', $database, '-v', 'ON_ERROR_STOP=1', '-c', "UPDATE project_study_versions SET input_body='{}'::bytea") } catch { $studyEditRefused = $true }
        if (-not $studyEditRefused) { throw 'Restored Study history is mutable.' }
    }
    # A damaged backup must be rejected before creating its target database.
    [IO.File]::AppendAllText($dump, 'damaged')
    $refused = $false
    try { & (Join-Path $PSScriptRoot 'Restore-EnersyDatabase.ps1') -Backup $dump -Container $container -NewDatabase corrupted_db } catch { $refused = $true }
    if (-not $refused) { throw 'Restore accepted a damaged dump.' }
    $created = Invoke-DatabaseDocker -Arguments @('exec', $container, 'psql', '-X', '-U', 'app_user', '-d', 'source_db', '-At', '-c', "SELECT count(*) FROM pg_database WHERE datname='corrupted_db'")
    if (($created -join '').Trim() -ne '0') { throw 'Damaged dump created a database.' }
    Write-Host "PASS: schema, catalog, Cyrillic, saved parameters, Study bytes/digests/immutability, sequences, existing target refusal and damaged dump refusal. Evidence: $work"
} finally {
    if ($started) { $null = Invoke-DatabaseDocker -Arguments @('stop', $container) }
    if ($upgradeVolume) {
        $owner = (Invoke-DatabaseDocker -Arguments @('volume', 'inspect', '--format', '{{index .Labels "enersy.acceptance"}}', $upgradeVolume)) -join ''
        if ($upgradeVolume -ne "enersy-backup-upgrade-$upgradeToken" -or $owner -cne $upgradeToken) { throw 'Refusing to remove an unowned upgrade volume.' }
        $null = Invoke-DatabaseDocker -Arguments @('volume', 'rm', $upgradeVolume)
    }
}
