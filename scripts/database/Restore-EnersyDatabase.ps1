param(
    [Parameter(Mandatory)][string]$Backup,
    [Parameter(Mandatory)][string]$Container,
    [Parameter(Mandatory)][string]$NewDatabase,
    [string]$User = 'app_user'
)
. (Join-Path $PSScriptRoot 'DockerTools.ps1')
Assert-DatabaseName $NewDatabase
$file = (Resolve-Path -LiteralPath $Backup).Path
$manifest = Get-Content -Raw -LiteralPath "$file.json" | ConvertFrom-Json
if ($manifest.format -ne 'postgres-custom' -or (Get-FileHash -Algorithm SHA256 -LiteralPath $file).Hash.ToLowerInvariant() -ne $manifest.sha256) {
    throw 'Backup format or SHA-256 mismatch. Nothing was restored.'
}
$remote = '/tmp/enersy-restore-' + [Guid]::NewGuid().ToString('N') + '.dump'
try {
    $null = Invoke-DatabaseDocker -Arguments @('cp', $file, "${Container}:$remote")
    $null = Invoke-DatabaseDocker -Arguments @('exec', $Container, 'pg_restore', '--list', $remote)
    # createdb refuses an existing database; no DROP/--clean is ever issued.
    $null = Invoke-DatabaseDocker -Arguments @('exec', $Container, 'createdb', '--username', $User, '--template=template0', $NewDatabase)
    $null = Invoke-DatabaseDocker -Arguments @('exec', $Container, 'pg_restore', '--username', $User, '--dbname', $NewDatabase, '--single-transaction', '--exit-on-error', '--no-owner', '--no-privileges', $remote)
    Write-Host "Backup restored into the new database '$NewDatabase'."
} finally {
    $null = Invoke-DatabaseDocker -Arguments @('exec', $Container, 'rm', '-f', $remote)
}
