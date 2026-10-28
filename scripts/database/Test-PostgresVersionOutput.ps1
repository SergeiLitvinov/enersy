. (Join-Path $PSScriptRoot 'DockerTools.ps1')

function Assert-Version {
    param([string[]]$Output, [string]$Expected)
    $actual = ConvertFrom-PostgresVersionOutput -Output $Output
    if ($actual -ne [version]$Expected) { throw "Expected $Expected, got $actual." }
}
function Assert-Refused {
    param([AllowEmptyCollection()][AllowEmptyString()][string[]]$Output)
    $refused = $false
    try { $null = ConvertFrom-PostgresVersionOutput -Output $Output } catch { $refused = $true }
    if (-not $refused) { throw 'Accepted absent, malformed or ambiguous version output.' }
}

Assert-Version -Output @('postgres (PostgreSQL) 15.18 (Debian 15.18-1.pgdg120+1)') -Expected '15.18'
Assert-Version -Output @('postgres (PostgreSQL) 15.19') -Expected '15.19'
# Reproduce a cold runner: successful docker run includes a pull transcript
# before stdout. The old anchored expression over the joined output fails.
$coldPull = @(
    "Unable to find image 'postgres:15@sha256:test' locally",
    '15: Pulling from library/postgres',
    'Digest: sha256:test',
    'Status: Downloaded newer image for postgres:15',
    'postgres (PostgreSQL) 15.18 (Debian 15.18-1.pgdg120+1)'
)
if (($coldPull -join '') -match '^postgres \(PostgreSQL\) (\d+\.\d+)\b') { throw 'Fixture no longer reproduces the old failure.' }
Assert-Version -Output $coldPull -Expected '15.18'
Assert-Version -Output @("Diagnostic`r`npostgres (PostgreSQL) 15.19`r`n") -Expected '15.19'
Assert-Refused -Output @()
Assert-Refused -Output @('')
Assert-Refused -Output @('Status: Downloaded newer image for postgres:15')
Assert-Refused -Output @('postgres (PostgreSQL) 15.18', 'postgres (PostgreSQL) 15.19')
Assert-Refused -Output @('postgres (PostgreSQL) 15.19beta1')
Assert-Refused -Output @('postgres (PostgreSQL) 15.19.1')
Assert-Refused -Output @('WARNING: postgres (PostgreSQL) 15.19')
Write-Host 'PASS: warm and cold Docker version output; absent, malformed and ambiguous versions rejected.'
