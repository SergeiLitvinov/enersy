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

function unbound_artifact_tags(platform, selected)
    selected === nothing && return Dict{String,Any}()
    supplied = Base.BinaryPlatforms.tags(platform)
    Dict{String,Any}(String(key)=>value for (key,value) in selected
        if !(key in ("git-tree-sha1","download","lazy")) && !haskey(supplied,key))
end

function reviewed_platform_bindings(config, platform)
    config === nothing && return Any[]
    entries = get(config,"artifactPlatformBindings",Any[])
    entries isa AbstractVector && length(entries) <= 100 || error("Invalid artifact platform bindings")
    seen = Set{Tuple{String,String,String}}()
    required = Set(["runtimePlatform","componentUUID","componentVersion","metadataSha256","artifact","tags","archiveSha256","sdkFile","artifactFile","sdkSha256"])
    for entry in entries
        entry isa AbstractDict && Set(keys(entry)) == required || error("Invalid artifact platform binding fields")
        for key in setdiff(required,Set(["tags"]))
            entry[key] isa AbstractString && !isempty(entry[key]) || error("Invalid artifact platform binding value")
        end
        for key in ("metadataSha256","archiveSha256","sdkSha256")
            occursin(r"\A[a-f0-9]{64}\z",entry[key]) || error("Invalid artifact platform binding checksum")
        end
        sizeof(entry["runtimePlatform"]) <= 200 && occursin(r"\A[a-z0-9][a-z0-9_.+\-]*\z",entry["runtimePlatform"]) &&
            occursin('-',entry["runtimePlatform"]) && !endswith(entry["runtimePlatform"],".") || error("Invalid bound runtime platform")
        string(Base.UUID(entry["componentUUID"])) == entry["componentUUID"] || error("Invalid bound component UUID")
        relative_file(entry["sdkFile"]); relative_file(entry["artifactFile"])
        tags = entry["tags"]
        tags isa AbstractDict && 1 <= length(tags) <= 8 || error("Invalid bound platform tags")
        for (key,value) in tags
            key isa AbstractString && value isa AbstractString && occursin(r"\A[a-z][a-z0-9_]{0,63}\z",key) &&
                occursin(r"\A[a-zA-Z0-9_.+\-]{1,64}\z",value) || error("Invalid bound platform tag")
        end
        identity = (entry["runtimePlatform"],entry["componentUUID"],entry["artifact"])
        identity in seen && error("Duplicate artifact platform binding")
        push!(seen,identity)
    end
    filter(entry->entry["runtimePlatform"] == Base.BinaryPlatforms.triplet(platform),entries)
end

function bound_artifact_platform(platform, binding, component, metadata_sha, libraries)
    binding === nothing && return platform
    component["uuid"] == binding["componentUUID"] && get(component,"version",nothing) == binding["componentVersion"] &&
        metadata_sha == binding["metadataSha256"] || error("Bound SDK component identity changed")
    any(row->row.file == binding["sdkFile"] && row.sha256 == binding["sdkSha256"],libraries) || error("Bound SDK library identity changed")
    qualified = deepcopy(platform)
    for (key,value) in binding["tags"]
        !haskey(Base.BinaryPlatforms.tags(platform),key) || error("Artifact binding cannot overwrite a supplied platform tag")
        qualified[key] = value
    end
    qualified
end

function sdk_components(platform, libraries, bindings)
    rows = []
    by_artifact = Dict((entry["componentUUID"],entry["artifact"])=>entry for entry in bindings)
    used = Set{Tuple{String,String}}()
    for name in sort!(readdir(Sys.STDLIB))
        endswith(name, "_jll") || continue
        directory = joinpath(Sys.STDLIB, name)
        project_file = joinpath(directory, "Project.toml")
        isfile(project_file) || continue
        project = TOML.parsefile(project_file)
        project["name"] == name || error("SDK JLL identity mismatch")
        metadata = joinpath(directory, "StdlibArtifacts.toml")
        metadata_sha = isfile(metadata) ? file_digest(metadata) : nothing
        artifacts = []
        if isfile(metadata)
            for artifact_name in sort!(collect(keys(TOML.parsefile(metadata))))
                identity = (project["uuid"],artifact_name)
                binding = get(by_artifact,identity,nothing)
                qualified = bound_artifact_platform(platform,binding,project,metadata_sha,libraries)
                selected = Pkg.Artifacts.artifact_meta(artifact_name, metadata; platform=qualified)
                if binding !== nothing
                    selected !== nothing && any(item->item["sha256"] == binding["archiveSha256"],selected["download"]) || error("Bound SDK archive identity changed")
                    push!(used,identity)
                end
                push!(artifacts, (;name=artifact_name, selected, platformBinding=binding, unboundPlatformTags=unbound_artifact_tags(qualified,selected)))
            end
        end
        push!(rows, (;name, uuid=project["uuid"], version=get(project,"version",nothing),
            metadataSha256=metadata_sha, artifacts))
    end
    length(used) == length(bindings) || error("Reviewed artifact binding was not used by this SDK")
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

