#requires -Version 7.0
# Fixed disposable Compose services and port; no production target override.
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$compose = Join-Path $PSScriptRoot 'revision-compose.yml'
$baseUri = 'http://localhost:8084'
$origin = 'http://localhost:4174'
$suffix = [guid]::NewGuid().ToString('N')
$logins = @("auth-a-$suffix", "auth-b-$suffix")
$password = [Convert]::ToBase64String([Security.Cryptography.RandomNumberGenerator]::GetBytes(32))
$accounts = [Collections.Generic.List[long]]::new()
$projects = [Collections.Generic.List[long]]::new()
function Auth-Request($Session,[string]$Method,[string]$Path,$Body=$null,[string]$RequestOrigin=$origin) {
    $arguments = @{ Uri="$baseUri$Path"; Method=$Method; WebSession=$Session; TimeoutSec=30; SkipHttpErrorCheck=$true }
    if ($RequestOrigin) { $arguments.Headers=@{ Origin=$RequestOrigin } }
    if ($null -ne $Body) { $arguments.Body=ConvertTo-Json -InputObject $Body -Compress; $arguments.ContentType='application/json' }
    Invoke-WebRequest @arguments
}
function Check-Session($Session,[int]$Expected) {
    $response = Auth-Request $Session GET '/api/auth/session'
    if ([int]$response.StatusCode -ne $Expected) { throw "Session status differs: expected $Expected, received $($response.StatusCode)" }
    if ($response.Headers['Cache-Control'] -ne 'no-store') { throw 'Session response can be cached' }
}
try {
    foreach ($login in $logins) {
        $body = ConvertTo-Json -Compress @{displayName='Disposable auth fixture';login=$login;password=$password}
        $reply = $body | & docker compose -f $compose exec -T go-api ./server -provision-account
        if ($LASTEXITCODE -ne 0) { throw 'Container provisioning failed' }
        $identity = ($reply -join "`n") | ConvertFrom-Json
        $id = 0L
        if (-not [long]::TryParse([string]$identity.accountId,[ref]$id) -or $id -le 0) { throw 'Invalid provisioning acknowledgement' }
        $accounts.Add($id)
    }
    $first = [Microsoft.PowerShell.Commands.WebRequestSession]::new()
    $second = [Microsoft.PowerShell.Commands.WebRequestSession]::new()
    $other = [Microsoft.PowerShell.Commands.WebRequestSession]::new()
    $identities = @()
    foreach ($pair in @(@($first,$logins[0]),@($second,$logins[0]),@($other,$logins[1]))) {
        $response = Auth-Request $pair[0] POST '/api/auth/login' @{login=$pair[1];password=$password}
        if ([int]$response.StatusCode -ne 200) { throw 'HTTP login failed' }
        $value = $response.Content | ConvertFrom-Json
        if ($response.Content.Contains($password)) { throw 'Password exposed in response' }
        $identities += $value
        Check-Session $pair[0] 200
    }
    if ($identities[0].accountId -ne $identities[1].accountId -or $identities[0].sessionId -eq $identities[1].sessionId -or $identities[0].accountId -eq $identities[2].accountId) { throw 'Users or independent sessions were merged' }
    foreach ($pair in @(@($first,'First private project'),@($first,'Second private project'),@($other,'Foreign private project'))) {
        $response = Auth-Request $pair[0] POST '/api/projects' @{name=$pair[1]}
        if ([int]$response.StatusCode -ne 201) { throw 'Authenticated project creation failed' }
        $value = $response.Content | ConvertFrom-Json
        $id = 0L
        if (-not [long]::TryParse([string]$value.id,[ref]$id) -or $id -le 0) { throw 'Invalid project acknowledgement' }
        $projects.Add($id)
    }
    $ownerPage = (Auth-Request $second GET '/api/projects?limit=1').Content | ConvertFrom-Json
    if (@($ownerPage.items).Count -ne 1 -or $ownerPage.items[0].id -ne [string]$projects[0] -or $ownerPage.items[0].role -ne 'owner') { throw 'Independent owner session project page incorrect' }
    $tailPage = (Auth-Request $second GET "/api/projects?limit=1&afterId=$($ownerPage.nextAfterId)").Content | ConvertFrom-Json
    if (@($tailPage.items).Count -ne 1 -or $tailPage.items[0].id -ne [string]$projects[1]) { throw 'Project cursor repeated or leaked a row' }
    $foreignPage = (Auth-Request $other GET '/api/projects').Content | ConvertFrom-Json
    if (@($foreignPage.items).Count -ne 1 -or $foreignPage.items[0].id -ne [string]$projects[2]) { throw 'Foreign projects leaked to another user' }
    $response = Auth-Request $first POST '/api/auth/logout' $null 'http://foreign.example'
    if ([int]$response.StatusCode -ne 403) { throw 'Foreign Origin accepted' }
    Check-Session $first 200
    $response = Auth-Request $first POST '/api/auth/logout'
    if ([int]$response.StatusCode -ne 204) { throw 'Logout failed' }
    Check-Session $first 401
    Check-Session $second 200
    Check-Session $other 200
    $response = Auth-Request $first POST '/api/auth/login' @{login=$logins[0];password=$password}
    if ([int]$response.StatusCode -ne 200) { throw 'Repeated login failed' }
    $response = Auth-Request $second POST '/api/auth/logout-all'
    if ([int]$response.StatusCode -ne 204) { throw 'Bulk logout failed' }
    Check-Session $first 401
    Check-Session $second 401
    Check-Session $other 200
    if ([int](Auth-Request $first GET '/api/projects').StatusCode -ne 401) { throw 'Revoked session reads private projects' }
    $response = Auth-Request $first POST '/api/auth/login' @{login=$logins[0];password='Incorrect test-only password'}
    if ([int]$response.StatusCode -ne 401) { throw 'Wrong password accepted' }
    [pscustomobject]@{Checks='passed';Users=2;IndependentSessions=3;PrivateProjects=3;Transport='Docker HTTP localhost; insecure cookie override only on disposable fixture'}
}
finally {
    if ($accounts.Count -gt 0) {
        # IDs are parsed positive Int64; generated logins contain only ASCII hex/hyphens.
        $ids = $accounts -join ','
        $names = ($logins | ForEach-Object { "'$_'" }) -join ','
        if ($projects.Count -gt 0) {
            $projectIds = $projects -join ','
            $projectSql = "DELETE FROM projects WHERE id IN ($projectIds) AND owner_account_id IN ($ids);"
            & docker compose -f $compose exec -T postgres psql -U acceptance -d revision_acceptance -v ON_ERROR_STOP=1 -c $projectSql
            if ($LASTEXITCODE -ne 0) { throw 'Disposable project cleanup failed' }
        }
        $sql = "DELETE FROM auth_accounts WHERE id IN ($ids) AND id IN (SELECT account_id FROM auth_local_credentials WHERE login IN ($names));"
        & docker compose -f $compose exec -T postgres psql -U acceptance -d revision_acceptance -v ON_ERROR_STOP=1 -c $sql
        if ($LASTEXITCODE -ne 0) { throw 'Disposable account cleanup failed' }
    }
    $password = $null
}
