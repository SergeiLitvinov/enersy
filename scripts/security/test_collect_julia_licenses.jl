using Test, SHA, JSON, Pkg
include("collect_julia_licenses.jl")
const JN = JuliaNoticeInventory
const NOTICE_TEST_SOURCES = isempty(ARGS) ? joinpath(@__DIR__,"julia-notices") : only(ARGS)
isdir(NOTICE_TEST_SOURCES) || error("Notice test source directory not found: $(NOTICE_TEST_SOURCES)")

@testset "Bundled SDK data fingerprints do not execute certificate stubs" begin
    mktempdir() do root
        stdlib = joinpath(root,"stdlib")
        @test isempty(JN.sdk_data_products(root,stdlib))
        directory = joinpath(stdlib,"MozillaCACerts_jll")
        mkpath(joinpath(directory,"src"))
        write(joinpath(directory,"Project.toml"),"name = \"MozillaCACerts_jll\"\nuuid = \"14a3606d-f60d-562e-9121-12d972cd8159\"\nversion = \"2026.08.13\"\n")
        write(joinpath(directory,"src","MozillaCACerts_jll.jl"),"error(\"must never execute\")")
        mkpath(joinpath(root,"share","julia"))
        file = joinpath(root,"share","julia","cert.pem")
        data = "fingerprint fixture; certificate validity is a separate concern\n"
        write(file,data)
        row = only(JN.sdk_data_products(root,stdlib))
        @test row["sdkSha256"] == bytes2hex(sha256(data))
        @test row["sdkSha512"] == bytes2hex(sha512(data))
        @test row["sdkBytes"] == sizeof(data)
        @test row["sdkFile"] == "share/julia/cert.pem"
        write(file,"")
        @test_throws ErrorException JN.sdk_data_products(root,stdlib)
        rm(file)
        mktempdir() do outside
            write(joinpath(outside,"cert.pem"),data)
            symlink(joinpath(outside,"cert.pem"),file)
            @test_throws ErrorException JN.sdk_data_products(root,stdlib)
        end
    end
end

@testset "Mozilla CA data uses reviewed upstream provenance, not SDK artifact metadata" begin
    sources = NOTICE_TEST_SOURCES
    references = JSON.parsefile(joinpath(@__DIR__,"julia-notice-sources.json"))["sdkDataSources"]
    @test !isempty(references)
    for reference in references
        record = JSON.parsefile(joinpath(sources,reference["file"]),Dict{String,Any})
        product = Dict(key=>record[key] for key in ("componentName","componentUUID","componentVersion","projectSha256","stubSha256","sdkFile","sdkSha256","sdkSha512","sdkBytes"))
        current = Dict("platform"=>record["runtimePlatform"],"juliaVersion"=>record["juliaVersion"],"juliaCommit"=>record["juliaCommit"],"dataProducts"=>[product])
        config = Dict("sdkDataSources"=>[reference]); index = deepcopy(config)
        notices = Dict{String,String}()
        rows = JN.verify_sdk_data_sources(current,config,index,sources,notices)
        @test length(rows) == 1
        @test only(rows)["sameBytes"] === true
        @test haskey(notices,only(record["noticeFiles"])["sha256"])
        @test JN.sdk_data_references(config,"other-platform") == []
        @test isempty(JN.verify_sdk_data_sources(current,Dict(),Dict(),sources,Dict{String,String}()))
        @test_throws ErrorException JN.verify_sdk_data_sources(current,config,Dict(),sources,Dict{String,String}())
        @test_throws ErrorException JN.sdk_data_references(Dict("sdkDataSources"=>[reference,reference]),current["platform"])
        for key in ("componentVersion","projectSha256","stubSha256","sdkSha256","sdkSha512","sdkBytes")
            changed = deepcopy(current); changed["dataProducts"][1][key] = "wrong"
            @test_throws ErrorException JN.verify_sdk_data_sources(changed,config,index,sources,Dict{String,String}())
        end
        mktempdir() do root
            for relative in [reference["file"],record["metadataFile"],record["checksumFile"],only(record["noticeFiles"])["file"]]
                target = joinpath(root,relative); mkpath(dirname(target)); cp(joinpath(sources,relative),target)
            end
            file = joinpath(root,reference["file"])
            write(file,"changed")
            @test_throws ErrorException JN.verify_sdk_data_sources(current,config,index,root,Dict{String,String}())
            for (key,value) in (("formatVersion",true),("scope","wrong"),("originKind","sdk-artifact"),("juliaCommit","0"^40),
                    ("componentUUID","00000000-0000-0000-0000-000000000000"),("artifactSha256","0"^64),("artifactSha512","0"^128),
                    ("artifactBytes",1),("archiveUrl","https://example.invalid/other"),("artifactTreeSha1","0"^40),
                    ("metadataUrl","https://example.invalid/Artifacts.toml"),("checksumUrl","https://example.invalid/sha512"),
                    ("metadataGitBlobSha1","0"^40),("checksumGitBlobSha1","0"^40),("metadataGitBlobSha1",nothing),("checksumGitBlobSha1",nothing),
                    ("artifactBytes",188900.0),("licenseExpression","MIT"),("noticeFiles",[]),("extra","unsupported"))
                changed = deepcopy(record); changed[key] = value
                write(file,JSON.json(changed))
                changed_reference = deepcopy(reference); changed_reference["sha256"] = JN.file_digest(file)
                settings = Dict("sdkDataSources"=>[changed_reference])
                @test_throws ErrorException JN.verify_sdk_data_sources(current,settings,settings,root,Dict{String,String}())
            end
            cp(joinpath(sources,reference["file"]),file;force=true)
            write(joinpath(root,only(record["noticeFiles"])["file"]),"Changed license")
            @test_throws ErrorException JN.verify_sdk_data_sources(current,config,index,root,Dict{String,String}())
        end
    end
