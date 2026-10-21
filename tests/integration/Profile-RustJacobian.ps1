param(
    [int[]]$Sizes = @(1000,10000,100000),
    [ValidateSet('radial','ring','mesh')][string[]]$Families = @('radial','ring','mesh'),
    [string]$OutputDirectory = '.cache/rust-jacobian'
)
$ErrorActionPreference = 'Stop'
$root = (Resolve-Path (Join-Path $PSScriptRoot '../..')).Path
if ($Sizes | Where-Object { $_ -lt 4 -or $_ -gt 100000 }) { throw 'Sizes must be 4..100000' }
$out = [IO.Path]::GetFullPath($OutputDirectory,$root)
if (Test-Path -LiteralPath $out) { throw 'Choose a new output directory' }
$null = New-Item -ItemType Directory -Path $out
$runtime = 'enersy-julia-compute'
$rustImage = 'enersy-rust-jacobian-profile'
$names = @()
$walls = @()
foreach ($family in $Families) {
    foreach ($size in $Sizes) {
        $name = "$family-$size"
        $names += $name
        Write-Output "Jacobian comparison: $name"
        docker run --rm --cpus 2 --memory 2g --network none -e OPENBLAS_NUM_THREADS=1 -e JULIA_NUM_THREADS=1 `
            --mount "type=bind,source=$root/backend-julia,target=/app,readonly" --mount "type=bind,source=$out,target=/reports" `
            $runtime julia --project=. --startup-file=no benchmark/rust_jacobian.jl prepare $family $size "/reports/$name"
        if ($LASTEXITCODE -ne 0) { throw "Julia preparation failed: $name" }
        $watch = [Diagnostics.Stopwatch]::StartNew()
        docker run --rm --cpus 2 --memory 2g --network none --mount "type=bind,source=$out,target=/reports" `
            $rustImage "/reports/$name.input.bin" "/reports/$name.rust.bin" "/reports/$name.rust.json"
        $watch.Stop()
        if ($LASTEXITCODE -ne 0) { throw "Rust probe failed: $name" }
        $walls += @{case=$name;rust_probe_container_seconds=$watch.Elapsed.TotalSeconds}
    }
}
ConvertTo-Json -InputObject @($names) | Set-Content -LiteralPath (Join-Path $out 'cases.json') -Encoding utf8
docker run --rm --cpus 2 --memory 2g --network none --mount "type=bind,source=$root/backend-julia,target=/app,readonly" `
    --mount "type=bind,source=$out,target=/reports" $runtime julia --project=. --startup-file=no benchmark/rust_jacobian.jl validate /reports
if ($LASTEXITCODE -ne 0) { throw 'Derivative comparison failed; keep diagnostic files' }
$comparison = Get-Content -LiteralPath (Join-Path $out 'comparison.json') -Raw | ConvertFrom-Json
$hashes = [ordered]@{}
foreach ($path in @('numerics/Cargo.toml','numerics/Cargo.lock','numerics/benchmark.Dockerfile','tests/integration/Profile-RustJacobian.ps1') + @(Get-ChildItem -LiteralPath (Join-Path $root 'numerics/src'),(Join-Path $root 'numerics/examples') -File -Recurse | ForEach-Object { [IO.Path]::GetRelativePath($root,$_.FullName).Replace('\','/') })) {
    $hashes[$path] = (Get-FileHash -LiteralPath (Join-Path $root $path) -Algorithm SHA256).Hash.ToLowerInvariant()
}
$imageID = docker image inspect $rustImage --format '{{.Id}}'
$runtimeID = docker image inspect $runtime --format '{{.Id}}'
$compiler = docker run --rm --network none --entrypoint rustc $rustImage --version
$comparison | Add-Member -NotePropertyName rust_source_sha256 -NotePropertyValue $hashes
$comparison | Add-Member -NotePropertyName rust_image_id -NotePropertyValue ([string]$imageID)
$comparison | Add-Member -NotePropertyName julia_runtime_image_id -NotePropertyValue ([string]$runtimeID)
$comparison | Add-Member -NotePropertyName rustc -NotePropertyValue ([string]$compiler)
$comparison | Add-Member -NotePropertyName container_wall_probes -NotePropertyValue $walls
$comparison | ConvertTo-Json -Depth 30 | Set-Content -LiteralPath (Join-Path $out 'comparison.json') -Encoding utf8
# Generated binary fixtures are reproducible and may be large. Keep the reports.
foreach ($name in $names) { foreach ($suffix in @('input.bin','julia.bin','rust.bin')) { Remove-Item -LiteralPath (Join-Path $out "$name.$suffix") } }
Write-Output "Verified report: $out/comparison.json"
