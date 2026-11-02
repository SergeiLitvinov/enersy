function Assert-ReleaseArchitecture {
    param(
        [string]$OS,
        [string]$Architecture,
        [ValidateSet('amd64','arm64')][string]$ExpectedArchitecture
    )
    $aliases = @{ amd64='amd64'; x86_64='amd64'; arm64='arm64'; aarch64='arm64' }
    if ($OS -cne 'linux' -or -not $aliases.ContainsKey($Architecture) -or
        $aliases[$Architecture] -cne $ExpectedArchitecture) {
        throw "Release requires native Linux $ExpectedArchitecture; Docker reported $OS/$Architecture."
    }
}

function Assert-ReleaseImagePlatforms {
    param(
        [AllowEmptyCollection()][object[]]$Images,
        [ValidateSet('amd64','arm64')][string]$ExpectedArchitecture
    )
    # Seven persistent services must exist before the separate HTTP checker runs.
    if ($Images.Count -ne 7) { throw 'Release image receipt must contain all seven running services.' }
    # OCI arm64/v8 and amd64/v1 are explicit baseline variants. Keep the original
    # receipt intact; higher ISA requirements need a separate platform review.
    $allowedPlatforms = if ($ExpectedArchitecture -ceq 'arm64') { @('linux/arm64','linux/arm64/v8') } else { @('linux/amd64','linux/amd64/v1') }
    $names = [Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
    foreach ($image in $Images) {
        if ($allowedPlatforms -cnotcontains $image.Platform -or
            $image.ID -cnotmatch '^sha256:[a-f0-9]{64}$' -or
            [string]::IsNullOrWhiteSpace($image.ContainerName) -or
            -not $names.Add($image.ContainerName)) {
            throw 'Release image receipt contains a foreign platform, invalid identity or duplicate service.'
        }
    }
}