end

@testset "Reviewed LLD repackaging preserves original byte mismatch" begin
    sources = NOTICE_TEST_SOURCES
    config = JSON.parsefile(joinpath(@__DIR__,"julia-notice-sources.json"),Dict{String,Any})
    bindings = filter(row->haskey(row,"repackagingProof"),config["artifactPlatformBindings"])
    @test !isempty(bindings)
    for binding in bindings
        original = JSON.parsefile(joinpath(sources,binding["repackagingProof"]["file"]),Dict{String,Any})
        current = Dict("juliaVersion"=>original["juliaVersion"],"juliaCommit"=>original["juliaCommit"],"platform"=>original["platform"],
            "executables"=>[Dict("file"=>original["sdkFile"],"sha256"=>original["sdkSha256"],"bytes"=>original["sdkBytes"],"component"=>"LLD_jll")])
        comparison = Dict("sdkFile"=>binding["sdkFile"],"archivePath"=>binding["artifactFile"],"sdkSha256"=>binding["sdkSha256"],
            "artifactSha256"=>original["artifactSha256"],"sameBytes"=>false)
        artifact = Dict("archiveSha256"=>binding["archiveSha256"],"archiveUrl"=>original["archiveUrl"],"libraryComparisons"=>[comparison])
        proof = JN.repackaging_proof(sources,binding,current)
        @test proof["evidence"] == original
        @test JN.verify_bound_comparison(sources,binding,current,artifact) === nothing
        @test only(JN.executable_coverage(current["executables"],[comparison],[proof]))["comparisonStatus"] == "reviewed_repackaging"
        @test comparison["sameBytes"] === false
        for (key,value) in (("archiveUrl","https://example.invalid/other"),("archiveSha256","0"^64),("libraryComparisons",[]))
            changed = deepcopy(artifact); changed[key] = value
            @test_throws ErrorException JN.verify_bound_comparison(sources,binding,current,changed)
        end
        for (key,value) in (("sdkFile","bin/lld"),("archivePath","bin/lld"),("artifactSha256","0"^64),("sameBytes",true))
            changed = deepcopy(artifact); changed["libraryComparisons"][1][key] = value
            @test_throws ErrorException JN.verify_bound_comparison(sources,binding,current,changed)
        end
        unreviewed = deepcopy(binding); delete!(unreviewed,"repackagingProof")
        @test_throws ErrorException JN.verify_bound_comparison(sources,unreviewed,current,artifact)
        changed_current = deepcopy(current); changed_current["executables"][1]["bytes"] += 1
        @test_throws ErrorException JN.repackaging_proof(sources,binding,changed_current)
        mktempdir() do root
            file = joinpath(root,binding["repackagingProof"]["file"])
            mkpath(dirname(file))
            write(file,"changed")
            @test_throws ErrorException JN.repackaging_proof(root,binding,current)
            for (key,value) in (("formatVersion",true),("scope","wrong"),("juliaCommit","0"^40),("componentUUID","00000000-0000-0000-0000-000000000000"),
                    ("sdkSha256","0"^64),("reproducedSha256","0"^64),("reproducedBytes",0),("sdkBytes",true),
                    ("sameBytesAfterRepackaging",false),("operation",["patchelf","--add-rpath","wrong"]),("tool",Dict()),
                    ("sdkImageId","latest"),("extra","not allowed"))
                changed = deepcopy(original); changed[key] = value
                write(file,JSON.json(changed))
                changed_binding = deepcopy(binding); changed_binding["repackagingProof"]["sha256"] = JN.file_digest(file)
                @test_throws ErrorException JN.repackaging_proof(root,changed_binding,current)
            end
        end
    end
