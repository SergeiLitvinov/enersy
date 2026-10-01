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
