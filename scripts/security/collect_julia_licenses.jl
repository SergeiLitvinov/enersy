module JuliaNoticeInventory

using Pkg, TOML, SHA, JSON, Dates

digest(bytes) = bytes2hex(sha256(bytes))
file_digest(file, algorithm=sha256) = open(file, "r") do io
    bytes2hex(algorithm(io))
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
        entry isa AbstractDict && Set(keys(entry)) in (required,union(required,Set(["repackagingProof"]))) || error("Invalid artifact platform binding fields")
        if haskey(entry,"repackagingProof")
            proof = entry["repackagingProof"]
            proof isa AbstractDict && Set(keys(proof)) == Set(["file","sha256"]) || error("Invalid repackaging proof reference")
            startswith(relative_file(proof["file"]),"packaging/") && occursin(r"\A[a-f0-9]{64}\z",proof["sha256"]) || error("Invalid repackaging proof identity")
        end
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

function sdk_executables(root=realpath(joinpath(Sys.BINDIR,"..")))
    root = realpath(root)
    rows = []
    # Only SDK-owned locations used by the LLD_jll stub; never search host PATH.
    for relative in ("libexec/julia/lld", "tools/lld", "bin/lld",
                     "libexec/julia/lld.exe", "tools/lld.exe", "bin/lld.exe")
        candidate = joinpath(root,split(relative,'/')...)
        (ispath(candidate) || islink(candidate)) || continue
        file = realpath(candidate)
        isfile(file) && within(root,file) || error("SDK executable escapes its runtime or is not a file")
        push!(rows,(;file=relative,sha256=file_digest(file),bytes=filesize(file),component="LLD_jll"))
    end
    sort!(rows;by=r->r.file)
end

function sdk_data_products(root=realpath(joinpath(Sys.BINDIR,"..")), stdlib=Sys.STDLIB)
    project = joinpath(stdlib,"MozillaCACerts_jll","Project.toml")
    isfile(project) || return []
    within(realpath(root),realpath(project)) || error("SDK data component escapes runtime")
    component = TOML.parsefile(project)
    component["name"] == "MozillaCACerts_jll" && component["uuid"] == "14a3606d-f60d-562e-9121-12d972cd8159" || error("Unexpected SDK CA data component")
    stub = checked_file(root,replace(relpath(joinpath(dirname(project),"src","MozillaCACerts_jll.jl"),root),'\\'=>'/'))
    file = checked_file(root,"share/julia/cert.pem")
    0 < filesize(file) <= 4*1024*1024 || error("SDK CA data is empty or oversized")
    [Dict("componentName"=>component["name"],"componentUUID"=>component["uuid"],"componentVersion"=>component["version"],
        "projectSha256"=>file_digest(project),"stubSha256"=>file_digest(stub),"sdkFile"=>"share/julia/cert.pem",
        "sdkSha256"=>file_digest(file),"sdkSha512"=>file_digest(file,sha512),"sdkBytes"=>filesize(file))]
end

function executable_coverage(executables, comparisons, proofs=[])
    [Dict("file"=>row["file"],"sha256"=>row["sha256"],"bytes"=>row["bytes"],"component"=>row["component"],
        "comparisonStatus"=>begin
            matched = filter(item->item["sdkFile"] == row["file"] && item["sdkSha256"] == row["sha256"],comparisons)
            isempty(matched) ? "not_compared" : any(item->item["sameBytes"],matched) ? "byte_identical" :
                any(item->item["evidence"]["sdkFile"] == row["file"] && item["evidence"]["sdkSha256"] == row["sha256"],proofs) ? "reviewed_repackaging" : "different_bytes"
        end) for row in executables]
end