end

@testset "SDK LLD executable coverage never executes products or searches PATH" begin
    mktempdir() do root
        @test isempty(JN.sdk_executables(root))
        mkpath(joinpath(root,"libexec","julia"))
        product = joinpath(root,"libexec","julia","lld")
        payload = "#!/bin/sh\nexit 99 # inventory must only read this file\n"
        write(product,payload)
        chmod(product,0o755)
        rows = JN.sdk_executables(root)
        @test length(rows) == 1
        row = only(rows)
        @test row.file == "libexec/julia/lld"
        @test row.bytes == sizeof(payload)
        @test row.sha256 == bytes2hex(sha256(payload))
        @test row.component == "LLD_jll"
        json_rows = JSON.parse(JSON.json(rows),Vector{Dict{String,Any}})
        comparison = Dict("sdkFile"=>row.file,"sdkSha256"=>row.sha256,"sameBytes"=>true)
        @test only(JN.executable_coverage(json_rows,[]))["comparisonStatus"] == "not_compared"
        @test only(JN.executable_coverage(json_rows,[comparison]))["comparisonStatus"] == "byte_identical"
        different = copy(comparison); different["sameBytes"] = false
        @test only(JN.executable_coverage(json_rows,[different]))["comparisonStatus"] == "different_bytes"
        stale = copy(comparison); stale["sdkSha256"] = "0"^64
        @test only(JN.executable_coverage(json_rows,[stale]))["comparisonStatus"] == "not_compared"
        mkpath(joinpath(root,"tools"))
        symlink(product,joinpath(root,"tools","lld"))
        @test length(JN.sdk_executables(root)) == 2
        rm(product)
        @test_throws Exception JN.sdk_executables(root)
    end
    mktempdir() do root
        mktempdir() do outside
            write(joinpath(outside,"lld"),"external executable")
            mkpath(joinpath(root,"bin"))
            symlink(joinpath(outside,"lld"),joinpath(root,"bin","lld"))
            @test_throws ErrorException JN.sdk_executables(root)
        end
    end
    mktempdir() do root
        mkpath(joinpath(root,"bin","lld"))
        @test_throws ErrorException JN.sdk_executables(root)
    end
end

