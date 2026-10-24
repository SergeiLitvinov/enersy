param([int[]]$Sizes=@(1000,10000,100000),[ValidateSet('radial','ring','mesh')][string[]]$Families=@('radial','ring','mesh'),[string]$OutputDirectory='.cache/rust-newton')
$ErrorActionPreference='Stop'
$root=(Resolve-Path (Join-Path $PSScriptRoot '../..')).Path
if ($Sizes | Where-Object { $_ -lt 4 -or $_ -gt 100000 }) { throw 'Sizes must be 4..100000' }
$out=[IO.Path]::GetFullPath($OutputDirectory,$root)
if (Test-Path -LiteralPath $out) { throw 'Choose a new output directory' }
$null=New-Item -ItemType Directory -Path $out
$image='enersy-numerics-ffi-check'
$records=@()
foreach ($family in $Families) { foreach ($size in $Sizes) {
    $file="$family-$size.json"
    Write-Output "Complete Newton comparison: $family/$size"
    docker run --rm --network none --cpus 2 --memory 2g -e OPENBLAS_NUM_THREADS=1 -e JULIA_NUM_THREADS=1 `
        --mount "type=bind,source=$root/backend-julia,target=/app,readonly" --mount "type=bind,source=$out,target=/reports" `
        $image julia --project=. --startup-file=no benchmark/rust_newton.jl $family $size "/reports/$file"
    if ($LASTEXITCODE -ne 0) { throw "Complete Newton profile failed: $family/$size" }
    $records+=Get-Content -LiteralPath (Join-Path $out $file) -Raw | ConvertFrom-Json
} }
$hashes=[ordered]@{}
foreach ($path in @('numerics/Cargo.toml','numerics/Cargo.lock','numerics/ffi.Dockerfile','tests/integration/Profile-RustNewton.ps1')+@(Get-ChildItem -LiteralPath (Join-Path $root 'numerics/src'),(Join-Path $root 'numerics/include') -Recurse -File | ForEach-Object { [IO.Path]::GetRelativePath($root,$_.FullName).Replace([char]92,[char]47) })) {
    $hashes[$path]=(Get-FileHash -LiteralPath (Join-Path $root $path) -Algorithm SHA256).Hash.ToLowerInvariant()
}
$imageID=docker image inspect $image --format '{{.Id}}'
$report=[ordered]@{schema_version=1;image_id=[string]$imageID;rust_source_sha256=$hashes;records=$records}
$report | ConvertTo-Json -Depth 30 | Set-Content -LiteralPath (Join-Path $out 'report.json') -Encoding utf8
Write-Output "Verified Newton report: $out/report.json"
