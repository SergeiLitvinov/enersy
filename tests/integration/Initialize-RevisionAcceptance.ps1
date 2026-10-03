#requires -Version 7.0
# Creates disposable fixtures only on the dedicated acceptance API port.
$ErrorActionPreference = 'Stop'
$baseUri = 'http://localhost:8084'
function Request-Acceptance([string]$Method, [string]$Path, $Body = $null, [string]$Revision = '') {
    $arguments = @{ Uri = "$baseUri$Path"; Method = $Method; SkipHttpErrorCheck = $true }
    if ($null -ne $Body) { $arguments.Body = ConvertTo-Json -InputObject $Body -Depth 8 -Compress; $arguments.ContentType = 'application/json' }
    if ($Revision) { $arguments.Headers = @{ 'If-Match' = '"' + $Revision + '"' } }
    $response = Invoke-WebRequest @arguments
    [pscustomobject]@{ Status = [int]$response.StatusCode; Data = $response.Content | ConvertFrom-Json }
}
function Assert-Acceptance($Condition, [string]$Message) { if (-not $Condition) { throw $Message } }
$ready = Request-Acceptance GET '/ready'
Assert-Acceptance ($ready.Status -eq 200 -and $ready.Data.status -eq 'ready') 'Acceptance API is not ready'
$types = Request-Acceptance GET '/api/ees/component-types'
$busbar = @($types.Data | Where-Object code -eq 'busbar')[0]
Assert-Acceptance ($null -ne $busbar) 'Busbar type missing'
$protocol = Request-Acceptance POST '/api/ees/schemes' @{ name = 'Revision HTTP acceptance'; description = 'Disposable contract fixture' }
$created = Request-Acceptance POST '/api/ees/components' @{ schemeId = $protocol.Data.id; typeId = $busbar.id; name = 'Contract fixture'; x = 0; y = 0; rotation = 0; params = @{ voltage_nom = '110' } }
Assert-Acceptance ($created.Status -eq 200 -and $created.Data.revision -is [string] -and $created.Data.revision -match '^[1-9][0-9]*$') 'Creation must return exact string revision'
$id = $created.Data.id
$revision = $created.Data.revision
$missing = Request-Acceptance PATCH "/api/ees/components/$id" @{ pose = @{ x = 20 } }
Assert-Acceptance ($missing.Status -eq 428) 'Missing If-Match must return 428'
$first = Request-Acceptance PATCH "/api/ees/components/$id" @{ pose = @{ x = 20 }; params = @{ voltage_nom = '220' } } $revision
Assert-Acceptance ($first.Status -eq 200 -and $first.Data.revision -ne $revision) 'Atomic PATCH failed'
$stale = Request-Acceptance PATCH "/api/ees/components/$id" @{ pose = @{ x = 999 }; params = @{ voltage_nom = '999' } } $revision
Assert-Acceptance ($stale.Status -eq 412) 'Stale PATCH must return 412'
$snapshot = Request-Acceptance GET "/api/ees/schemes/$($protocol.Data.id)"
$stored = $snapshot.Data.components[0]
Assert-Acceptance ($stored.x -eq 20 -and $stored.y -eq 0 -and $stored.params.voltage_nom -eq '220' -and $stored.revision -eq $first.Data.revision) 'Conflict changed committed fields'
$noop = Request-Acceptance PATCH "/api/ees/components/$id" @{ params = @{ voltage_nom = '220' } } $stored.revision
Assert-Acceptance ($noop.Status -eq 200 -and $noop.Data.revision -eq $stored.revision) 'No-op parameter changed revision'
$staleDelete = Request-Acceptance DELETE "/api/ees/components/$id" $null $revision
Assert-Acceptance ($staleDelete.Status -eq 412) 'Stale DELETE must return 412'
$deleted = Request-Acceptance DELETE "/api/ees/components/$id" $null $stored.revision
Assert-Acceptance ($deleted.Status -eq 200 -and $deleted.Data.revision -eq $stored.revision) 'Conditional DELETE failed'
$snapshot = Request-Acceptance GET "/api/ees/schemes/$($protocol.Data.id)"
Assert-Acceptance (@($snapshot.Data.components).Count -eq 0) 'Deleted component still present'
$browser = Request-Acceptance POST '/api/ees/schemes' @{ name = 'Два клиента — проверка конфликтов'; description = 'Disposable browser acceptance fixture' }
$shared = Request-Acceptance POST '/api/ees/components' @{ schemeId = $browser.Data.id; typeId = $busbar.id; name = 'Общая шина'; x = 400; y = 300; rotation = 0; params = @{ voltage_nom = '110'; current_nom = '2000' } }
Assert-Acceptance ($shared.Status -eq 200) 'Browser fixture creation failed'
[pscustomobject]@{ SchemeId = $browser.Data.id; ComponentId = $shared.Data.id; Revision = $shared.Data.revision; Frontend = 'http://localhost:4174/'; ContractChecks = 'passed' }
