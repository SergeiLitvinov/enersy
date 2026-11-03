param(
    [Parameter(Mandatory = $true)]
    [string]$OwnerFixture
)
$ErrorActionPreference = 'Stop'
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '../..')).Path
$fixturePath = (Resolve-Path -LiteralPath $OwnerFixture).Path
if (!(Test-Path -LiteralPath $fixturePath -PathType Leaf) -or
    (Get-Item -LiteralPath $fixturePath).Length -gt 8192 -or $fixturePath.Contains(',')) {
    throw 'Expected a small JSON file with the existing disposable owner login/password.'
}
Push-Location $repoRoot
try {
    # Fixed internal network; the test additionally checks exact fixture names.
    $internal = docker network inspect enersy-study-ui_first --format '{{.Internal}}'
    if ($LASTEXITCODE -ne 0 -or $internal -ne 'true') {
        throw 'Start browser-sessions-compose.yml with its operator-created fixture first.'
    }
    docker build --target check -f frontend/Dockerfile -t enersy-queued-basis-check .
    if ($LASTEXITCODE -ne 0) { throw 'Frontend checks failed.' }
    docker run --rm --network enersy-study-ui_first `
        --mount "type=bind,source=$fixturePath,target=/fixture-owner.json,readonly" `
        -e VITE_QUEUED_BASIS_HTTP=1 --entrypoint node enersy-queued-basis-check `
        node_modules/vitest/vitest.mjs run src/api/queued-basis.http.test.ts --maxWorkers=1 --reporter=verbose
    if ($LASTEXITCODE -ne 0) { throw 'Queued-basis HTTP acceptance failed; inspect fixture state before retrying.' }
} finally { Pop-Location }
