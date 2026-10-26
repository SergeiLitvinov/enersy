module JuliaNoticeInventory

using Pkg, TOML, SHA, JSON, Dates

digest(bytes) = bytes2hex(sha256(bytes))
file_digest(file) = open(file, "r") do io
    bytes2hex(sha256(io))
end

function within(root, candidate)
    relative = relpath(candidate, root)
    relative != ".." && !startswith(relative, ".." * string(Base.Filesystem.path_separator)) && !isabspath(relative)
end

function sdk_components()
    rows = []
    platform = Base.BinaryPlatforms.HostPlatform()
    for name in sort!(readdir(Sys.STDLIB))
        endswith(name, "_jll") || continue
        directory = joinpath(Sys.STDLIB, name)
        project_file = joinpath(directory, "Project.toml")
        isfile(project_file) || continue
        project = TOML.parsefile(project_file)
        project["name"] == name || error("SDK JLL identity mismatch")
        metadata = joinpath(directory, "StdlibArtifacts.toml")
        artifacts = []
        if isfile(metadata)
            for artifact_name in sort!(collect(keys(TOML.parsefile(metadata))))
                selected = Pkg.Artifacts.artifact_meta(artifact_name, metadata; platform)
                push!(artifacts, (;name=artifact_name, selected))
            end
        end
        push!(rows, (;name, uuid=project["uuid"], version=get(project,"version",nothing),
            metadataSha256=isfile(metadata) ? file_digest(metadata) : nothing, artifacts))
    end
    rows
end

function sdk_libraries()
    root = realpath(joinpath(Sys.BINDIR, ".."))
    rows = []
    seen = Set{String}()
    for directory in (joinpath(root,"lib"), joinpath(root,"lib","julia"))
        isdir(directory) || continue
        for name in sort!(readdir(directory))
            occursin(r"\.so(?:\.|$)|\.dylib$|\.dll$"i,name) || continue
            file = realpath(joinpath(directory,name))
            isfile(file) && within(root,file) && !(file in seen) || continue
            push!(seen,file)
            push!(rows,(;file=replace(relpath(file,root),'\\'=>'/'),sha256=file_digest(file),bytes=filesize(file)))
        end
    end
    sort!(rows;by=r->r.file)
end

function facts()
    (;formatVersion=1, scope="julia-sdk-notice-facts", juliaVersion=string(VERSION),
        juliaCommit=Base.GIT_VERSION_INFO.commit,
        platform=Base.BinaryPlatforms.triplet(Base.BinaryPlatforms.HostPlatform()),
        components=sdk_components(), libraries=sdk_libraries())
end

const NOTICE_NAME = r"(?i)^(licen[sc]e|copying|notice|copyright|patents)([-_][a-z0-9-]+)?(\.(txt|md|markdown|rst|text|html))?$|^third[-_]?party[-_ ]?(notices?|licen[sc]es?)(\.(txt|md|markdown|rst|text|html))?$"

function relative_file(value)
    value isa AbstractString && !isempty(value) && !occursin('\\',value) &&
        !occursin(':',value) && !startswith(value,"/") &&
        all(part->!(part in ("",".","..")),split(value,'/')) || error("Invalid notice path")
    String(value)
end

function checked_file(root, relative)
    file = realpath(joinpath(root,relative_file(relative)))
    within(realpath(root),file) && isfile(file) || error("Notice source escapes its directory or is not a file")
    file
end

function capture_text(root, relative, notices; expected=nothing, expected_bytes=nothing)
    file = checked_file(root, relative)
    0 < filesize(file) <= 4*1024*1024 || error("Notice is empty or oversized")
    bytes = read(file)
    sha = digest(bytes)
    expected === nothing || expected == sha || error("Notice checksum mismatch")
    expected_bytes === nothing || expected_bytes == length(bytes) || error("Notice size mismatch")
    text = String(copy(bytes))
    isvalid(text) || error("Notice is not valid UTF-8")
    notices[sha] = text
    Dict("name"=>String(relative),"sha256"=>sha,"bytes"=>length(bytes))
end

function root_notices(directory, notices)
    result = []
    for name in sort!(readdir(directory))
        occursin(NOTICE_NAME,name) || continue
        isdir(joinpath(directory,name)) && continue
        push!(result,capture_text(directory,name,notices))
    end
    result
end

