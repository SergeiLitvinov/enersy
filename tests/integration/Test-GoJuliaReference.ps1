#requires -Version 7.0
param([switch]$ProjectMode)
# Fixed disposable acceptance port. Never target the working application database.
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$baseUri = 'http://localhost:8084'
$schemeId = $null
$projectId = $null
$accountId = $null
$compose = Join-Path $PSScriptRoot 'revision-compose.yml'
$session = [Microsoft.PowerShell.Commands.WebRequestSession]::new()
$lastHeaders = $null
function Request-Reference([string]$Method, [string]$Path, $Body = $null, [string]$Match='', [string]$Key='') {
    $arguments = @{ Uri = "$baseUri$Path"; Method = $Method; TimeoutSec = 40 }
    if ($ProjectMode) { $arguments.WebSession=$session; $arguments.Headers=@{Origin='http://localhost:4174'} }
    if ($Match -or $Key) {
        if (-not $arguments.ContainsKey('Headers')) { $arguments.Headers=@{} }
        if ($Match) { $arguments.Headers['If-Match']=$Match }
        if ($Key) { $arguments.Headers['Idempotency-Key']=$Key }
    }
    if ($null -ne $Body) { $arguments.Body = ConvertTo-Json -InputObject $Body -Depth 10 -Compress; $arguments.ContentType = 'application/json' }
    $reply = Invoke-WebRequest @arguments
    $script:lastHeaders = $reply.Headers
    $reply.Content | ConvertFrom-Json
}
function Assert-Close($Actual, [double]$Expected, [double]$Tolerance, [string]$Label) {
    if ($null -eq $Actual -or -not [double]::IsFinite([double]$Actual) -or [math]::Abs([double]$Actual - $Expected) -gt $Tolerance) {
        throw "$Label differs: actual=$Actual expected=$Expected tolerance=$Tolerance"
    }
}
try {
    if ($ProjectMode) {
        $login = 'reference-' + [guid]::NewGuid().ToString('N')
        $password = [Convert]::ToBase64String([Security.Cryptography.RandomNumberGenerator]::GetBytes(32))
        $credentials = ConvertTo-Json -Compress @{displayName='Disposable numerical reference';login=$login;password=$password}
        $reply = $credentials | & docker compose -f $compose exec -T go-api ./server -provision-account
        if ($LASTEXITCODE -ne 0) { throw 'Reference account provisioning failed' }
        $identity = ($reply -join "`n") | ConvertFrom-Json
        $validatedAccount = 0L
        if (-not [long]::TryParse([string]$identity.accountId, [ref]$validatedAccount) -or $validatedAccount -le 0) { throw 'Invalid reference account ID' }
        $accountId = $validatedAccount
        $null = Request-Reference POST '/api/auth/login' @{login=$login;password=$password}
        $password = $null
        $projectId = (Request-Reference POST '/api/projects' @{name='Private physical reference'}).id
        if ([string]$projectId -notmatch '^[1-9][0-9]*$') { throw 'Invalid reference project ID' }
    }
    $reference = (Get-Content (Join-Path $PSScriptRoot '../../backend-julia/test/reference/ac-networks-v1.json') -Raw | ConvertFrom-Json).compiled_transformer
    $types = Request-Reference GET '/api/ees/component-types'
    $schemesPath = if ($ProjectMode) { "/api/projects/$projectId/schemes" } else { '/api/ees/schemes' }
    $scheme = Request-Reference POST $schemesPath @{ name='Go-Julia independent transformer reference'; description='Disposable 110/10 kV fixture' }
    $schemeId = $scheme.id
    if (-not $schemeId) { throw 'Scheme creation not acknowledged' }
    $fixtures = @(
        @{ code='generator'; params=@{voltage_nom='110'; e='113.3'; p='0'; r='0.1'; x='0.5'} },
        @{ code='busbar'; params=@{voltage_nom='110'} },
        @{ code='busbar'; params=@{voltage_nom='10'} },
        @{ code='transformer'; params=@{power_nom='100'; voltage_hv='110'; voltage_lv='10'; p_kz='1'; u_kz='10'; p_xx='0.1'; i_xx='1'} },
        @{ code='load'; params=@{voltage_nom='10'; p='10'; q='3'} }
    )
    $ids = @()
    foreach ($fixture in $fixtures) {
        $type = @($types | Where-Object code -eq $fixture.code)
        if ($type.Count -ne 1) { throw "Missing fixture type $($fixture.code)" }
        $body = @{typeId=$type[0].id; name=$fixture.code; x=0; y=0; rotation=0; params=$fixture.params}
        $componentsPath = '/api/ees/components'
        if ($ProjectMode) { $body.typeId=[string]$body.typeId; $componentsPath="$schemesPath/$schemeId/components" }
        else { $body.schemeId=$schemeId }
        $created = Request-Reference POST $componentsPath $body
        if (-not $created.success -or -not $created.id) { throw 'Equipment creation not acknowledged' }
        $ids += $created.id
    }
    foreach ($edge in @(@(0,1,'bottom','left'),@(1,3,'right','top'),@(3,2,'bottom','left'),@(2,4,'right','top'))) {
        $body = @{from=$ids[$edge[0]]; to=$ids[$edge[1]]; fromPort=$edge[2]; toPort=$edge[3]}
        if ($ProjectMode) {
            $body.from=[string]$body.from; $body.to=[string]$body.to
            $graph = Request-Reference GET "$schemesPath/$schemeId"
            $tag = '"'+$graph.topologyRevision+'"'
            $created = Request-Reference POST "$schemesPath/$schemeId/connection-commands" $body $tag ([guid]::NewGuid().ToString())
        } else {
            $body.schemeId=$schemeId
            $created = Request-Reference POST '/api/ees/connections' $body
        }
        if (-not $created.success -or -not $created.id) { throw 'Connection creation not acknowledged' }
    }
    if ($ProjectMode) {
        $graph = Request-Reference GET "$schemesPath/$schemeId"
        $tag = '"'+$graph.topologyRevision+'"'
        $path = "$schemesPath/$schemeId/calculate?modelGroup=three-phase&method=newton-raphson"
        $anonymous = Invoke-WebRequest -Uri "$baseUri$path" -Method POST -Headers @{Origin='http://localhost:4174';'If-Match'=$tag} -SkipHttpErrorCheck
        if ([int]$anonymous.StatusCode -ne 401 -or $anonymous.Headers.ContainsKey('X-Enersy-Input-SHA256')) { throw 'Anonymous reference request received private data' }
        $result = Request-Reference POST $path $null $tag
        if ([string]$lastHeaders['X-Enersy-Input-SHA256'] -notmatch '^[a-f0-9]{64}$' -or [string]$lastHeaders['X-Enersy-Topology-Revision'] -ne $graph.topologyRevision -or [string]$lastHeaders['X-Enersy-Project-Id'] -ne $projectId -or [string]$lastHeaders['X-Enersy-Scheme-Id'] -ne $schemeId -or [string]$lastHeaders['Cache-Control'] -ne 'no-store') { throw 'Private calculation provenance missing' }
        # The worker uses numerical IDs; compare equipment membership explicitly.
        $ids = @($ids | ForEach-Object { [long]$_ })
    } else { $result = Request-Reference POST "/api/ees/calculate/$schemeId" }
    if (-not $result.success) { throw 'Physical reference calculation failed' }
    # Map by equipment membership, not generated node order or database IDs.
    for ($i=0; $i -lt 3; $i++) {
        $internal = $i -eq 0
        $node = @($result.nodes | Where-Object { $_.members -contains $ids[$i] -and $_.is_internal_source_node -eq $internal })
        if ($node.Count -ne 1) { throw "Ambiguous reference node $i" }
        Assert-Close $node[0].voltage_pu $reference.expected.v_pu[$i] 1e-8 "Node $i voltage p.u."
        Assert-Close $node[0].angle_rad $reference.expected.theta_rad[$i] 1e-8 "Node $i angle rad"
        Assert-Close ($node[0].p_mw/100) $reference.expected.p_pu[$i] 1e-8 "Node $i P p.u."
        Assert-Close ($node[0].q_mvar/100) $reference.expected.q_pu[$i] 1e-8 "Node $i Q p.u."
    }
    for ($i=0; $i -lt 2; $i++) {
        $equipment = if ($i -eq 0) { $ids[0] } else { $ids[3] }
        $branch = @($result.branches | Where-Object component_id -eq $equipment)
        if ($branch.Count -ne 1) { throw "Ambiguous reference branch $i" }
        $expected = @($reference.expected.branch_mw_mvar[$i])
        if ($i -eq 1) {
            # PYPOWER puts magnetization on the HV bus; Enersy includes it in
            # transformer HV power. Compare the same physical boundary.
            $expected[0] += [math]::Pow($reference.expected.v_pu[1],2) * $reference.bus[1][4]
            $expected[1] -= [math]::Pow($reference.expected.v_pu[1],2) * $reference.bus[1][5]
        }
        $keys = @('p_from_mw','q_from_mvar','p_to_mw','q_to_mvar')
        for ($k=0; $k -lt 4; $k++) { Assert-Close $branch[0].($keys[$k]) $expected[$k] 1e-6 "Branch $i $($keys[$k]) MW/Mvar" }
    }
    [pscustomobject]@{ Checks='passed'; PrivateProject=[bool]$ProjectMode; Scheme=$schemeId; Components=5; Connections=4; NodeTolerancePU=1e-8; AngleToleranceRad=1e-8; BranchToleranceMWMvar=1e-6 }
} finally {
    if ($ProjectMode -and $null -ne $accountId) {
        # Numeric IDs come only from validated acknowledgements on this fixed fixture.
        # Delete schemes first: the project FK intentionally forbids orphaned schemes.
        $sql = "DELETE FROM circuit_schemes WHERE project_id IN (SELECT id FROM projects WHERE owner_account_id=$accountId); DELETE FROM projects WHERE owner_account_id=$accountId; DELETE FROM auth_accounts WHERE id=$accountId;"
        & docker compose -f $compose exec -T postgres psql -U acceptance -d revision_acceptance -v ON_ERROR_STOP=1 -c $sql
        if ($LASTEXITCODE -ne 0) { throw 'Private reference cleanup failed' }
    } elseif ($null -ne $schemeId) {
        $removed = Request-Reference DELETE "/api/ees/schemes/$schemeId"
        if (-not $removed.success) { throw 'Reference fixture cleanup not acknowledged' }
    }
}