@testset "Explicit artifact bindings are scoped to SDK metadata and library bytes" begin
    platform = Base.BinaryPlatforms.Platform("x86_64","linux";libc="glibc")
    uuid = "11111111-2222-3333-4444-555555555555"
    binding = Dict("runtimePlatform"=>Base.BinaryPlatforms.triplet(platform),"componentUUID"=>uuid,"componentVersion"=>"1.0.0+0",
        "metadataSha256"=>"a"^64,"artifact"=>"Demo","tags"=>Dict("llvm_version"=>"20"),"archiveSha256"=>"b"^64,
        "sdkFile"=>"lib/julia/demo.so","artifactFile"=>"lib/demo.so","sdkSha256"=>"c"^64)
    config = Dict("artifactPlatformBindings"=>[binding])
    @test JN.reviewed_platform_bindings(config,platform) == [binding]
    @test isempty(JN.reviewed_platform_bindings(nothing,platform))
    @test isempty(JN.reviewed_platform_bindings(config,Base.BinaryPlatforms.Platform("aarch64","linux";libc="glibc")))
    @test_throws ErrorException JN.reviewed_platform_bindings(Dict("artifactPlatformBindings"=>[binding,binding]),platform)
    for (field,value) in (("metadataSha256","bad"),("sdkFile","../private"),("runtimePlatform","invalid/platform"),("tags",Dict("llvm_version"=>"20\n")))
        bad = deepcopy(binding)
        bad[field] = value
        @test_throws ErrorException JN.reviewed_platform_bindings(Dict("artifactPlatformBindings"=>[bad]),platform)
    end
    bad = deepcopy(binding); bad["extra"] = "not allowed"
    @test_throws ErrorException JN.reviewed_platform_bindings(Dict("artifactPlatformBindings"=>[bad]),platform)
    for reference in (Dict(),Dict("file"=>"../private","sha256"=>"a"^64),
            Dict("file"=>"packaging/proof.json","sha256"=>"bad"),Dict("file"=>"packaging/proof.json","sha256"=>"a"^64,"extra"=>"unsupported"))
        bad = deepcopy(binding); bad["repackagingProof"] = reference
        @test_throws ErrorException JN.reviewed_platform_bindings(Dict("artifactPlatformBindings"=>[bad]),platform)
    end
    component = Dict("uuid"=>uuid,"version"=>"1.0.0+0")
    libraries = [(;file="lib/julia/demo.so",sha256="c"^64)]
    qualified = JN.bound_artifact_platform(platform,binding,component,"a"^64,libraries)
    @test Base.BinaryPlatforms.tags(qualified)["llvm_version"] == "20"
    @test !haskey(Base.BinaryPlatforms.tags(platform),"llvm_version")
    @test JN.bound_artifact_platform(platform,nothing,component,"a"^64,libraries) === platform
    @test_throws ErrorException JN.bound_artifact_platform(platform,binding,component,"d"^64,libraries)
    @test_throws ErrorException JN.bound_artifact_platform(platform,binding,Dict("uuid"=>uuid,"version"=>"2.0.0"),"a"^64,libraries)
    @test_throws ErrorException JN.bound_artifact_platform(platform,binding,component,"a"^64,[(;file="lib/julia/demo.so",sha256="d"^64)])
    @test_throws ErrorException JN.bound_artifact_platform(qualified,binding,component,"a"^64,libraries)
    @test_throws ErrorException JN.facts(Dict("juliaVersion"=>"wrong","juliaCommit"=>"wrong"))
    mktemp() do path, io
        write(io,"{\"juliaVersion\":\"wrong\",\"juliaCommit\":\"wrong\"}")
        flush(io)
        exception = try JN.main(["--facts",path]); nothing catch err; err end
        @test exception isa ErrorException
        @test occursin("Runtime differs from reviewed binding configuration",sprint(showerror,exception))
        @test_throws ErrorException JN.main(["--facts",path,"unexpected"])
    end
end

