#requires -Version 7.0
# Fixed disposable services only; this never targets the application database.
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$compose = Join-Path $PSScriptRoot 'revision-compose.yml'
$suffix = [guid]::NewGuid().ToString('N')
$logins = @("draft-a-$suffix", "draft-b-$suffix")
$password = [Convert]::ToBase64String([Security.Cryptography.RandomNumberGenerator]::GetBytes(32))
$accounts = [Collections.Generic.List[long]]::new()
try {
    foreach ($login in $logins) {
        $body = ConvertTo-Json -Compress @{displayName='Disposable draft client';login=$login;password=$password}
        $reply = $body | & docker compose -f $compose exec -T go-api ./server -provision-account
        if ($LASTEXITCODE -ne 0) { throw 'Draft client account provisioning failed' }
        $identity = ($reply -join "`n") | ConvertFrom-Json
        $id = 0L
        if (-not [long]::TryParse([string]$identity.accountId,[ref]$id) -or $id -le 0) { throw 'Invalid account acknowledgement' }
        $accounts.Add($id)
    }
    & docker compose -f $compose --profile draft-client run --rm --no-deps `
        -e "VITE_DRAFT_HTTP_LOGIN_A=$($logins[0])" -e "VITE_DRAFT_HTTP_LOGIN_B=$($logins[1])" `
        -e "VITE_DRAFT_HTTP_PASSWORD=$password" editor-draft-client-check
    if ($LASTEXITCODE -ne 0) { throw 'Real draft client acceptance failed' }
}
finally {
    if ($accounts.Count -gt 0) {
        # Positive Int64 IDs and generated ASCII logins scope all cleanup to this run.
        $ids = $accounts -join ','
        $names = ($logins | ForEach-Object { "'$_'" }) -join ','
        $owners = "SELECT account_id FROM auth_local_credentials WHERE account_id IN ($ids) AND login IN ($names)"
        foreach ($sql in @(
            "DELETE FROM circuit_schemes WHERE project_id IN (SELECT id FROM projects WHERE owner_account_id IN ($owners));",
            "DELETE FROM projects WHERE owner_account_id IN ($owners);",
            "DELETE FROM auth_accounts WHERE id IN ($owners);"
        )) {
            & docker compose -f $compose exec -T postgres psql -U acceptance -d revision_acceptance -v ON_ERROR_STOP=1 -c $sql
            if ($LASTEXITCODE -ne 0) { throw 'Disposable draft client cleanup failed' }
        }
    }
    $password = $null
}
