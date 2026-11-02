#requires -Version 7.0
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
. (Join-Path $PSScriptRoot 'ReleasePlatform.ps1')
$script:checks = 0
function Assert-Refused([scriptblock]$Check) {
    $refused = $false
    try { & $Check } catch { $refused = $true }
    if (-not $refused) { throw 'Release accepted an unsupported or mixed architecture receipt.' }
    $script:checks++
}
foreach ($target in @('amd64','arm64')) {
    $aliases = if ($target -eq 'amd64') { @('amd64','x86_64') } else { @('arm64','aarch64') }
    foreach ($alias in $aliases) {
        Assert-ReleaseArchitecture -OS linux -Architecture $alias -ExpectedArchitecture $target
        $script:checks++
    }
    foreach ($foreign in @('s390x','ppc64le','unknown','')) {
        Assert-Refused { Assert-ReleaseArchitecture -OS linux -Architecture $foreign -ExpectedArchitecture $target }
    }
    Assert-Refused { Assert-ReleaseArchitecture -OS windows -Architecture $target -ExpectedArchitecture $target }
    $other = if ($target -eq 'amd64') { 'arm64' } else { 'amd64' }
    Assert-Refused { Assert-ReleaseArchitecture -OS linux -Architecture $other -ExpectedArchitecture $target }
    $images = @(1..7 | ForEach-Object { [pscustomobject]@{ Platform="linux/$target"; ID=('sha256:' + ('a' * 64)); ContainerName="service-$_" } })
    Assert-ReleaseImagePlatforms -Images $images -ExpectedArchitecture $target
    $script:checks++
    $baselineVariant = if ($target -eq 'arm64') { 'v8' } else { 'v1' }
    $images[1].Platform = "linux/$target/$baselineVariant"
    $images[5].Platform = "linux/$target/$baselineVariant"
    Assert-ReleaseImagePlatforms -Images $images -ExpectedArchitecture $target
    $script:checks++
    foreach ($variant in @('linux/arm64/v7','linux/arm64/v8.1','linux/arm64/v9','linux/amd64/v2','linux/amd64/v3','linux/amd64/v8','linux/arm64/v8/extra','Linux/arm64/v8')) {
        $original = $images[0].Platform
        $images[0].Platform = $variant
        Assert-Refused { Assert-ReleaseImagePlatforms -Images $images -ExpectedArchitecture $target }
        $images[0].Platform = $original
    }
    $images[3].Platform = "linux/$other"
    Assert-Refused { Assert-ReleaseImagePlatforms -Images $images -ExpectedArchitecture $target }
    $images[3].Platform = "linux/$target"
    $images[3].ID = 'mutable-image-tag'
    Assert-Refused { Assert-ReleaseImagePlatforms -Images $images -ExpectedArchitecture $target }
    $images[3].ID = 'sha256:' + ('b' * 64)
    $images[3].ContainerName = $images[2].ContainerName
    Assert-Refused { Assert-ReleaseImagePlatforms -Images $images -ExpectedArchitecture $target }
    Assert-Refused { Assert-ReleaseImagePlatforms -Images @() -ExpectedArchitecture $target }
    Assert-Refused { Assert-ReleaseImagePlatforms -Images $images[0..5] -ExpectedArchitecture $target }
}
$fixture = Get-Content -LiteralPath (Join-Path $PSScriptRoot '../../tests/fixtures/release-images-arm64-v8.json') -Raw -Encoding utf8 | ConvertFrom-Json
if ($fixture.formatVersion -ne 1 -or @($fixture.images | Where-Object Platform -CEQ 'linux/arm64/v8').Count -ne 2) { throw 'Actual ARM64 regression fixture is incomplete.' }
Assert-ReleaseImagePlatforms -Images $fixture.images -ExpectedArchitecture arm64
$script:checks++
Assert-Refused { Assert-ReleaseImagePlatforms -Images $fixture.images -ExpectedArchitecture amd64 }
Write-Host "PASS: $script:checks native platform and image receipt checks."