@testset "Unconstrained artifact variant tags remain visible" begin
    platform = Base.BinaryPlatforms.Platform("x86_64","linux";libc="glibc")
    selected = Dict("arch"=>"x86_64","os"=>"linux","libc"=>"glibc","llvm_version"=>"20.asserts",
        "git-tree-sha1"=>"a"^40,"download"=>[Dict("url"=>"https://example.invalid/llvm.tar.gz")],"lazy"=>true)
    @test JN.unbound_artifact_tags(platform,selected) == Dict("llvm_version"=>"20.asserts")
    @test isempty(JN.unbound_artifact_tags(platform,nothing))
    qualified = deepcopy(platform)
    qualified["llvm_version"] = "20.asserts"
    @test isempty(JN.unbound_artifact_tags(qualified,selected))
    @test !haskey(Base.BinaryPlatforms.tags(platform),"llvm_version")
    mktempdir() do directory
        metadata = joinpath(directory,"Artifacts.toml")
        write(metadata,"""
        [[Demo]]
        arch = "x86_64"
        os = "linux"
        libc = "glibc"
        llvm_version = "20"
        git-tree-sha1 = "$("a"^40)"
        [[Demo.download]]
        url = "https://example.invalid/ordinary.tar.gz"
        sha256 = "$("a"^64)"
        [[Demo]]
        arch = "x86_64"
        os = "linux"
        libc = "glibc"
        llvm_version = "20.asserts"
        git-tree-sha1 = "$("b"^40)"
        [[Demo.download]]
        url = "https://example.invalid/assertions.tar.gz"
        sha256 = "$("b"^64)"
        """)
        default = Pkg.Artifacts.artifact_meta("Demo",metadata;platform)
        @test haskey(JN.unbound_artifact_tags(platform,default),"llvm_version")
        qualified["llvm_version"] = "20"
        ordinary = Pkg.Artifacts.artifact_meta("Demo",metadata;platform=qualified)
        @test ordinary["git-tree-sha1"] == "a"^40
        @test isempty(JN.unbound_artifact_tags(qualified,ordinary))
        qualified["llvm_version"] = "20.asserts"
        assertions = Pkg.Artifacts.artifact_meta("Demo",metadata;platform=qualified)
        @test assertions["git-tree-sha1"] == "b"^40
        @test isempty(JN.unbound_artifact_tags(qualified,assertions))
    end
end

@testset "Notice bytes, bounds and path isolation" begin
    mktempdir() do root
        bytes = collect(codeunits("\ufeffCopyright © Авторы\r\nPermission and disclaimer\r\n"))
        write(joinpath(root,"LICENSE.md"),bytes)
        write(joinpath(root,"notice.jl"),"error(\"must not execute\")")
        notices = Dict{String,String}()
        files = JN.root_notices(root,notices)
        @test length(files) == 1
        sha = bytes2hex(sha256(bytes))
        @test only(files)["sha256"] == sha
        @test collect(codeunits(notices[sha])) == bytes
        @test JSON.parse(JSON.json(notices),Dict{String,String})[sha] == String(copy(bytes))
        @test_throws ErrorException JN.capture_text(root,"LICENSE.md",notices;expected="0"^64)
        for bad in ("../private", "/private", "C:/private", "a\\b", "a//b")
            @test_throws ErrorException JN.relative_file(bad)
        end
        for invalid in (UInt8[], UInt8[0xff], fill(UInt8('a'),4*1024*1024+1))
            write(joinpath(root,"LICENSE.md"),invalid)
            @test_throws ErrorException JN.capture_text(root,"LICENSE.md",notices)
        end
    end
    mktempdir() do root
        mktempdir() do outside
            write(joinpath(outside,"private.txt"),"not a package notice")
            symlink(joinpath(outside,"private.txt"),joinpath(root,"LICENSE"))
            @test_throws ErrorException JN.root_notices(root,Dict{String,String}())
        end
    end
end

