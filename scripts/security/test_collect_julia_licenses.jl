using Test, SHA, JSON, Pkg
include("collect_julia_licenses.jl")
const JN = JuliaNoticeInventory

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