function verify_supplements(current, config, index, directory, notices)
    index["formatVersion"] == 1 && index["scope"] == "julia-sdk-reviewed-notice-sources" || error("Unsupported Julia notice source index")
    for field in ("juliaVersion","juliaCommit")
        current[field] == config[field] == index[field] || error("Julia runtime does not match reviewed notice sources")
    end
    current["platform"] == index["platform"] || error("Julia notice source platform mismatch")
    thirdparty = index["runtimeThirdParty"]
    thirdparty["file"] == "runtime/THIRDPARTY.md" &&
        thirdparty["url"] == config["thirdParty"]["url"] &&
        thirdparty["gitBlobSha1"] == config["thirdParty"]["gitBlobSha1"] || error("Unreviewed Julia third-party source")
    captured = capture_text(directory,thirdparty["file"],notices;expected=thirdparty["sha256"],expected_bytes=thirdparty["bytes"])
    bytes = read(checked_file(directory,thirdparty["file"]))
    blob = vcat(collect(codeunits("blob $(length(bytes))\0")),bytes)
    bytes2hex(sha1(blob)) == thirdparty["gitBlobSha1"] || error("Julia third-party Git blob mismatch")
    sdk = Dict(row["uuid"]=>row for row in current["components"])
    length(sdk) == length(current["components"]) == length(index["components"]) || error("SDK notice component set mismatch")
    libraries = Dict(row["file"]=>row for row in current["libraries"])
    seen = Set{String}()
    rows = []
    for component in index["components"]
        uuid = component["uuid"]
        haskey(sdk,uuid) && !(uuid in seen) || error("Unexpected or duplicate SDK notice component")
        push!(seen,uuid)
        actual = sdk[uuid]
        for field in ("name","version","metadataSha256")
            component[field] == actual[field] || error("SDK component metadata changed")
        end
        declarations = Dict(row["name"]=>row["selected"] for row in actual["artifacts"])
        length(declarations) == length(component["artifacts"]) || error("SDK artifact set mismatch")
        artifacts_seen = Set{String}()
        for artifact in component["artifacts"]
            name = artifact["name"]
            haskey(declarations,name) && !(name in artifacts_seen) || error("Unexpected or duplicate SDK artifact")
            push!(artifacts_seen,name)
            declared = declarations[name]
            if declared === nothing
                artifact["status"] == "no_host_artifact" || error("Unsupported SDK platform was masked")
                continue
            end
            artifact["treeSha1"] == declared["git-tree-sha1"] || error("SDK artifact tree mismatch")
            any(item->item["url"] == artifact["archiveUrl"] && item["sha256"] == artifact["archiveSha256"],declared["download"]) || error("Unreviewed SDK artifact download")
            for notice in artifact["noticeFiles"]
                relative = relative_file(notice["archivePath"])
                startswith(relative,"share/licenses/") || error("SDK supplemental file is not an artifact notice")
                notice["file"] == "artifacts/$(artifact["archiveSha256"])/$relative" || error("SDK notice source identity mismatch")
                capture_text(directory,notice["file"],notices;expected=notice["sha256"],expected_bytes=notice["bytes"])
            end
            for comparison in artifact["libraryComparisons"]
                file = comparison["sdkFile"]
                haskey(libraries,file) && libraries[file]["sha256"] == comparison["sdkSha256"] || error("SDK library differs from reviewed source comparison")
                comparison["sameBytes"] == (comparison["sdkSha256"] == comparison["artifactSha256"]) || error("Invalid artifact binary comparison")
            end
        end
        push!(rows,component)
    end
    sort!(rows;by=row->row["name"])
    captured, rows
end

function package_notice_record(name, entry, info, notices; stdlib=realpath(Sys.STDLIB), package_roots=[joinpath(depot,"packages") for depot in DEPOT_PATH])
    info.name == name && string(info.version) == get(entry,"version",string(info.version)) || error("Locked Julia package identity mismatch")
    directory = realpath(info.source)
    isstdlib = within(stdlib,directory)
    tree = get(entry,"git-tree-sha1",nothing)
    if tree !== nothing
        any(root->isdir(root) && within(realpath(root),directory),package_roots) || error("Julia package source is outside approved depots")
        string(info.tree_hash) == tree && bytes2hex(Pkg.GitTools.tree_hash(directory)) == tree || error("Julia package source tree differs from Manifest")
    elseif !isstdlib
        error("Unversioned or local Julia dependency needs provenance review")
    end
    project_file = checked_file(directory,"Project.toml")
    project = TOML.parsefile(project_file)
    project["name"] == name && project["uuid"] == entry["uuid"] || error("Julia package Project identity mismatch")
    haskey(project,"version") && haskey(entry,"version") && project["version"] != entry["version"] && error("Julia package Project version mismatch")
    files = root_notices(directory,notices)
    Dict("name"=>name,"uuid"=>entry["uuid"],"version"=>get(entry,"version",nothing),
        "source"=>isstdlib ? "julia-stdlib" : "registry", "sourceTreeSha1"=>tree,
        "projectSha256"=>file_digest(project_file),"noticeFiles"=>files,
        "noticeStatus"=>isempty(files) ? "no_package_notice_file" : "package_notice_files")
end

