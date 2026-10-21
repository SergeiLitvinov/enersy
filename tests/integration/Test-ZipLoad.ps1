#requires -Version 7.0
param([switch]$KeepFixture)
# Fixed disposable Compose API; never point this at the working database.
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$baseUri = 'http://localhost:8084'
$schemeId = $null
function Request-Zip([string]$Method, [string]$Path, $Body = $null, [string]$Match = '') {
    $arguments = @{Uri="$baseUri$Path";Method=$Method;TimeoutSec=60}
    if ($null -ne $Body) { $arguments.Body=ConvertTo-Json -InputObject $Body -Depth 8 -Compress; $arguments.ContentType='application/json' }
    if ($Match) { $arguments.Headers=@{'If-Match'=$Match} }
    (Invoke-WebRequest @arguments).Content | ConvertFrom-Json
}
function Assert-ZipClose($Actual, [double]$Expected, [string]$Label) {
    if ($null -eq $Actual -or -not [double]::IsFinite([double]$Actual) -or [math]::Abs([double]$Actual - $Expected) -gt 1e-6) { throw "$Label differs: $Actual / $Expected" }
}
try {
    $types = Request-Zip GET '/api/ees/component-types'
    $schemeId = (Request-Zip POST '/api/ees/schemes' @{name='ZIP приёмка';description='Disposable load profile UI fixture'}).id
    if ([string]$schemeId -notmatch '^[1-9][0-9]*$') { throw 'Invalid scheme acknowledgement' }
    $fixtures = @(
        @{code='generator';name='Источник';x=180;y=160;params=@{p='10';e='10';voltage_nom='10';r='0.1';x='0.5'}},
        @{code='transmission_line';name='Линия';x=350;y=300;params=@{length='1';r0='0.1';x0='0.5';voltage_nom='10'}},
        @{code='load';name='ZIP нагрузка';x=550;y=300;params=@{p='10';q='3';voltage_nom='10'}}
    )
    $ids = @()
    foreach ($fixture in $fixtures) {
        $type = @($types | Where-Object code -eq $fixture.code)
        if ($type.Count -ne 1) { throw 'Fixture equipment type missing' }
        $created = Request-Zip POST '/api/ees/components' @{schemeId=$schemeId;typeId=$type[0].id;name=$fixture.name;x=$fixture.x;y=$fixture.y;rotation=0;params=$fixture.params}
        if (-not $created.success -or [string]$created.id -notmatch '^[1-9][0-9]*$') { throw 'Invalid equipment acknowledgement' }
        $ids += $created.id
    }
    foreach ($edge in @(@(0,1,'bottom','left'),@(1,2,'right','top'))) {
        $created = Request-Zip POST '/api/ees/connections' @{schemeId=$schemeId;from=$ids[$edge[0]];to=$ids[$edge[1]];fromPort=$edge[2];toPort=$edge[3]}
        if (-not $created.success) { throw 'Connection not saved' }
    }
    $graph = Request-Zip GET "/api/ees/schemes/$schemeId"
    $load = @($graph.components | Where-Object id -eq $ids[2])[0]
    $tag = '"'+$load.revision+'"'
    $zip = @{p='10';q='3';voltage_nom='10';zip_enabled='true';zip_p_z='1';zip_p_i='0';zip_p_p='0';zip_q_z='1';zip_q_i='0';zip_q_p='0'}
    $saved = Request-Zip PATCH "/api/ees/components/$($ids[2])" @{params=$zip} $tag
    if (-not $saved.success) { throw 'Atomic ZIP patch not acknowledged' }
    $result = Request-Zip POST "/api/ees/calculate/$schemeId"
    if (-not $result.success -or $result.loads.Count -ne 1 -or $result.loads[0].profile -ne 'zip' -or $result.loads[0].component_id -ne $ids[2]) { throw 'ZIP result missing or belongs to different equipment' }
    # Independent linear circuit, three-phase MVA / line-to-line kV / Ohm per phase.
    $zload = [Numerics.Complex]::new(100,0) / [Numerics.Complex]::Conjugate([Numerics.Complex]::new(10,3))
    $voltage = 10 * $zload / ([Numerics.Complex]::new(0.2,1) + $zload)
    Assert-ZipClose $result.loads[0].voltage_kv $voltage.Magnitude 'Voltage kV'
    Assert-ZipClose $result.loads[0].p_mw ([math]::Pow($voltage.Magnitude / 10,2) * 10) 'Active demand MW'
    Assert-ZipClose $result.loads[0].q_mvar ([math]::Pow($voltage.Magnitude / 10,2) * 3) 'Reactive demand Mvar'
    Assert-ZipClose $result.loads[0].voltage_nom_kv 10 'Rated voltage kV'
    if ($result.solver.step_policy -ne 'armijo-infinity-positive-voltage-v1' -or
        $result.solver.line_search_trials -lt $result.iterations -or
        $result.solver.min_step_length -le 0 -or $result.solver.min_step_length -gt 1) { throw 'Invalid Newton step diagnostics' }
    # Source powers are referenced to different physical points. This direct
    # linear circuit is independent of the worker's p.u. branch-flow routine.
    if ($result.sources.Count -ne 1) { throw 'Source result missing' }
    $sourceZ = [Numerics.Complex]::new(0.1,0.5)
    $current = 10 / (2 * $sourceZ + $zload) # sqrt(3) times phase current, kA
    $conjugateCurrent = [Numerics.Complex]::Conjugate($current)
    $internalPower = 10 * $conjugateCurrent
    $terminalPower = (10 - $sourceZ * $current) * $conjugateCurrent
    $sourceLoss = $sourceZ * [math]::Pow($current.Magnitude,2)
    Assert-ZipClose $result.sources[0].p_mw $internalPower.Real 'Source EMF active power MW'
    Assert-ZipClose $result.sources[0].q_mvar $internalPower.Imaginary 'Source EMF reactive power Mvar'
    Assert-ZipClose $result.sources[0].terminal_p_mw $terminalPower.Real 'Source terminal active injection MW'
    Assert-ZipClose $result.sources[0].terminal_q_mvar $terminalPower.Imaginary 'Source terminal reactive injection Mvar'
    Assert-ZipClose $result.sources[0].losses_p_mw $sourceLoss.Real 'Source impedance active loss MW'
    Assert-ZipClose $result.sources[0].losses_q_mvar $sourceLoss.Imaginary 'Source impedance reactive balance Mvar'
    Assert-ZipClose $result.balance.residual_p_mw 0 'Active balance MW'
    Assert-ZipClose $result.balance.residual_q_mvar 0 'Reactive balance Mvar'
    $stale = Invoke-WebRequest -Uri "$baseUri/api/ees/components/$($ids[2])" -Method PATCH -ContentType application/json -Body '{"params":{"p":"99","q":"99"}}' -Headers @{'If-Match'=$tag} -SkipHttpErrorCheck
    if ([int]$stale.StatusCode -ne 412) { throw 'Stale profile write was not rejected' }
    $graph = Request-Zip GET "/api/ees/schemes/$schemeId"
    $load = @($graph.components | Where-Object id -eq $ids[2])[0]
    foreach ($key in $zip.Keys) { if ($load.params.$key -ne $zip[$key]) { throw "Partial or stale write changed $key" } }
    $pq = $zip.Clone(); $pq.zip_enabled='false'
    foreach ($key in @('zip_p_z','zip_p_i','zip_p_p','zip_q_z','zip_q_i','zip_q_p')) { $pq[$key]='' }
    $null = Request-Zip PATCH "/api/ees/components/$($ids[2])" @{params=$pq} ('"'+$load.revision+'"')
    $result = Request-Zip POST "/api/ees/calculate/$schemeId"
    if ($result.loads[0].profile -ne 'pq') { throw 'PQ restoration failed' }
    Assert-ZipClose $result.loads[0].p_mw 10 'PQ demand MW'
    Assert-ZipClose $result.loads[0].q_mvar 3 'PQ demand Mvar'
    [pscustomobject]@{Checks='passed';Scheme=$schemeId;Load=$ids[2];URL='http://localhost:4174/';Kept=[bool]$KeepFixture;PhysicalTolerance=1e-6}
} finally {
    if ($null -ne $schemeId -and -not $KeepFixture) { $null = Request-Zip DELETE "/api/ees/schemes/$schemeId" }
}
