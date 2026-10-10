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
function Auth-Request($Session,[string]$Method,[string]$Path,$Body=$null,[string]$RequestOrigin=$origin,[string]$Match='',[string]$IdempotencyKey='') {
    $arguments = @{ Uri="$baseUri$Path"; Method=$Method; WebSession=$Session; TimeoutSec=30; SkipHttpErrorCheck=$true }
    if ($RequestOrigin) { $arguments.Headers=@{ Origin=$RequestOrigin } }
    if ($Match) {
        if (-not $arguments.ContainsKey('Headers')) { $arguments.Headers=@{} }
        $arguments.Headers['If-Match']=$Match
    }
    if ($IdempotencyKey) {
        if (-not $arguments.ContainsKey('Headers')) { $arguments.Headers=@{} }
        $arguments.Headers['Idempotency-Key']=$IdempotencyKey
    }
    if ($null -ne $Body) { $arguments.Body=ConvertTo-Json -InputObject $Body -Depth 16 -Compress; $arguments.ContentType='application/json' }
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
    $schemePath = "/api/projects/$($projects[0])/schemes"
    $schemeName = "Private scheme $suffix"
    $response = Auth-Request $first POST $schemePath @{name=$schemeName;description='Disposable private fixture'}
    if ([int]$response.StatusCode -ne 201) { throw 'Private scheme creation failed' }
    $scheme = $response.Content | ConvertFrom-Json
    $schemeId = 0L
    if (-not [long]::TryParse([string]$scheme.id,[ref]$schemeId) -or $schemeId -le 0) { throw 'Invalid private scheme ID' }
    $privateSchemePath = "$schemePath/$schemeId"
    $schemePage = (Auth-Request $second GET "$schemePath`?limit=1").Content | ConvertFrom-Json
    if (@($schemePage.items).Count -ne 1 -or $schemePage.items[0].id -ne [string]$schemeId -or $schemePage.items[0].name -ne $schemeName -or $schemePage.nextAfterId -ne [string]$schemeId) { throw 'Project scheme page incorrect' }
    $emptySchemePage = (Auth-Request $second GET "$schemePath`?limit=1&afterId=$schemeId").Content | ConvertFrom-Json
    if (@($emptySchemePage.items).Count -ne 0) { throw 'Project scheme cursor repeated a row' }
    if ([int](Auth-Request $other GET $privateSchemePath).StatusCode -ne 404) { throw 'Foreign user reads private scheme' }
    foreach ($method in @('GET','PUT','DELETE')) {
        $response = Auth-Request $first $method "/api/ees/schemes/$schemeId" @{name='Unauthorized';description=''}
        if ([int]$response.StatusCode -ne 404) { throw "Legacy scheme $method bypasses project rights" }
    }
    $legacySchemes = Auth-Request $first GET '/api/ees/schemes'
    if ([int]$legacySchemes.StatusCode -ne 200 -or $legacySchemes.Content.Contains($schemeName)) { throw 'Legacy list exposes private scheme' }
    if ([int](Auth-Request $first POST "/api/ees/calculate/$schemeId").StatusCode -ne 404) { throw 'Legacy calculation exposes private scheme' }
    $types = (Auth-Request $first GET '/api/ees/component-types').Content | ConvertFrom-Json
    $busType = @($types | Where-Object code -eq 'busbar')
    if ($busType.Count -ne 1) { throw 'Shared busbar type unavailable' }
    $componentsPath = "$privateSchemePath/components"
    $response = Auth-Request $first POST $componentsPath @{typeId=[string]$busType[0].id;name='Private bus';params=@{voltage_nom='220'}}
    if ([int]$response.StatusCode -ne 201) { throw 'Private equipment creation failed' }
    $component = $response.Content | ConvertFrom-Json
    $componentPath = "$componentsPath/$($component.id)"
    $componentTag = '"'+$component.revision+'"'
    $response = Auth-Request $second PATCH $componentPath @{pose=@{x=10};params=@{voltage_nom='230'}} $origin $componentTag
    if ([int]$response.StatusCode -ne 200) { throw 'Independent owner session cannot patch equipment' }
    $updatedComponent = $response.Content | ConvertFrom-Json
    if ([int](Auth-Request $first PATCH $componentPath @{pose=@{x=99}} $origin $componentTag).StatusCode -ne 412) { throw 'Stale equipment revision overwrote changes' }
    $componentTag = '"'+$updatedComponent.revision+'"'
    $response = Auth-Request $first PATCH "/api/ees/components/$($component.id)" @{pose=@{x=99}} $origin $componentTag
    if ([int]$response.StatusCode -ne 404) { throw 'Legacy component route bypasses project rights' }
    $response = Auth-Request $first POST $componentsPath @{typeId=[string]$busType[0].id;name='Second private bus'}
    if ([int]$response.StatusCode -ne 201) { throw 'Second private equipment creation failed' }
    $secondBus = $response.Content | ConvertFrom-Json
    $graph = (Auth-Request $second GET $privateSchemePath).Content | ConvertFrom-Json
    $topologyTag = '"'+$graph.topologyRevision+'"'
    $commandsPath = "$privateSchemePath/connection-commands"
    $connectionKey = [guid]::NewGuid().ToString()
    $connectionBody = @{from=[string]$component.id;to=[string]$secondBus.id;fromPort='RIGHT';toPort='left'}
    $response = Auth-Request $first POST $commandsPath $connectionBody $origin $topologyTag $connectionKey
    if ([int]$response.StatusCode -ne 201) { throw 'Private connection creation failed' }
    $connection = $response.Content | ConvertFrom-Json
    $connectionPath = "$privateSchemePath/connections/$($connection.id)"
    $response = Auth-Request $second POST $commandsPath $connectionBody $origin $topologyTag $connectionKey
    $replayedConnection = $response.Content | ConvertFrom-Json
    if ([int]$response.StatusCode -ne 200 -or $replayedConnection.id -ne $connection.id -or $response.Headers['Idempotency-Replayed'] -ne 'true') { throw 'Independent session duplicated connection command' }
    $rosterPath = "/api/projects/$($projects[0])/members"
    $memberPath = "$rosterPath/$($accounts[1])"
    $roster = (Auth-Request $second GET $rosterPath).Content | ConvertFrom-Json
    if ($roster.revision -ne '0' -or @($roster.items).Count -ne 0) { throw 'Initial project roster incorrect' }
    $response = Auth-Request $first PUT $memberPath @{role='viewer'} $origin '"0"'
    if ([int]$response.StatusCode -ne 200) { throw 'Owner cannot add viewer' }
    $shared = (Auth-Request $other GET '/api/projects').Content | ConvertFrom-Json
    if (@($shared.items).Count -ne 2 -or $shared.items[0].role -ne 'viewer') { throw 'Shared project not visible to member' }
    $snapshot = (Auth-Request $other GET $privateSchemePath).Content | ConvertFrom-Json
    if ($snapshot.id -ne [string]$schemeId -or $snapshot.projectId -ne [string]$projects[0] -or $snapshot.name -ne $schemeName) { throw 'Shared scheme snapshot incorrect' }
    if ([int](Auth-Request $other POST $schemePath @{name='Viewer cannot create'}).StatusCode -ne 404) { throw 'Viewer creates a scheme' }
    if ([int](Auth-Request $other PATCH $componentPath @{pose=@{x=88}} $origin $componentTag).StatusCode -ne 404) { throw 'Viewer changes equipment' }
    if ([int](Auth-Request $other POST $commandsPath $connectionBody $origin $topologyTag $connectionKey).StatusCode -ne 404) { throw 'Viewer replays connection command' }
    $response = Auth-Request $other PUT $memberPath @{role='admin'} $origin '"1"'
    if ([int]$response.StatusCode -ne 404) { throw 'Viewer escalated own role' }
    $response = Auth-Request $first PUT $memberPath @{role='admin'} $origin '"1"'
    if ([int]$response.StatusCode -ne 200) { throw 'Owner cannot change member role' }
    $roster = (Auth-Request $other GET $rosterPath).Content | ConvertFrom-Json
    if ($roster.revision -ne '2' -or $roster.items[0].role -ne 'admin') { throw 'Admin roster incorrect' }
    $response = Auth-Request $other POST "$componentPath/params" @{key='voltage_nom';value='240'} $origin $componentTag
    if ([int]$response.StatusCode -ne 200) { throw 'Admin cannot change equipment parameter' }
    $updatedComponent = $response.Content | ConvertFrom-Json
    $componentTag = '"'+$updatedComponent.revision+'"'
    if ([int](Auth-Request $other DELETE $connectionPath $null $origin $topologyTag).StatusCode -ne 412) { throw 'Stale topology deletes connection' }
    $connectionTag = '"'+$connection.topologyRevision+'"'
    if ([int](Auth-Request $other DELETE $connectionPath $null $origin $connectionTag).StatusCode -ne 200) { throw 'Admin cannot delete connection' }
    $response = Auth-Request $first POST $commandsPath $connectionBody $origin $topologyTag $connectionKey
    $deletedConnection = $response.Content | ConvertFrom-Json
    if ([int]$response.StatusCode -ne 200 -or -not $deletedConnection.deleted -or $deletedConnection.id -ne $connection.id) { throw 'Replay resurrected deleted connection' }
    $draftGraph = (Auth-Request $first GET $privateSchemePath).Content | ConvertFrom-Json
    $draftComponent = @($draftGraph.components | Where-Object id -eq $component.id)[0]
    $draftPayload = @{formatVersion=1;components=@(@{componentId=[string]$component.id;base=@{
        id=[string]$draftComponent.id;typeId=[string]$draftComponent.typeId;type=[string]$draftComponent.type;
        equipmentModelId=$draftComponent.equipmentModelId;revision=[string]$draftComponent.revision;
        name=$draftComponent.name;x=$draftComponent.x;y=$draftComponent.y;rotation=$draftComponent.rotation;params=$draftComponent.params
    };intents=@(@{kind='parameter';key='voltage_nom';value='250'});reason='Disposable pending edit'});graph=@(@{intent=@{
        kind='create-connection';commandId=$connectionKey;from=[string]$component.id;to=[string]$secondBus.id;
        fromPort='right';toPort='left';expectedTopologyRevision=[string]$draftGraph.topologyRevision
    };reason='Historical fixture command'})}
    $draftsPath = "$privateSchemePath/drafts"
    $draftWorkspace = [guid]::NewGuid().ToString()
    $draftPath = "$draftsPath/$draftWorkspace"
    $emptyJournal = @{formatVersion=1;components=@();graph=@()}
    $response = Auth-Request $first PUT $draftPath $draftPayload $origin '"0"'
    if ([int]$response.StatusCode -ne 200 -or $response.Headers['ETag'] -ne '"1"') { throw 'Private draft creation failed' }
    $response = Auth-Request $second GET $draftPath
    $storedDraft = $response.Content | ConvertFrom-Json
    if ([int]$response.StatusCode -ne 200 -or $storedDraft.revision -ne '1' -or $storedDraft.workspaceId -ne $draftWorkspace -or $storedDraft.payload.components[0].intents[0].value -ne '250' -or $storedDraft.payload.graph[0].intent.commandId -ne $connectionKey) { throw 'Independent session lost draft payload or command identity' }
    if ([int](Auth-Request $other GET $draftPath).StatusCode -ne 404) { throw 'Shared admin reads another account draft' }
    if ([int](Auth-Request $other DELETE $draftPath $null $origin '"1"').StatusCode -ne 404) { throw 'Shared admin deletes another account draft' }
    if ([int](Auth-Request $other PUT $draftPath $emptyJournal $origin '"0"').StatusCode -ne 200) { throw 'Draft namespaces collide between accounts' }
    $list = Auth-Request $second GET $draftsPath
    if ([int]$list.StatusCode -ne 200 -or $list.Content.Contains('"payload"')) { throw 'Draft list exposes bodies' }
    if ([int](Auth-Request $second PUT $draftPath $draftPayload $origin '"1"').StatusCode -ne 200) { throw 'Draft update failed' }
    if ([int](Auth-Request $first PUT $draftPath $emptyJournal $origin '"1"').StatusCode -ne 412) { throw 'Draft CAS lost private intentions' }
    $afterDraft = (Auth-Request $first GET $privateSchemePath).Content | ConvertFrom-Json
    if ($afterDraft.topologyRevision -ne $draftGraph.topologyRevision -or @($afterDraft.components | Where-Object id -eq $component.id)[0].params.voltage_nom -ne '240') { throw 'Saving a journal changed the physical scheme' }
    if ([int](Auth-Request $second DELETE $draftPath $null $origin '"2"').StatusCode -ne 200) { throw 'Draft deletion failed' }
    if ([int](Auth-Request $first GET $draftPath).StatusCode -ne 404 -or [int](Auth-Request $first PUT $draftPath $draftPayload $origin '"0"').StatusCode -ne 404) { throw 'Deleted workspace UUID was reused' }
    $response = Auth-Request $other DELETE $memberPath $null $origin '"2"'
    if ([int]$response.StatusCode -ne 200) { throw 'Admin cannot leave project' }
    if ([int](Auth-Request $other GET $rosterPath).StatusCode -ne 404) { throw 'Removed member reads roster' }
    if ([int](Auth-Request $other GET $privateSchemePath).StatusCode -ne 404) { throw 'Removed member reads scheme' }
    if ([int](Auth-Request $other GET $draftPath).StatusCode -ne 404) { throw 'Removed member reads retained private journal' }
    if ([int](Auth-Request $other POST $commandsPath $connectionBody $origin $topologyTag $connectionKey).StatusCode -ne 404) { throw 'Removed member reads connection acknowledgement' }
    if ([int](Auth-Request $other DELETE $componentPath $null $origin $componentTag).StatusCode -ne 404) { throw 'Removed member deletes equipment' }
    if ([int](Auth-Request $first DELETE $componentPath $null $origin $componentTag).StatusCode -ne 200) { throw 'Owner cannot delete equipment' }
    $private = (Auth-Request $other GET '/api/projects').Content | ConvertFrom-Json
    if (@($private.items).Count -ne 1 -or $private.items[0].id -ne [string]$projects[2]) { throw 'Removed member retains shared project' }
    $response = Auth-Request $first PUT $memberPath @{role='viewer'} $origin '"2"'
    if ([int]$response.StatusCode -ne 409) { throw 'Stale membership command overwrote roster' }
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
    [pscustomobject]@{Checks='passed';Users=2;IndependentSessions=3;PrivateProjects=3;Membership='viewer/admin/removal/conflict passed';Schemes='private/shared/legacy isolation passed';Equipment='creation/patch/parameter/conflict/deletion passed';Connections='creation/replay/topology/deletion/access passed';Drafts='private account/workspace/CAS/payload/tombstone/removal passed';Transport='Docker HTTP localhost; insecure cookie override only on disposable fixture'}
}
finally {
    if ($accounts.Count -gt 0) {
        # IDs are parsed positive Int64; generated logins contain only ASCII hex/hyphens.
        $ids = $accounts -join ','
        $names = ($logins | ForEach-Object { "'$_'" }) -join ','
        if ($projects.Count -gt 0) {
            $projectIds = $projects -join ','
            $schemeSql = "DELETE FROM circuit_schemes WHERE project_id IN ($projectIds) AND project_id IN (SELECT id FROM projects WHERE owner_account_id IN ($ids));"
            & docker compose -f $compose exec -T postgres psql -U acceptance -d revision_acceptance -v ON_ERROR_STOP=1 -c $schemeSql
            if ($LASTEXITCODE -ne 0) { throw 'Disposable private scheme cleanup failed' }
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
