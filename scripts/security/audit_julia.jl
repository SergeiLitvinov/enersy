module JuliaDependencyAudit

using TOML, SHA, Dates, JSON, HTTP, Libdl

const ENDPOINT = "https://api.osv.dev/v1/querybatch"

function inventory(manifest)
    get(manifest, "manifest_format", nothing) in ("2.0", "2.1") || error("Unsupported Manifest format")
    packages, unversioned, excluded = [], [], []
    for (name, entries) in sort!(collect(manifest["deps"]); by=first)
        for entry in entries
            uuid = entry["uuid"]
            if haskey(entry, "path") || haskey(entry, "repo-url")
                push!(excluded, (;name, uuid, version=get(entry, "version", nothing),
                    reason="Local or repository dependency is not identified by a General package name"))
                continue
            end
            if !haskey(entry, "version")
                push!(unversioned, (;name, uuid))
                continue
            end
            # UUIDs and exact locked versions remain in the report. The OSV
            # Julia ecosystem indexes General package names, not UUIDs.
            push!(packages, (;name, uuid, version=entry["version"]))
        end
    end
    isempty(packages) && error("Manifest contains no versioned packages")
    return packages, unversioned, excluded
end

function request_batch(queries)
    response = HTTP.post(ENDPOINT, ["Content-Type" => "application/json"],
        JSON.json((;queries)); request_timeout=60, retry=false,
        redirect=false, proxy=HTTP.ProxyConfig())
    response.status == 200 || error("OSV returned HTTP $(response.status)")
    return JSON.parse(response.body, Dict{String,Any})
end

function query_packages(packages; request=request_batch)
    queries = [Dict{String,Any}("package" => Dict("ecosystem" => "Julia", "name" => p.name),
        "version" => p.version) for p in packages]
    findings = Dict{String,Any}()
    pending = collect(eachindex(queries))
    pages = Set{Tuple{Int,String}}()
    while !isempty(pending)
        response = request(queries[pending])
        haskey(response, "error") && error("OSV returned an error")
        results = get(response, "results", nothing)
        results isa AbstractVector && length(results) == length(pending) ||
            error("OSV result count does not match queried packages")
        next = Int[]
        for (index, result) in zip(pending, results)
            result isa AbstractDict || error("Malformed OSV package result")
            haskey(result, "error") && error("OSV returned a package error")
            vulns = get(result, "vulns", [])
            vulns isa AbstractVector || error("Malformed OSV advisory list")
            for vuln in vulns
                vuln isa AbstractDict || error("Malformed OSV advisory")
                id = get(vuln, "id", nothing)
                id isa AbstractString && !isempty(id) || error("OSV advisory has no ID")
                p = packages[index]
                findings["$(p.uuid):$(p.version):$id"] = (;package=p, id,
                    modified=get(vuln, "modified", nothing))
            end
            token = get(result, "next_page_token", "")
            token isa AbstractString || error("Malformed OSV pagination token")
            if !isempty(token)
                page = (index, token)
                page in pages && error("OSV repeated a pagination token")
                push!(pages, page)
                length(pages) <= 1000 || error("OSV pagination limit exceeded")
                queries[index]["page_token"] = token
                push!(next, index)
            end
        end
        pending = next
    end
    return [findings[key] for key in sort!(collect(keys(findings)))]
end

function runtime_metadata(manifest)
    VersionNumber(manifest["julia_version"]) == VERSION ||
        error("Audit runtime does not match the locked Julia version")
    entries = manifest["deps"]["Zlib_jll"]
    length(entries) == 1 || error("Ambiguous locked Zlib_jll")
    expected = VersionNumber(only(entries)["version"])
    zlib = Base.require(Base.PkgId(Base.UUID("83775a58-1f1d-513f-b197-d71354ab007a"), "Zlib_jll"))
    Base.pkgversion(zlib) == expected || error("Loaded Zlib_jll does not match Manifest")
    library_version = Libdl.dlopen(zlib.libz) do handle
        symbol = Libdl.dlsym(handle, :zlibVersion)
        unsafe_string(ccall(symbol, Cstring, ()))
    end
    VersionNumber(library_version) == VersionNumber(expected.major, expected.minor, expected.patch) ||
        error("Loaded zlib binary does not match the locked package version")
    return (;juliaVersion=string(VERSION), zlibPackageVersion=string(expected),
        zlibLibraryVersion=library_version, zlibLibrarySha256=bytes2hex(sha256(read(zlib.libz_path))))
end

function main(path)
    bytes = read(path)
    manifest = TOML.parse(String(copy(bytes)))
    runtime = runtime_metadata(manifest)
    packages, unversioned, excluded = inventory(manifest)
    # Detect a broken/misconfigured ecosystem query instead of interpreting it
    # as a clean audit. This release must match the published CR/LF advisory.
    control = (name="HTTP", uuid="cd3eb016-35fb-5094-929b-558a96fad6f3", version="1.10.16")
    any(f.id == "JLSEC-2025-1" for f in query_packages([control])) ||
        error("OSV positive control did not detect JLSEC-2025-1")
    findings = query_packages(packages)
    println(JSON.json((;format=1, capturedUtc=string(now(UTC)) * "Z", source=ENDPOINT,
        manifestSha256=bytes2hex(sha256(bytes)), juliaVersion=manifest["julia_version"],
        runtime, packages, unversioned, excluded, findings,
        limitations=["Name/version advisory lookup, not function reachability analysis",
            "Unversioned stdlibs and Julia runtime are not queried",
            "Julia JLL advisory coverage is known to be incomplete",
            "Container operating-system packages are outside this audit"])))
    return isempty(findings) ? 0 : 1
end

end

if abspath(PROGRAM_FILE) == @__FILE__
    length(ARGS) == 1 || error("Usage: audit_julia.jl Manifest.toml")
    exit(JuliaDependencyAudit.main(only(ARGS)))
end
