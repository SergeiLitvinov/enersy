#requires -Version 7.0
param([switch]$UseCache)
$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $false
Set-StrictMode -Version Latest
$root = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '../..')).Path
$token = [guid]::NewGuid().ToString('N')
$project = 'enersy-release-' + $token
$reportDir = Join-Path $root ('.cache/release-check/' + [DateTime]::UtcNow.ToString('yyyyMMdd-HHmmss') + '-' + $token)
$null = New-Item -ItemType Directory -Path $reportDir -Force
$compose = @('compose', '-p', $project, '-f', (Join-Path $root 'tests/integration/release-compose.yml'))
$previousReportDir = [Environment]::GetEnvironmentVariable('ENERSY_RELEASE_REPORT_DIR', 'Process')
$env:ENERSY_RELEASE_REPORT_DIR = $reportDir
$script:step = 0
$receipt = [ordered]@{ formatVersion=1; scope='isolated-clean-release'; status='running'; startedAt=[DateTime]::UtcNow.ToString('o');
    project=$project; buildCache=[bool]$UseCache; platform=$null; images=@(); selectedInputChecksums=@{}; checks=@{}; cleanup='not_started' }

function Invoke-ReleaseDocker {
    param([string]$Label, [string[]]$Arguments, [switch]$Json)
    $script:step++
    $log = Join-Path $reportDir (('{0:D2}-' -f $script:step) + $Label + '.log')
    Write-Host "[$Label] $project"
    if ($Json) {
        & docker @Arguments 2> "$log.stderr" | Set-Content -LiteralPath $log -Encoding utf8
        if ($LASTEXITCODE -ne 0) { throw "$Label failed; see $log" }
        return Get-Content -LiteralPath $log -Raw -Encoding utf8 | ConvertFrom-Json
    }
    & docker @Arguments 2>&1 | Tee-Object -FilePath $log | ForEach-Object { Write-Host $_ }
    if ($LASTEXITCODE -ne 0) { throw "$Label failed; see $log" }
}

function Get-ReleaseProperty($Object, [string]$Name) {
    $property = $Object.PSObject.Properties[$Name]
    if ($null -ne $property) { return $property.Value }
    return $null
}

function Assert-ReleaseIsolation($Config) {
    if ($Config.name -ne $project -or @($Config.services.PSObject.Properties).Count -ne 7) { throw 'Unexpected release project or service set' }
    if (@($Config.networks.PSObject.Properties).Count -ne 1 -or -not $Config.networks.default.internal) { throw 'Release network must be internal and unique' }
    $allowedMounts = @{
        'nginx:/etc/nginx/conf.d/default.conf' = Join-Path $root 'nginx.conf'
        'release-check:/acceptance/check.mjs' = Join-Path $root 'tests/integration/release-check.mjs'
        'release-check:/acceptance/node-version' = Join-Path $root '.node-version'
        'release-check:/acceptance/LICENSE' = Join-Path $root 'LICENSE'
        'release-check:/acceptance/reference.json' = Join-Path $root 'backend-julia/test/reference/ac-networks-v1.json'
        'release-check:/reports' = $reportDir
    }
    foreach ($entry in $Config.services.PSObject.Properties) {
        $service = $entry.Value
        $ports = Get-ReleaseProperty $service 'ports'
        if (($null -ne $ports -and @($ports).Count -gt 0) -or (Get-ReleaseProperty $service 'container_name') -or (Get-ReleaseProperty $service 'network_mode')) { throw 'Release service must not publish ports or reuse container/network names' }
        if ((Get-ReleaseProperty $service 'build') -and (Get-ReleaseProperty $service 'image')) { throw 'Release builds must use project-local image tags' }
        $mounts = Get-ReleaseProperty $service 'volumes'
        foreach ($mount in $mounts) {
            $key = $entry.Name + ':' + $mount.target
            if ($mount.type -ne 'bind' -or -not $allowedMounts.ContainsKey($key)) { throw 'Unexpected release mount' }
            $comparison = if ($IsWindows) { [StringComparison]::OrdinalIgnoreCase } else { [StringComparison]::Ordinal }
            if (-not [IO.Path]::GetFullPath($mount.source).Equals([IO.Path]::GetFullPath($allowedMounts[$key]), $comparison)) { throw 'Release mount refers to another source' }
            if ($key -ne 'release-check:/reports' -and -not (Get-ReleaseProperty $mount 'read_only')) { throw 'Release inputs must be read-only' }
        }
    }
    if (@($Config.services.postgres.tmpfs) -notcontains '/var/lib/postgresql/data') { throw 'Release database must use tmpfs' }
}

# These identify selected inputs and immutable built images, not a complete
# source-tree attestation. No Git reset, stash, host SDK or application data is used.
$inputs = @('.node-version','LICENSE','docker-compose.yml','nginx.conf',
    'backend-go/Dockerfile','backend-go/go.mod','backend-go/go.sum',
    'backend-julia/Dockerfile','backend-julia/Project.toml','backend-julia/Manifest.toml',
    'frontend/Dockerfile','frontend/nginx-default.conf','frontend/package-lock.json',
    'docs/Dockerfile','pnpm-lock.yaml','tests/integration/release-compose.yml',
    'tests/integration/release-check.mjs','backend-julia/test/reference/ac-networks-v1.json',
    'scripts/build/Test-CleanRelease.ps1')
