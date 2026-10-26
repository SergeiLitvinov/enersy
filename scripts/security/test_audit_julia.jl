using Test, TOML
include("audit_julia.jl")
using .JuliaDependencyAudit: inventory, query_packages

@testset "A newer lock file cannot conceal an older runtime" begin
    @test_throws ErrorException JuliaDependencyAudit.runtime_metadata(Dict("julia_version" => "0.0.1"))
    mismatch = Dict("julia_version" => string(VERSION), "deps" => Dict("Zlib_jll" => [Dict("version" => "0.0.1")]))
    @test_throws ErrorException JuliaDependencyAudit.runtime_metadata(mismatch)
end

const HTTP_PACKAGE = (name="HTTP", uuid="cd3eb016-35fb-5094-929b-558a96fad6f3", version="1.10.16")
const JSON_PACKAGE = (name="JSON", uuid="682c06a0-de6a-54ab-a142-c8b1cf79cde6", version="1.12.2")

@testset "Locked Julia inventory and OSV failures" begin
    fixture = Dict("manifest_format" => "2.0", "deps" => Dict(
        "HTTP" => [Dict("uuid" => HTTP_PACKAGE.uuid, "version" => HTTP_PACKAGE.version)],
        "Sockets" => [Dict("uuid" => "6462fe0b-24de-5631-8697-dd941f90decc")]))
    packages, unversioned, excluded = inventory(fixture)
    @test packages == [HTTP_PACKAGE]
    @test only(unversioned).name == "Sockets"
    @test isempty(excluded)
    newer = deepcopy(fixture)
    newer["manifest_format"] = "2.1"
    newer["deps"]["LocalProject"] = [Dict("uuid" => "fixture-local", "version" => "1.0.0", "path" => ".")]
    newer_packages, _, newer_excluded = inventory(newer)
    @test newer_packages == packages
    @test only(newer_excluded).name == "LocalProject"
    @test_throws ErrorException inventory(Dict("manifest_format" => "1.0"))
    @test_throws ErrorException inventory(Dict("manifest_format" => "2.0", "deps" => Dict()))
    @test isempty(query_packages(packages; request=_ -> Dict("results" => [Dict()])))
    for broken in [Dict(), Dict("results" => []), Dict("error" => "unavailable"),
        Dict("results" => [Dict("error" => "invalid query")]),
        Dict("results" => [Dict("vulns" => nothing)]),
        Dict("results" => [Dict("vulns" => [Dict()])]),
        Dict("results" => [Dict("next_page_token" => 3)])]
        @test_throws ErrorException query_packages(packages; request=_ -> broken)
    end
    @test_throws ErrorException query_packages(packages; request=_ -> error("network unavailable"))
end

@testset "Every OSV page remains attached to its package" begin
    calls = Ref(0)
    request = function(queries)
        calls[] += 1
        if calls[] == 1
            @test length(queries) == 2
            @test queries[2]["package"]["name"] == "JSON"
            return Dict("results" => [Dict(), Dict("vulns" => [Dict("id" => "TEST-1")],
                "next_page_token" => "second-json-page")])
        end
        @test length(queries) == 1
        @test only(queries)["package"]["name"] == "JSON"
        @test only(queries)["page_token"] == "second-json-page"
        return Dict("results" => [Dict("vulns" => [Dict("id" => "TEST-1"), Dict("id" => "TEST-2")])])
    end
    findings = query_packages([HTTP_PACKAGE, JSON_PACKAGE]; request)
    @test calls[] == 2
    @test [f.id for f in findings] == ["TEST-1", "TEST-2"]
    @test all(f.package == JSON_PACKAGE for f in findings)
    @test_throws ErrorException query_packages([HTTP_PACKAGE];
        request=_ -> Dict("results" => [Dict("next_page_token" => "repeated")]))
end

if "--live" in ARGS
    @testset "OSV recognizes a known vulnerable Julia release" begin
        findings = query_packages([HTTP_PACKAGE])
        @test any(f.id == "JLSEC-2025-1" for f in findings)
    end
end