function facts(config=nothing)
    if config !== nothing
        config["juliaVersion"] == string(VERSION) && config["juliaCommit"] == Base.GIT_VERSION_INFO.commit || error("Runtime differs from reviewed binding configuration")
    end
    platform = Base.BinaryPlatforms.HostPlatform()
    libraries = sdk_libraries()
    bindings = reviewed_platform_bindings(config,platform)
    (;formatVersion=1, scope="julia-sdk-notice-facts", juliaVersion=string(VERSION),
        juliaCommit=Base.GIT_VERSION_INFO.commit,
        platform=Base.BinaryPlatforms.triplet(platform),
        components=sdk_components(platform,libraries,bindings), libraries)
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

function notice_index_relative(directory, platform)
    platform isa AbstractString && sizeof(platform) <= 200 &&
        occursin(r"\A[a-z0-9][a-z0-9_.+\-]*\z",platform) && occursin('-',platform) && !endswith(platform,".") || error("Invalid Julia SDK platform triplet")
    scoped_directory = joinpath(directory,"platforms",platform)
    # An explicitly present platform directory must be complete. Never hide a
    # broken or escaping scoped index by falling back to the root inventory.
    relative = ispath(scoped_directory) || islink(scoped_directory) ? "platforms/$platform/index.json" : "index.json"
    checked_file(directory,relative)
    relative
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
        bindings = Dict(row["name"]=>get(row,"platformBinding",nothing) for row in actual["artifacts"])
        length(declarations) == length(component["artifacts"]) || error("SDK artifact set mismatch")
        artifacts_seen = Set{String}()
        for artifact in component["artifacts"]
            name = artifact["name"]
            haskey(declarations,name) && !(name in artifacts_seen) || error("Unexpected or duplicate SDK artifact")
            push!(artifacts_seen,name)
            declared = declarations[name]
            binding = bindings[name]
            get(artifact,"platformBinding",nothing) == binding || error("Reviewed artifact platform binding changed")
            if declared === nothing
                binding === nothing || error("Reviewed binding cannot select an unsupported SDK artifact")
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
            if binding !== nothing
                artifact["archiveSha256"] == binding["archiveSha256"] && any(row->row["sdkFile"] == binding["sdkFile"] &&
                    row["archivePath"] == binding["artifactFile"] && row["sdkSha256"] == row["artifactSha256"] == binding["sdkSha256"] && row["sameBytes"],
                    artifact["libraryComparisons"]) || error("Bound archive lacks byte-identical SDK library evidence")
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
    current = JSON.parse(JSON.json(facts(config);omit_null=false,omit_empty=false),Dict{String,Any})
    index_relative = notice_index_relative(source_directory,current["platform"])
    index_file = checked_file(source_directory,index_relative)
    index = JSON.parse(read(index_file,String),Dict{String,Any})
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
    selection_diagnostics = [Dict("component"=>component["name"],"uuid"=>component["uuid"],"artifact"=>artifact["name"],"unboundPlatformTags"=>artifact["unboundPlatformTags"])
        for component in current["components"] for artifact in component["artifacts"] if !isempty(artifact["unboundPlatformTags"])]
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
        "noticeSourceIndex"=>Dict("file"=>index_relative,"sha256"=>file_digest(index_file)),
        "artifactSelectionDiagnostics"=>selection_diagnostics,
        "appliedArtifactPlatformBindings"=>[artifact["platformBinding"] for component in current["components"] for artifact in component["artifacts"] if artifact["platformBinding"] !== nothing],
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
            "A differing SDK library is not treated as a byte-identical artifact product; build-variant and provenance differences require review",
            "Unbound artifact variant tags are reported explicitly; reviewed bindings separately require byte-identical SDK library evidence",
            "No-artifact components, operating-system packages and other build variants require separate review",
            "Presence of notice text is not a license compatibility decision or engineering validation"])
end

function main(args)
    Pkg.offline(true)
    if !isempty(args) && first(args) == "--facts"
        length(args) in (1,2) || error("Usage: collect_julia_licenses.jl --facts [CONFIG]")
        config = length(args) == 2 ? JSON.parse(read(args[2],String),Dict{String,Any}) : nothing
        JSON.json(stdout,facts(config);allownan=false,omit_null=false,omit_empty=false)
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