function facts(config=nothing)
    if config !== nothing
        config["juliaVersion"] == string(VERSION) && config["juliaCommit"] == Base.GIT_VERSION_INFO.commit || error("Runtime differs from reviewed binding configuration")
    end
    platform = Base.BinaryPlatforms.HostPlatform()
    libraries = sdk_libraries()
    executables = sdk_executables()
    bindings = reviewed_platform_bindings(config,platform)
    (;formatVersion=1, scope="julia-sdk-notice-facts", juliaVersion=string(VERSION),
        juliaCommit=Base.GIT_VERSION_INFO.commit,
        platform=Base.BinaryPlatforms.triplet(platform),
        components=sdk_components(platform,vcat(libraries,executables),bindings), libraries, executables, dataProducts=sdk_data_products())
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

function repackaging_proof(root, binding, current)
    reference = binding["repackagingProof"]
    file = checked_file(root,reference["file"])
    0 < filesize(file) <= 65536 && file_digest(file) == reference["sha256"] || error("Repackaging proof checksum/size mismatch")
    proof = JSON.parse(read(file,String),Dict{String,Any})
    expected = Set(["formatVersion","scope","juliaVersion","juliaCommit","platform","componentUUID","metadataSha256",
        "archiveUrl","archiveSha256","artifactFile","artifactSha256","sdkFile","sdkSha256","sdkBytes","tool","operation",
        "reproducedSha256","reproducedBytes","sameBytesAfterRepackaging","sdkImageId","builderImageId"])
    Set(keys(proof)) == expected && proof["formatVersion"] === 1 && proof["scope"] == "julia-lld-repackaging-verification" || error("Unsupported repackaging proof schema")
    for (source,target) in (("juliaVersion","juliaVersion"),("juliaCommit","juliaCommit"),("platform","platform"))
        proof[source] == current[target] || error("Repackaging proof runtime mismatch")
    end
    for field in ("componentUUID","metadataSha256","archiveSha256","artifactFile","sdkFile","sdkSha256")
        proof[field] == binding[field] || error("Repackaging proof binding mismatch")
    end
    binding["componentUUID"] == "d55e3150-da41-5e91-b323-ecfd1eec6109" && binding["artifact"] == "LLD" &&
        binding["tags"] == Dict("llvm_version"=>"20") && binding["sdkFile"] == "libexec/julia/lld" &&
        binding["artifactFile"] == "tools/lld" || error("Unsupported SDK repackaging product")
    proof["tool"] == Dict("version"=>"0.17.2","sourceUrl"=>"https://github.com/NixOS/patchelf/releases/download/0.17.2/patchelf-0.17.2.tar.bz2",
        "sourceSha512"=>"8277adf95513f88fb190536a38bdfdf438a4cc7685d8a130bdffbe064441f0f25095b6c83bbb190133e1a138963776d15b46c247dd2f1a073a1bfe1d1dbdd503") &&
        proof["operation"] == ["patchelf","--set-rpath","\$ORIGIN/../../lib/julia"] || error("Unsupported SDK repackaging operation/tool")
    for field in ("sdkImageId","builderImageId")
        proof[field] isa AbstractString && occursin(r"\Asha256:[a-f0-9]{64}\z",proof[field]) || error("Invalid proof image identity")
    end
    proof["artifactSha256"] isa AbstractString && occursin(r"\A[a-f0-9]{64}\z",proof["artifactSha256"]) &&
        proof["artifactSha256"] != binding["sdkSha256"] && proof["sameBytesAfterRepackaging"] === true &&
        proof["reproducedSha256"] == binding["sdkSha256"] && proof["sdkBytes"] isa Integer && !(proof["sdkBytes"] isa Bool) &&
        proof["sdkBytes"] > 0 && proof["reproducedBytes"] == proof["sdkBytes"] || error("Invalid reproduced SDK identity")
    any(row->row["file"] == binding["sdkFile"] && row["sha256"] == binding["sdkSha256"] && row["bytes"] == proof["sdkBytes"],get(current,"executables",[])) || error("Repackaging proof executable changed")
    Dict("file"=>reference["file"],"sha256"=>reference["sha256"],"evidence"=>proof)
end

