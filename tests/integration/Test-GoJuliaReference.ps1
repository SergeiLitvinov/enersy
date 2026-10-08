#requires -Version 7.0
# Fixed disposable acceptance port. Never target the working application database.
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$baseUri = 'http://localhost:8084'
$schemeId = $null
function Request-Reference([string]$Method, [string]$Path, $Body = $null) {
    $arguments = @{ Uri = "$baseUri$Path"; Method = $Method; TimeoutSec = 40 }
    if ($null -ne $Body) { $arguments.Body = ConvertTo-Json -InputObject $Body -Depth 10 -Compress; $arguments.ContentType = 'application/json' }
    (Invoke-WebRequest @arguments).Content | ConvertFrom-Json
}
function Assert-Close($Actual, [double]$Expected, [double]$Tolerance, [string]$Label) {
    if ($null -eq $Actual -or -not [double]::IsFinite([double]$Actual) -or [math]::Abs([double]$Actual - $Expected) -gt $Tolerance) {
        throw "$Label differs: actual=$Actual expected=$Expected tolerance=$Tolerance"
    }
}
try {
    $reference = (Get-Content (Join-Path $PSScriptRoot '../../backend-julia/test/reference/ac-networks-v1.json') -Raw | ConvertFrom-Json).compiled_transformer
    $types = Request-Reference GET '/api/ees/component-types'
    $scheme = Request-Reference POST '/api/ees/schemes' @{ name='Go-Julia independent transformer reference'; description='Disposable 110/10 kV fixture' }
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
        $created = Request-Reference POST '/api/ees/components' @{ schemeId=$schemeId; typeId=$type[0].id; name=$fixture.code; x=0; y=0; rotation=0; params=$fixture.params }
        if (-not $created.success -or -not $created.id) { throw 'Equipment creation not acknowledged' }
        $ids += $created.id
    }
    foreach ($edge in @(@(0,1,'bottom','left'),@(1,3,'right','top'),@(3,2,'bottom','left'),@(2,4,'right','top'))) {
        $created = Request-Reference POST '/api/ees/connections' @{ schemeId=$schemeId; from=$ids[$edge[0]]; to=$ids[$edge[1]]; fromPort=$edge[2]; toPort=$edge[3] }
        if (-not $created.success -or -not $created.id) { throw 'Connection creation not acknowledged' }
    }
    $result = Request-Reference POST "/api/ees/calculate/$schemeId"
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
    [pscustomobject]@{ Checks='passed'; Scheme=$schemeId; Components=5; Connections=4; NodeTolerancePU=1e-8; AngleToleranceRad=1e-8; BranchToleranceMWMvar=1e-6 }
} finally {
    if ($null -ne $schemeId) {
        $removed = Request-Reference DELETE "/api/ees/schemes/$schemeId"
        if (-not $removed.success) { throw 'Reference fixture cleanup not acknowledged' }
    }
}
