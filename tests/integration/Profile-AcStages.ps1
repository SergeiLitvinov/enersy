param(
    [int[]]$Sizes = @(1000,10000,100000),
    [ValidateSet('radial','ring','mesh')][string[]]$Families = @('radial','ring','mesh'),
    [ValidateRange(3,30)][int]$Samples = 5,
    [string]$OutputDirectory = '.cache/ac-stages'
)
$ErrorActionPreference = 'Stop'
$root = (Resolve-Path (Join-Path $PSScriptRoot '../..')).Path
if ($Sizes | Where-Object { $_ -lt 4 -or $_ -gt 100000 }) { throw 'Sizes must be 4..100000' }
$out = [IO.Path]::GetFullPath($OutputDirectory, $root)
if (Test-Path -LiteralPath $out) { throw 'Use a new output directory to preserve prior measurements' }
$null = New-Item -ItemType Directory -Path $out
$image = 'enersy-julia-compute'
$imageID = docker image inspect $image --format '{{.Id}}'
if ($LASTEXITCODE -ne 0) { throw 'Build julia-compute first' }
$records = @()
foreach ($family in $Families) {
    foreach ($size in $Sizes) {
        $name = 'enersy-ac-profile-' + [guid]::NewGuid().ToString('N')
        $file = "$family-$size.json"
        Write-Output "Profiling $family / $size buses"
        try {
            docker run --name $name --cpus 2 --memory 2g --network none --pids-limit 256 `
                -e OPENBLAS_NUM_THREADS=1 -e JULIA_NUM_THREADS=1 `
                --mount "type=bind,source=$root/backend-julia,target=/app,readonly" `
                --mount "type=bind,source=$out,target=/reports" `
                $image julia --project=. --startup-file=no benchmark/ac_stages.jl $family $size "/reports/$file" $Samples
            $exitCode = $LASTEXITCODE
            if ($exitCode -eq 0) {
                $records += Get-Content -LiteralPath (Join-Path $out $file) -Raw | ConvertFrom-Json
            } else {
                $state = docker inspect $name --format '{{json .State}}' | ConvertFrom-Json
                $failure = [ordered]@{status='failed';family=$family;buses=$size;exit_code=$exitCode;oom_killed=$state.OOMKilled}
                $failure | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $out $file) -Encoding utf8
                $records += $failure
            }
        } finally {
            # Only the exact container created for this case; never application services.
            docker rm $name | Out-Null
        }
    }
}
$report = [ordered]@{schema_version=1;image_id=[string]$imageID;runner_sha256=(Get-FileHash -LiteralPath $PSCommandPath -Algorithm SHA256).Hash.ToLowerInvariant();records=$records}
$report | ConvertTo-Json -Depth 30 | Set-Content -LiteralPath (Join-Path $out 'report.json') -Encoding utf8
if (@($records | Where-Object status -ne 'passed').Count) { throw 'Some profiles failed; inspect report.json' }
Write-Output "Completed: $out/report.json"
