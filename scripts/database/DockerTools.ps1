Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Invoke-DatabaseDocker {
    param([Parameter(Mandatory)][string[]]$Arguments)
    $previousPreference = $ErrorActionPreference
    try {
        # Windows PowerShell 5 treats NOTICE on native stderr as an error.
        # Native command success is determined by its exit code instead.
        $ErrorActionPreference = 'Continue'
        $output = & docker @Arguments 2>&1
        $exitCode = $LASTEXITCODE
    } finally { $ErrorActionPreference = $previousPreference }
    if ($exitCode -ne 0) {
        throw "Docker database operation failed: $($output -join [Environment]::NewLine)"
    }
    return $output
}

function Assert-DatabaseName {
    param([string]$Name)
    if ($Name -notmatch '^[a-z][a-z0-9_]{0,62}$') {
        throw 'Database name must contain lowercase letters, digits and underscores, starting with a letter (max 63 characters).'
    }
}

function ConvertFrom-PostgresVersionOutput {
    param([AllowEmptyCollection()][AllowEmptyString()][string[]]$Output = @())
    # A first docker run can include image-pull diagnostics on stderr. The
    # wrapper preserves both streams; require exactly one complete binary
    # version line instead of treating the combined output as that line.
    $text = $Output -join "`n"
    $versions = [regex]::Matches($text, '(?m)^postgres \(PostgreSQL\) ([0-9]+\.[0-9]+)(?: [^\r\n]*)?\r?$')
    if ($versions.Count -ne 1) { throw 'Unrecognized or ambiguous PostgreSQL version.' }
    return [version]$versions[0].Groups[1].Value
}
