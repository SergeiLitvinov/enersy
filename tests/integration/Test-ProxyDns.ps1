#requires -Version 7.0
# Two disposable proxies on an internal network. No host ports or application DB.
$ErrorActionPreference = 'Stop'
$token = [guid]::NewGuid().ToString('N').Substring(0,12)
$network = "enersy-proxy-$token"
$names = @("$network-outer", "$network-inner", "$network-front1", "$network-api1", "$network-front2", "$network-api2")
$root = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
$folder = Join-Path $root ".cache/proxy-dns-$token"
function Invoke-DnsDocker([string[]]$Arguments) {
    $result = & docker @Arguments
    if ($LASTEXITCODE -ne 0) { throw "Docker operation failed: $($Arguments[0])" }
    return $result
}
function Wait-DnsReply([string]$Container, [string]$Uri, [string]$Expected) {
    for ($attempt=0; $attempt -lt 24; $attempt++) {
        try {
            $reply = & docker exec $Container wget -q -T 3 -O - $Uri 2>$null
            if ($LASTEXITCODE -eq 0 -and ($reply -join "`n") -eq $Expected) { return }
        } catch { }
        Start-Sleep -Milliseconds 500
    }
    throw "Proxy did not resolve replacement: $Uri"
}
try {
    $null = New-Item -ItemType Directory -Path $folder
    foreach ($version in @(1,2)) {
        $config = @'
server { listen 3000; location / { return 200 "front-VERSION|$request_uri"; } }
server { listen 8080; location / { return 200 "api-VERSION|$request_uri"; } }
'@.Replace('VERSION',"v$version")
        Set-Content -LiteralPath (Join-Path $folder "mock$version.conf") -Value $config -Encoding utf8NoBOM
    }
    $null = Invoke-DnsDocker @('network','create','--internal',$network)
    foreach ($entry in @(@($names[2],'react-frontend'),@($names[3],'go-api'))) {
        $null = Invoke-DnsDocker @('run','-d','--name',$entry[0],'--network',$network,'--network-alias',$entry[1],
            '--mount',"type=bind,source=$(Join-Path $folder 'mock1.conf'),target=/etc/nginx/conf.d/default.conf,readonly",'nginx:alpine@sha256:8b1e78743a03dbb2c95171cc58639fef29abc8816598e27fb910ed2e621e589a')
    }
    $null = Invoke-DnsDocker @('run','-d','--name',$names[0],'--network',$network,
        '--mount',"type=bind,source=$(Join-Path $root 'nginx.conf'),target=/etc/nginx/conf.d/default.conf,readonly",'nginx:alpine@sha256:8b1e78743a03dbb2c95171cc58639fef29abc8816598e27fb910ed2e621e589a')
    $null = Invoke-DnsDocker @('run','-d','--name',$names[1],'--network',$network,
        '--mount',"type=bind,source=$(Join-Path $root 'frontend/nginx-default.conf'),target=/etc/nginx/conf.d/default.conf,readonly",'nginx:alpine@sha256:8b1e78743a03dbb2c95171cc58639fef29abc8816598e27fb910ed2e621e589a')
    $null = Invoke-DnsDocker @('exec',$names[0],'nginx','-t')
    $null = Invoke-DnsDocker @('exec',$names[1],'nginx','-t')
    Wait-DnsReply $names[0] 'http://127.0.0.1/probe?check=1' 'front-v1|/probe?check=1'
    Wait-DnsReply $names[0] 'http://127.0.0.1/api/probe?check=1' 'api-v1|/api/probe?check=1'
    Wait-DnsReply $names[1] 'http://127.0.0.1:3000/api/probe?check=1' 'api-v1|/api/probe?check=1'
    $oldIp = (Invoke-DnsDocker @('inspect','--format','{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}',$names[2])) -join ''
    # Old containers still occupy their IPs, so replacements necessarily get others.
    foreach ($entry in @(@($names[4],'react-frontend'),@($names[5],'go-api'))) {
        $null = Invoke-DnsDocker @('run','-d','--name',$entry[0],'--network',$network,'--network-alias',$entry[1],
            '--mount',"type=bind,source=$(Join-Path $folder 'mock2.conf'),target=/etc/nginx/conf.d/default.conf,readonly",'nginx:alpine@sha256:8b1e78743a03dbb2c95171cc58639fef29abc8816598e27fb910ed2e621e589a')
    }
    $newIp = (Invoke-DnsDocker @('inspect','--format','{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}',$names[4])) -join ''
    if (-not $oldIp -or -not $newIp -or $oldIp -eq $newIp) { throw 'Replacement did not change the service IP' }
    $null = Invoke-DnsDocker @('rm','-f',$names[2],$names[3])
    # Neither proxy is restarted or reloaded after replacements.
    Wait-DnsReply $names[0] 'http://127.0.0.1/probe?check=2' 'front-v2|/probe?check=2'
    Wait-DnsReply $names[0] 'http://127.0.0.1/api/probe?check=2' 'api-v2|/api/probe?check=2'
    Wait-DnsReply $names[1] 'http://127.0.0.1:3000/api/probe?check=2' 'api-v2|/api/probe?check=2'
    Wait-DnsReply $names[0] 'http://127.0.0.1/health?check=2' 'api-v2|/health?check=2'
    Wait-DnsReply $names[0] 'http://127.0.0.1/julia/ready?check=2' 'api-v2|/julia/ready?check=2'
    [pscustomobject]@{Checks='passed';OldFrontendIP=$oldIp;NewFrontendIP=$newIp;ProxyReloaded=$false;PathsAndQueriesPreserved=$true}
} finally {
    foreach ($name in $names) {
        $containers = @(Invoke-DnsDocker @('ps','-aq','--filter',"name=^/$name$"))
        if ($containers.Count) { $null = Invoke-DnsDocker (@('rm','-f') + $containers) }
    }
    $networks = @(Invoke-DnsDocker @('network','ls','-q','--filter',"name=^$network$"))
    if ($networks.Count) { $null = Invoke-DnsDocker (@('network','rm') + $networks) }
    # Only generated files in this run's verified workspace directory may be removed.
    $resolved = [IO.Path]::GetFullPath($folder)
    if ($resolved -ne [IO.Path]::GetFullPath((Join-Path $root ".cache/proxy-dns-$token"))) { throw 'Unexpected cleanup directory' }
    foreach ($version in @(1,2)) { $file = Join-Path $resolved "mock$version.conf"; if (Test-Path -LiteralPath $file -PathType Leaf) { Remove-Item -LiteralPath $file } }
    if (Test-Path -LiteralPath $resolved -PathType Container) { Remove-Item -LiteralPath $resolved }
}