@testset "Package notice identity is bound to the locked source tree" begin
    mktempdir() do root
        packages = joinpath(root,"packages")
        directory = joinpath(packages,"Example")
        mkpath(directory)
        uuid = "11111111-2222-3333-4444-555555555555"
        project = "name = \"Example\"\nuuid = \"$uuid\"\nversion = \"1.2.3\"\n"
        write(joinpath(directory,"Project.toml"),project)
        write(joinpath(directory,"LICENSE"),"Copyright and permission")
        tree = bytes2hex(Pkg.GitTools.tree_hash(directory))
        entry = Dict("uuid"=>uuid,"version"=>"1.2.3","git-tree-sha1"=>tree)
        info = (;name="Example",version=v"1.2.3",source=directory,tree_hash=tree)
        record() = JN.package_notice_record("Example",entry,info,Dict{String,String}();stdlib=joinpath(root,"stdlib"),package_roots=[packages])
        result = record()
        @test result["sourceTreeSha1"] == tree
        @test result["noticeStatus"] == "package_notice_files"
        write(joinpath(directory,"LICENSE"),"Changed attribution")
        @test_throws ErrorException record()
        write(joinpath(directory,"LICENSE"),"Copyright and permission")
        @test_throws ErrorException JN.package_notice_record("WrongName",entry,info,Dict{String,String}();stdlib=joinpath(root,"stdlib"),package_roots=[packages])
        @test_throws ErrorException JN.package_notice_record("Example",entry,info,Dict{String,String}();stdlib=joinpath(root,"stdlib"),package_roots=[joinpath(root,"unapproved")])
        write(joinpath(directory,"Project.toml"),replace(project,uuid=>"00000000-0000-0000-0000-000000000000"))
        tree2 = bytes2hex(Pkg.GitTools.tree_hash(directory))
        entry["git-tree-sha1"] = tree2
        info2 = merge(info,(;tree_hash=tree2))
        @test_throws ErrorException JN.package_notice_record("Example",entry,info2,Dict{String,String}();stdlib=joinpath(root,"stdlib"),package_roots=[packages])
    end
end

@testset "Platform-specific notice indexes preserve the root and fail closed" begin
    mktempdir() do root
        original = "{\"platform\":\"x86_64-linux-gnu\"}\n"
        write(joinpath(root,"index.json"),original)
        @test JN.notice_index_relative(root,"x86_64-linux-gnu") == "index.json"
        scoped = joinpath(root,"platforms","aarch64-linux-gnu")
        mkpath(scoped)
        @test_throws Base.IOError JN.notice_index_relative(root,"aarch64-linux-gnu")
        write(joinpath(scoped,"index.json"),"{\"platform\":\"aarch64-linux-gnu\"}\n")
        @test JN.notice_index_relative(root,"aarch64-linux-gnu") == "platforms/aarch64-linux-gnu/index.json"
        @test read(joinpath(root,"index.json"),String) == original
        for platform in (nothing,"","..","NUL","host","../host-linux","host/linux","host\\linux","host-linux\n","host:linux","host-linux.","a-"*"b"^200)
            @test_throws ErrorException JN.notice_index_relative(root,platform)
        end
        rm(joinpath(scoped,"index.json"))
        mktempdir() do outside
            write(joinpath(outside,"private-index.json"),"outside")
            symlink(joinpath(outside,"private-index.json"),joinpath(scoped,"index.json"))
            @test_throws ErrorException JN.notice_index_relative(root,"aarch64-linux-gnu")
        end
    end
end