function verify_bound_comparison(root, binding, current, artifact)
    artifact["archiveSha256"] == binding["archiveSha256"] || error("Bound archive identity changed")
    if haskey(binding,"repackagingProof")
        proof = repackaging_proof(root,binding,current)["evidence"]
        artifact["archiveUrl"] == proof["archiveUrl"] && any(row->row["sdkFile"] == binding["sdkFile"] &&
            row["archivePath"] == binding["artifactFile"] && row["sdkSha256"] == binding["sdkSha256"] &&
            row["artifactSha256"] == proof["artifactSha256"] && row["sameBytes"] === false, artifact["libraryComparisons"]) || error("Repackaging proof lacks matching original artifact comparison")
    else
        any(row->row["sdkFile"] == binding["sdkFile"] && row["archivePath"] == binding["artifactFile"] &&
            row["sdkSha256"] == row["artifactSha256"] == binding["sdkSha256"] && row["sameBytes"],
            artifact["libraryComparisons"]) || error("Bound archive lacks byte-identical SDK library evidence")
    end
    nothing
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

function sdk_data_references(config, platform)
    references = get(config,"sdkDataSources",[])
    references isa AbstractVector && length(references) <= 64 || error("Invalid SDK data source references")
    seen = Set{Tuple{String,String}}()
    for reference in references
        reference isa AbstractDict && Set(keys(reference)) == Set(["runtimePlatform","file","sha256"]) || error("Invalid SDK data source reference")
        relative = relative_file(reference["file"])
        startswith(relative,"data/") && occursin(r"\A[a-f0-9]{64}\z",reference["sha256"]) || error("Invalid SDK data source identity")
        triplet = reference["runtimePlatform"]
        triplet isa AbstractString && sizeof(triplet) <= 200 && occursin(r"\A[a-z0-9][a-z0-9_.+\-]*\z",triplet) && occursin('-',triplet) && !endswith(triplet,".") || error("Invalid SDK data source platform")
        identity = (triplet,relative)
        identity in seen && error("Duplicate SDK data source reference")
        push!(seen,identity)
    end
    filter(row->row["runtimePlatform"] == platform,references)
end

function provenance_bytes(root, relative, expected; blob=nothing)
    file = checked_file(root,relative)
    0 < filesize(file) <= 65536 && file_digest(file) == expected || error("SDK data provenance checksum/size mismatch")
    bytes = read(file)
    blob === nothing || bytes2hex(sha1(vcat(collect(codeunits("blob $(length(bytes))\0")),bytes))) == blob || error("SDK data provenance Git blob mismatch")
    bytes
end

