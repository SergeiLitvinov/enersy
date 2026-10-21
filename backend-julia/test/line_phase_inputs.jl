@testset "Supplementary line phase data is never silently malformed or discarded" begin
    diagonals = [prefix * "_" * phase for phase in ("aa", "bb", "cc") for prefix in ("r", "x")]
    mutuals = [prefix * "_" * phase for phase in ("ab", "ba", "ac", "ca", "bc", "cb") for prefix in ("r", "x")]
    for key in vcat(diagonals, mutuals), bad in ("NaN", "Inf", "not-a-number")
        warnings = String[]
        err = try
            EC._check_line_symmetry(Dict(key => bad), 0.1, 0.5, "transmission_line#4", warnings)
            nothing
        catch caught
            caught
        end
        @test err isa EnersyError && err.kind == EC.CONTRACT
        @test err isa EnersyError && occursin(key, err.detail) && occursin("transmission_line#4", err.detail)
    end
    # A zero symmetric reference must not hide a nonzero phase entry.
    for key in diagonals
        warnings = String[]
        EC._check_line_symmetry(Dict(key => "0.1"), startswith(key,"r") ? 0.0 : 0.1,
            startswith(key,"x") ? 0.0 : 0.5, "transmission_line#4", warnings)
        @test any(occursin(key, w) for w in warnings)
    end
    for key in mutuals
        warnings = String[]
        EC._check_line_symmetry(Dict(key => "0.04"), 0.1, 0.5, "transmission_line#4", warnings)
        @test any(occursin(key, w) && occursin("не используется", w) for w in warnings)
    end
    # A warning in an earlier field must not stop validation of later fields.
    @test_throws EnersyError EC._check_line_symmetry(Dict("r_aa"=>"0.2", "x_cc"=>"NaN"), 0.1, 0.5, "line#4", String[])
    warnings = String[]
    EC._check_line_symmetry(Dict("r_aa"=>"0.2", "x_cc"=>"0.7"), 0.1, 0.5, "line#4", warnings)
    @test any(occursin("r_aa", w) for w in warnings) && any(occursin("x_cc", w) for w in warnings)
    @test_throws EnersyError EC._check_line_symmetry(Dict("r_cc"=>"-0.01"), 0.1, 0.5, "line#4", String[])
    # Empty optional metadata is absent, and zero mutual data has no contribution.
    warnings = String[]
    EC._check_line_symmetry(Dict("r_aa"=>" ", "x_ab"=>"0", "x_ca"=>""), 0.1, 0.5, "line#4", warnings)
    @test isempty(warnings)
    # Explicit symmetric r0/x0 remain the physical inputs; a warning does not
    # turn this profile into a phase-matrix solver or change the circuit.
    cs, es = fixture()
    expected = calculate(cs, es)
    line = only(c for c in cs if c.code == "transmission_line")
    line.params["r_aa"] = "0.2"; line.params["x_ab"] = "0.04"
    actual = calculate(cs, es)
    @test [n["voltage"] for n in actual["nodes"]] ≈ [n["voltage"] for n in expected["nodes"]] atol=1e-10
    @test any(occursin("x_ab", w) for w in actual["warnings"])
    line.params["x_cc"] = "NaN"
    request = Dict("components"=>[Dict("id"=>c.id,"type"=>c.code,"params"=>c.params) for c in cs],
                   "connections"=>[Dict("from"=>e.from,"to"=>e.to,"fromPort"=>e.from_port,"toPort"=>e.to_port) for e in es])
    response = EC.handle_request(HTTP.Request("POST","/calculate",[],JSON3.write(request)))
    @test response.status == 400
    @test response.status == 400 && JSON3.read(String(response.body)).error_detail.code == "param_not_finite"
end
