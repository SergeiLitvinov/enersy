param(
    [string]$Container = 'hybrid-db',
    [string]$Database = 'app_db',
    [string]$User = 'app_user',
    [string]$OutputDirectory = (Join-Path $PSScriptRoot '../../.backups')
)
. (Join-Path $PSScriptRoot 'DockerTools.ps1')
Assert-DatabaseName $Database
$null = New-Item -ItemType Directory -Force -Path $OutputDirectory
$directory = (Resolve-Path -LiteralPath $OutputDirectory).Path
$identifier = [Guid]::NewGuid().ToString('N')
$file = Join-Path $directory ("enersy-{0}-{1}.dump" -f (Get-Date -Format 'yyyyMMdd-HHmmss'), $identifier)
$remote = "/tmp/enersy-$identifier.dump"
try {
    # Never redirect binary pg_dump stdout through Windows PowerShell.
    $null = Invoke-DatabaseDocker -Arguments @('exec', $Container, 'pg_dump', '--username', $User, '--dbname', $Database, '--format=custom', '--no-owner', '--no-privileges', '--file', $remote)
    $null = Invoke-DatabaseDocker -Arguments @('cp', "${Container}:$remote", $file)
    $hash = (Get-FileHash -Algorithm SHA256 -LiteralPath $file).Hash.ToLowerInvariant()
    $tool = Invoke-DatabaseDocker -Arguments @('exec', $Container, 'pg_dump', '--version')
    [ordered]@{ format = 'postgres-custom'; database = $Database; createdUtc = [DateTime]::UtcNow.ToString('o'); sha256 = $hash; pgDump = ($tool -join ' '); rolesIncluded = $false } |
        ConvertTo-Json | Set-Content -Encoding UTF8 -LiteralPath "$file.json"
    Write-Host 'Database snapshot saved. Store the dump and its manifest together.'
    return $file
} finally {
    $null = Invoke-DatabaseDocker -Arguments @('exec', $Container, 'rm', '-f', $remote)
}