function verify_sdk_data_sources(current, config, index, root, notices)
    references = sdk_data_references(config,current["platform"])
    get(index,"sdkDataSources",[]) == references || error("SDK data source index mismatch")
    rows = []
    seen = Set{String}()
    required = Set(["formatVersion","scope","originKind","runtimePlatform","juliaVersion","juliaCommit","componentName","componentUUID","componentVersion",
        "projectSha256","stubSha256","sdkFile","sdkSha256","sdkSha512","sdkBytes","archiveUrl","archiveSha256","archiveBytes","artifactFile","artifactSha256",
        "artifactSha512","artifactBytes","metadataFile","metadataUrl","metadataSha256","metadataGitBlobSha1","artifactTreeSha1","checksumFile","checksumUrl",
        "checksumSha256","checksumGitBlobSha1","licenseExpression","noticeFiles"])
    for reference in references
        record = JSON.parse(String(provenance_bytes(root,reference["file"],reference["sha256"])),Dict{String,Any})
        Set(keys(record)) == required && record["formatVersion"] === 1 && record["scope"] == "julia-sdk-reviewed-data-source" &&
            record["originKind"] == "reviewed-upstream-jll" || error("Unsupported SDK data source schema")
        record["runtimePlatform"] == current["platform"] && record["juliaVersion"] == current["juliaVersion"] && record["juliaCommit"] == current["juliaCommit"] || error("SDK data source runtime changed")
        record["componentUUID"] == "14a3606d-f60d-562e-9121-12d972cd8159" && record["componentName"] == "MozillaCACerts_jll" &&
            record["sdkFile"] == "share/julia/cert.pem" && record["artifactFile"] == "share/cacert.pem" && record["licenseExpression"] == "MPL-2.0" || error("Unsupported SDK data source product")
        record["componentUUID"] in seen && error("Duplicate SDK data product source")
        push!(seen,record["componentUUID"])
        any(product->all(product[key] == record[key] for key in ("componentName","componentUUID","componentVersion","projectSha256","stubSha256","sdkFile","sdkSha256","sdkSha512","sdkBytes")),
            get(current,"dataProducts",[])) || error("SDK data product changed")
        for key in ("sdkSha256","artifactSha256","archiveSha256","metadataSha256","checksumSha256","projectSha256","stubSha256")
            record[key] isa AbstractString && occursin(r"\A[a-f0-9]{64}\z",record[key]) || error("Invalid SDK data checksum")
        end
        for key in ("sdkSha512","artifactSha512")
            record[key] isa AbstractString && occursin(r"\A[a-f0-9]{128}\z",record[key]) || error("Invalid SDK data SHA-512")
        end
        for key in ("metadataGitBlobSha1","checksumGitBlobSha1","artifactTreeSha1")
            record[key] isa AbstractString && occursin(r"\A[a-f0-9]{40}\z",record[key]) || error("Invalid SDK data Git identity")
        end
        for key in ("sdkBytes","artifactBytes","archiveBytes")
            record[key] isa Integer && !(record[key] isa Bool) && record[key] > 0 || error("Invalid SDK data source size")
        end
        record["sdkSha256"] == record["artifactSha256"] && record["sdkSha512"] == record["artifactSha512"] &&
            record["sdkBytes"] == record["artifactBytes"] || error("SDK data differs from reviewed archive product")
        for key in ("metadataFile","checksumFile")
            startswith(relative_file(record[key]),"data/") || error("SDK data provenance path mismatch")
        end
        occursin(r"\Ahttps://raw.githubusercontent.com/JuliaBinaryWrappers/MozillaCACerts_jll.jl/[a-f0-9]{40}/Artifacts.toml\z",record["metadataUrl"]) || error("Unreviewed SDK data metadata URL")
        metadata = TOML.parse(String(provenance_bytes(root,record["metadataFile"],record["metadataSha256"];blob=record["metadataGitBlobSha1"])))["MozillaCACerts"]
        metadata["git-tree-sha1"] == record["artifactTreeSha1"] && any(row->row["url"] == record["archiveUrl"] && row["sha256"] == record["archiveSha256"],metadata["download"]) || error("SDK data archive is not declared by reviewed upstream metadata")
        date = replace(record["componentVersion"],'.'=>'-')
        record["checksumUrl"] == "https://raw.githubusercontent.com/JuliaLang/julia/$(current["juliaCommit"])/deps/checksums/cacert-$date.pem/sha512" || error("Unreviewed SDK data build checksum URL")
        strip(String(provenance_bytes(root,record["checksumFile"],record["checksumSha256"];blob=record["checksumGitBlobSha1"]))) == record["sdkSha512"] || error("SDK CA data differs from Julia build checksum")
        record["noticeFiles"] isa AbstractVector && !isempty(record["noticeFiles"]) || error("SDK data license notices missing")
        for notice in record["noticeFiles"]
            path = relative_file(notice["archivePath"])
            startswith(path,"share/licenses/MozillaCACerts/") && notice["file"] == "artifacts/$(record["archiveSha256"])/$path" || error("SDK data notice source mismatch")
            capture_text(root,notice["file"],notices;expected=notice["sha256"],expected_bytes=notice["bytes"])
        end
        push!(rows,Dict("file"=>reference["file"],"sha256"=>reference["sha256"],"source"=>record,"sameBytes"=>true))
    end
    rows
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
    libraries = Dict(row["file"]=>row for row in vcat(current["libraries"],get(current,"executables",[])))
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
                verify_bound_comparison(directory,binding,current,artifact)
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
    data_sources = verify_sdk_data_sources(current,config,index,source_directory,notices)
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
    proofs = [repackaging_proof(source_directory,artifact["platformBinding"],current) for component in components for artifact in component["artifacts"]
        if get(artifact,"platformBinding",nothing) !== nothing && haskey(artifact["platformBinding"],"repackagingProof")]
    selection_diagnostics = [Dict("component"=>component["name"],"uuid"=>component["uuid"],"artifact"=>artifact["name"],"unboundPlatformTags"=>artifact["unboundPlatformTags"])
        for component in current["components"] for artifact in component["artifacts"] if !isempty(artifact["unboundPlatformTags"])]
    gaps = []
    for component in components
        if component["metadataSha256"] === nothing
            push!(gaps,Dict("name"=>component["name"],"version"=>component["version"],"reason"=>"no_artifact_metadata",
                "reviewedDataSource"=>any(row->row["source"]["componentUUID"] == component["uuid"],data_sources)))
        end
        for artifact in component["artifacts"]
            isempty(get(artifact,"noticeFiles",[])) && push!(gaps,Dict("name"=>component["name"],"version"=>component["version"],"reason"=>artifact["status"]))
        end
    end
    read(project_file) == original_project && read(manifest_file) == original_manifest || error("Julia project lock inputs changed during inventory")
    Dict("formatVersion"=>1,"scope"=>"julia-locked-environment-and-sdk-notices", "capturedUtc"=>string(now(UTC))*"Z",
        "noticeSourceIndex"=>Dict("file"=>index_relative,"sha256"=>file_digest(index_file)),
        "artifactSelectionDiagnostics"=>selection_diagnostics,
        "reviewedRepackagingProofs"=>proofs,
        "reviewedSdkDataSources"=>data_sources,"sdkDataProducts"=>get(current,"dataProducts",[]),
        "appliedArtifactPlatformBindings"=>[artifact["platformBinding"] for component in current["components"] for artifact in component["artifacts"] if artifact["platformBinding"] !== nothing],
        "runtime"=>Dict("version"=>string(VERSION),"commit"=>current["juliaCommit"],"platform"=>current["platform"],"noticeFiles"=>runtime_files),
        "project"=>Dict("name"=>project["name"],"uuid"=>project["uuid"],"version"=>project["version"],"noticeFiles"=>[own]),
        "projectSha256"=>digest(original_project),"manifestSha256"=>digest(original_manifest),
        "sourceIndexSha256"=>file_digest(index_file),"packages"=>records,"sdkComponents"=>components,
        "sdkLibraries"=>current["libraries"],"sdkExecutables"=>get(current,"executables",[]),
        "sdkExecutableCoverage"=>executable_coverage(get(current,"executables",[]),comparisons,proofs),"packageCount"=>length(records),
        "sdkNoticeGaps"=>gaps,"binaryComparisons"=>Dict("total"=>length(comparisons),"sameBytes"=>count(row->row["sameBytes"],comparisons),"differentBytes"=>count(row->!row["sameBytes"],comparisons)),
        "incompletePackageEvidenceCount"=>count(row->row["incompleteEvidence"],records),"notices"=>notices,
        "limitations"=>[
            "A runtime third-party index is not a full per-source-file license attribution review",
            "SDK artifact notices are taken from the declared checksum-pinned upstream archives; binary comparisons are reported separately",
            "A differing SDK library is not treated as a byte-identical artifact product; build-variant and provenance differences require review",
            "Unbound artifact variant tags are explicit; direct bindings require byte-identical products, repackaged products require a separately reviewed reproduction proof",
            "No-artifact components, operating-system packages and other build variants require separate review",
            "Executable coverage currently inventories SDK LLD paths only; not_compared is not a provenance confirmation",
            "Bundled CA data provenance does not identify environment-overridden trust stores or validate certificate trust",
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