function inventory(source_directory, config_file; project_license="/usr/share/licenses/enersy/LICENSE")
    project_file = Base.active_project()
    project_file === nothing && error("No active Julia project")
    manifest_file = joinpath(dirname(project_file),"Manifest.toml")
    original_project, original_manifest = read(project_file), read(manifest_file)
    project, manifest = TOML.parse(String(copy(original_project))), TOML.parse(String(copy(original_manifest)))
    get(manifest,"manifest_format",nothing) in ("2.0","2.1") || error("Unsupported Julia Manifest format")
    manifest["julia_version"] == string(VERSION) || error("Julia runtime/Manifest mismatch")
    config = JSON.parse(read(config_file,String),Dict{String,Any})
    index_file = checked_file(source_directory,"index.json")
    index = JSON.parse(read(index_file,String),Dict{String,Any})
    current = JSON.parse(JSON.json(facts();omit_null=false,omit_empty=false),Dict{String,Any})
    notices = Dict{String,String}()
    thirdparty, components = verify_supplements(current,config,index,source_directory,notices)
    sdk = Dict(component["uuid"]=>component for component in components)
    dependencies = Pkg.dependencies()
    records = []
    for (name,entries) in sort!(collect(manifest["deps"]);by=first), entry in entries
        entry["uuid"] == project["uuid"] && continue
        any(key->haskey(entry,key),("path","repo-url")) && error("Local/repository dependency requires notice provenance review")
        uuid = Base.UUID(entry["uuid"])
        haskey(dependencies,uuid) || error("Locked dependency is not installed")
        record = package_notice_record(name,entry,dependencies[uuid],notices)
        supplemental = haskey(sdk,entry["uuid"]) && any(a->!isempty(get(a,"noticeFiles",[])),sdk[entry["uuid"]]["artifacts"])
        if isempty(record["noticeFiles"]) && supplemental
            record["noticeStatus"] = "sdk_artifact_notice_files"
        elseif isempty(record["noticeFiles"]) && record["source"] == "julia-stdlib"
            record["noticeStatus"] = "runtime_index_only"
        end
        record["incompleteEvidence"] = isempty(record["noticeFiles"]) && !supplemental
        push!(records,record)
    end
    runtime_root = realpath(joinpath(Sys.BINDIR,".."))
    runtime_files = [capture_text(runtime_root,"LICENSE.md",notices),
        capture_text(runtime_root,"share/julia/Compiler/LICENSE.md",notices)]
    installed_index = capture_text(runtime_root,"THIRDPARTY.md",notices;expected=thirdparty["sha256"])
    push!(runtime_files,installed_index)
    own = capture_text(realpath(dirname(project_license)),basename(project_license),notices)
    comparisons = [comparison for component in components for artifact in component["artifacts"] for comparison in get(artifact,"libraryComparisons",[])]
    gaps = []
    for component in components
        if component["metadataSha256"] === nothing
            push!(gaps,Dict("name"=>component["name"],"version"=>component["version"],"reason"=>"no_artifact_metadata"))
        end
        for artifact in component["artifacts"]
            isempty(get(artifact,"noticeFiles",[])) && push!(gaps,Dict("name"=>component["name"],"version"=>component["version"],"reason"=>artifact["status"]))
        end
    end
    read(project_file) == original_project && read(manifest_file) == original_manifest || error("Julia project lock inputs changed during inventory")
    Dict("formatVersion"=>1,"scope"=>"julia-locked-environment-and-sdk-notices", "capturedUtc"=>string(now(UTC))*"Z",
        "runtime"=>Dict("version"=>string(VERSION),"commit"=>current["juliaCommit"],"platform"=>current["platform"],"noticeFiles"=>runtime_files),
        "project"=>Dict("name"=>project["name"],"uuid"=>project["uuid"],"version"=>project["version"],"noticeFiles"=>[own]),
        "projectSha256"=>digest(original_project),"manifestSha256"=>digest(original_manifest),
        "sourceIndexSha256"=>file_digest(index_file),"packages"=>records,"sdkComponents"=>components,
        "sdkLibraries"=>current["libraries"],"packageCount"=>length(records),
        "sdkNoticeGaps"=>gaps,"binaryComparisons"=>Dict("total"=>length(comparisons),"sameBytes"=>count(row->row["sameBytes"],comparisons),"differentBytes"=>count(row->!row["sameBytes"],comparisons)),
        "incompletePackageEvidenceCount"=>count(row->row["incompleteEvidence"],records),"notices"=>notices,
        "limitations"=>[
            "A runtime third-party index is not a full per-source-file license attribution review",
            "SDK artifact notices are taken from the declared checksum-pinned upstream archives; binary comparisons are reported separately",
            "A differing relocated SDK library is not treated as a byte-identical artifact product",
            "No-artifact components, operating-system packages and other build variants require separate review",
            "Presence of notice text is not a license compatibility decision or engineering validation"])
end

function main(args)
    Pkg.offline(true)
    if args == ["--facts"]
        JSON.json(stdout,facts();allownan=false,omit_null=false,omit_empty=false)
        println()
    else
        length(args) == 3 || error("Usage: collect_julia_licenses.jl SOURCES CONFIG OUTPUT.json")
        report = inventory(args[1],args[2])
        mkpath(dirname(abspath(args[3])))
        open(args[3],"w") do io
            JSON.json(io,report;allownan=false,omit_null=false,omit_empty=false)
            println(io)
        end
        println("$(report["packageCount"]) locked Julia packages; $(report["incompletePackageEvidenceCount"]) require additional package-specific notice review")
    end
end

end

abspath(PROGRAM_FILE) == (@__FILE__) && JuliaNoticeInventory.main(ARGS)