@testset "SDK supplements require reviewed runtime, artifact and notice identities" begin
    mktempdir() do root
        runtime = joinpath(root,"runtime")
        mkpath(runtime)
        thirdparty = "test content\n"
        write(joinpath(runtime,"THIRDPARTY.md"),thirdparty)
        blob = "d670460b4b4aece5915caf5c68d12f560a9fe3e4"
        archive_sha = "d"^64
        relative = "artifacts/$archive_sha/share/licenses/Demo/LICENSE"
        mkpath(dirname(joinpath(root,relative)))
        text = "Permission and disclaimer"
        write(joinpath(root,relative),text)
        uuid = "11111111-2222-3333-4444-555555555555"
        url = "https://github.com/JuliaBinaryWrappers/Demo_jll.jl/releases/download/1/demo.tar.gz"
        declaration = Dict("git-tree-sha1"=>"c"^40,"download"=>[Dict("url"=>url,"sha256"=>archive_sha)])
        component = Dict("name"=>"Demo_jll","uuid"=>uuid,"version"=>"1.0.0+0","metadataSha256"=>"b"^64,
            "artifacts"=>[Dict("name"=>"Demo","selected"=>declaration)])
        current = Dict("juliaVersion"=>"1.13.2","juliaCommit"=>"a"^40,"platform"=>"fixture-platform","components"=>[component],"libraries"=>[])
        config = Dict("juliaVersion"=>"1.13.2","juliaCommit"=>"a"^40,"thirdParty"=>Dict("url"=>"https://example.invalid/THIRDPARTY.md","gitBlobSha1"=>blob))
        artifact = Dict("name"=>"Demo","treeSha1"=>"c"^40,"archiveUrl"=>url,"archiveSha256"=>archive_sha,
            "noticeFiles"=>[Dict("archivePath"=>"share/licenses/Demo/LICENSE","file"=>relative,"sha256"=>JN.digest(codeunits(text)),"bytes"=>sizeof(text))],
            "libraryComparisons"=>[])
        index = Dict("formatVersion"=>1,"scope"=>"julia-sdk-reviewed-notice-sources","juliaVersion"=>"1.13.2","juliaCommit"=>"a"^40,"platform"=>"fixture-platform",
            "runtimeThirdParty"=>Dict("file"=>"runtime/THIRDPARTY.md","sha256"=>JN.digest(codeunits(thirdparty)),"bytes"=>sizeof(thirdparty),"url"=>config["thirdParty"]["url"],"gitBlobSha1"=>blob),
            "components"=>[Dict("name"=>"Demo_jll","uuid"=>uuid,"version"=>"1.0.0+0","metadataSha256"=>"b"^64,"artifacts"=>[artifact])])
        check(value=index) = JN.verify_supplements(current,config,value,root,Dict{String,String}())
        third, rows = check()
        @test third["sha256"] == JN.digest(codeunits(thirdparty))
        @test length(rows) == 1
        for field in ("juliaVersion","juliaCommit","platform")
            changed = deepcopy(index)
            changed[field] = "wrong"
            @test_throws ErrorException check(changed)
        end
        changed = deepcopy(index)
        changed["components"][1]["metadataSha256"] = "e"^64
        @test_throws ErrorException check(changed)
        changed = deepcopy(index)
        changed["components"][1]["artifacts"][1]["archiveSha256"] = "e"^64
        @test_throws ErrorException check(changed)
        write(joinpath(root,relative),"Changed notice")
        @test_throws ErrorException check()
        write(joinpath(root,relative),text)
        push!(current["libraries"],Dict("file"=>"lib/julia/demo.so","sha256"=>"1"^64))
        push!(artifact["libraryComparisons"],Dict("sdkFile"=>"lib/julia/demo.so","sdkSha256"=>"2"^64,"artifactSha256"=>"2"^64,"sameBytes"=>true))
        @test_throws ErrorException check()
        current["libraries"] = [Dict("file"=>"lib/julia/demo.so","sha256"=>"f"^64)]
        binding = Dict("runtimePlatform"=>"fixture-platform","componentUUID"=>uuid,"componentVersion"=>"1.0.0+0",
            "metadataSha256"=>"b"^64,"artifact"=>"Demo","tags"=>Dict("llvm_version"=>"20"),
            "archiveSha256"=>archive_sha,"sdkFile"=>"lib/julia/demo.so","artifactFile"=>"lib/demo.so","sdkSha256"=>"f"^64)
        current["components"][1]["artifacts"][1]["platformBinding"] = binding
        artifact["platformBinding"] = deepcopy(binding)
        comparison = Dict("sdkFile"=>"lib/julia/demo.so","archivePath"=>"lib/demo.so","sdkSha256"=>"f"^64,"artifactSha256"=>"f"^64,"sameBytes"=>true)
        artifact["libraryComparisons"] = [comparison]
        @test length(check()[2]) == 1
        delete!(artifact,"platformBinding")
        @test_throws ErrorException check()
        artifact["platformBinding"] = deepcopy(binding)
        artifact["libraryComparisons"] = []
        @test_throws ErrorException check()
        artifact["libraryComparisons"] = [merge(comparison,Dict("artifactSha256"=>"e"^64,"sameBytes"=>false))]
        @test_throws ErrorException check()
        artifact["libraryComparisons"] = [merge(comparison,Dict("archivePath"=>"lib/another.so"))]
        @test_throws ErrorException check()
        artifact["libraryComparisons"] = [comparison]
        current["components"][1]["artifacts"][1]["selected"] = nothing
        artifact["status"] = "no_host_artifact"
        @test_throws ErrorException check()
    end
end