foreach ($path in $inputs) { $receipt.selectedInputChecksums[$path] = (Get-FileHash -LiteralPath (Join-Path $root $path) -Algorithm SHA256).Hash.ToLowerInvariant() }
$buildStarted = $false
$failure = $null
try {
    $platform = Invoke-ReleaseDocker -Label platform -Json -Arguments @('info','--format','{"os":"{{.OSType}}","architecture":"{{.Architecture}}","serverVersion":"{{.ServerVersion}}"}')
    $receipt.platform = $platform
    if ($platform.os -ne 'linux' -or $platform.architecture -notin @('amd64','x86_64')) {
        throw 'This acceptance profile currently verifies Linux amd64 containers only; another platform requires its own reviewed runtime/notice inputs.'
    }
    $config = Invoke-ReleaseDocker -Label config -Json -Arguments ($compose + @('--profile','check','config','--format','json'))
    Assert-ReleaseIsolation $config
    $receipt['isolation'] = @{ publishedPorts=0; applicationVolumes=0; internalNetwork=$true; postgresStorage='tmpfs' }
    $build = $compose + @('build','--pull')
    if (-not $UseCache) { $build += '--no-cache' }
    $buildStarted = $true
    Invoke-ReleaseDocker -Label build -Arguments ($build + @('go-api','julia-compute','react-frontend','docs'))
    # Finish all compilation before the cold numerical HTTP check. Runtime CPU
    # and memory budgets stay in Compose; never extend a solver timeout here.
    Invoke-ReleaseDocker -Label start -Arguments ($compose + @('up','-d','--wait','--wait-timeout','240','postgres','julia-compute','go-api','react-frontend','nginx','docs'))
    $receipt.images = @(Invoke-ReleaseDocker -Label images -Json -Arguments ($compose + @('images','--format','json')))
    $receipt.checks.database = Invoke-ReleaseDocker -Label database-audit -Json -Arguments ($compose + @('exec','-T','go-api','/app/server','-audit-database'))
    if ($receipt.checks.database.status -ne 'no_findings_in_audited_scope') { throw 'Fresh database migration audit has findings' }
    $receipt.checks.catalog = Invoke-ReleaseDocker -Label catalog-audit -Json -Arguments ($compose + @('exec','-T','go-api','/app/server','-audit-catalog'))
    if ($receipt.checks.catalog.status -ne 'matches_seed_baseline') { throw 'Fresh catalog does not match the shipped baseline' }
    Invoke-ReleaseDocker -Label http-physical -Arguments ($compose + @('--profile','check','run','--rm','--no-deps','release-check'))
    $physical = Get-Content -LiteralPath (Join-Path $reportDir 'http-physical.json') -Raw -Encoding utf8 | ConvertFrom-Json
    if ($physical.status -ne 'passed') { throw 'HTTP/physical acceptance did not pass' }
    $receipt.checks.physical = $physical
    $receipt.checks.emptyAccounts = Invoke-ReleaseDocker -Label accounts -Json -Arguments ($compose + @('exec','-T','postgres','psql','-X','-U','acceptance','-d','release_acceptance','-At','-c',"SELECT json_build_object('accounts',(SELECT count(*) FROM auth_accounts),'members',(SELECT count(*) FROM project_members),'schemes',(SELECT count(*) FROM circuit_schemes))"))
    if ($receipt.checks.emptyAccounts.accounts -ne 0 -or $receipt.checks.emptyAccounts.members -ne 0 -or $receipt.checks.emptyAccounts.schemes -ne 0) { throw 'Synthetic fixture cleanup or account isolation failed' }
    foreach ($path in $inputs) {
        if ((Get-FileHash -LiteralPath (Join-Path $root $path) -Algorithm SHA256).Hash.ToLowerInvariant() -ne $receipt.selectedInputChecksums[$path]) { throw "Selected build input changed during acceptance: $path" }
    }
    $receipt.status = 'passed'
} catch {
    $failure = $_
    $receipt.status = 'failed'
    $receipt['error'] = $_.Exception.Message
    if ($buildStarted) {
        try { Invoke-ReleaseDocker -Label failure-logs -Arguments ($compose + @('logs','--no-color','--tail','150')) } catch { Write-Warning 'Could not collect release container logs' }
    }
} finally {
    try {
        if ($buildStarted) { Invoke-ReleaseDocker -Label cleanup -Arguments ($compose + @('down','--remove-orphans','--rmi','local')) }
        $receipt.cleanup = 'completed'
    } catch {
        $receipt.cleanup = 'failed'
        $receipt.status = 'failed'
        if ($null -eq $failure) { $failure = $_ }
    }
    $receipt['finishedAt'] = [DateTime]::UtcNow.ToString('o')
    $receipt | ConvertTo-Json -Depth 30 | Set-Content -LiteralPath (Join-Path $reportDir 'release.json') -Encoding utf8
    [Environment]::SetEnvironmentVariable('ENERSY_RELEASE_REPORT_DIR', $previousReportDir, 'Process')
    Write-Host "Release report: $reportDir"
}
if ($null -ne $failure) { throw $failure }
