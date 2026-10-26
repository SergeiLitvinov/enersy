@testset "Source impedance zero test does not square away a nonzero parameter" begin
    setprecision(BigFloat, 256) do
        for (r, x) in ((0.1, 0.5), (1e-200, 0.0), (0.0, 1e-200), (1e-200, -1e-200), (1e200, 1e200))
            params = Dict("r" => string(r), "x" => string(x), "voltage_nom" => "10")
            injection = EC.Injection(81, "generator", 2, :source, 0.0, 0.0, params, 10.0, true, true)
            terminal = EC.Bus(1, [81], ["generator"], 10.0, true, false, 1)
            result = try EC.generator_model(injection, terminal, BaseSystem(100, 10, "source-reference"), String[], String[]) catch error; error end
            @test result isa EC.BranchModel
            if result isa EC.BranchModel
                # Physical Y=1/(r+jx) S per phase, Z_base=1 Ohm.
                reference = ComplexF64(inv(complex(BigFloat(r), BigFloat(x))))
                @test isapprox(result.y_series, reference; rtol=16eps(Float64), atol=0.0)
            end
        end
    end
end

@testset "True zero source impedance and negative resistance remain invalid" begin
    for (r, x) in ((0.0, 0.0), (-0.0, -0.0), (0.0, -0.0), (-0.0, 0.0), (-1e-200, 1e-200))
        params = Dict("r" => string(r), "x" => string(x), "voltage_nom" => "10")
        injection = EC.Injection(81, "generator", 2, :source, 0.0, 0.0, params, 10.0, true, true)
        terminal = EC.Bus(1, [81], ["generator"], 10.0, true, false, 1)
        err = try EC.generator_model(injection, terminal, BaseSystem(100, 10, "source-reference"), String[], String[]); nothing catch error; error end
        @test err isa EnersyError
        @test err isa EnersyError && err.code == (r < 0 ? "invalid_parameter" : "zero_impedance")
        @test err isa EnersyError && occursin("generator#81", err.detail)
    end
end

@testset "Scaled source and PQ load match an independent physical quadratic" begin
    setprecision(BigFloat, 256) do
        # These are the same p.u. circuit on four explicit bases. Extreme scales
        # exercise arithmetic, not the physical plausibility of these ratings.
        for scale in (1.0, 1e-100, 1e-200, 1e200)
            r, x, e, p, q = scale, scale, scale, 0.1scale, 0.02scale
            source = RawComponent(81, "generator", Dict("r"=>string(r), "x"=>string(x), "e"=>string(e), "p"=>"0", "voltage_nom"=>string(e)), 0.0, 0.0, 0)
            load = RawComponent(82, "load", Dict("p"=>string(p), "q"=>string(q), "voltage_nom"=>string(e)), 0.0, 0.0, 0)
            result = try calculate([source, load], [RawConnection(81, 82, "bottom", "top")];
                base=BaseSystem(scale, scale, "scaled-physical-reference"), options=SolverOptions(tolerance=1e-12)) catch error; error end
            @test result isa AbstractDict
            if result isa AbstractDict
                # E*conj(V) = |V|^2 + Z*conj(S). Solve the high-voltage root
                # independently in physical units at 256 bits.
                a = complex(BigFloat(r), BigFloat(x)) * conj(complex(BigFloat(p), BigFloat(q))) / BigFloat(e)^2
                normalized = complex((1 + sqrt(1 - 4real(a) - 4imag(a)^2))/2, -imag(a))
                expected = BigFloat(e) * normalized
                node = only(n for n in result["nodes"] if !n["is_internal_source_node"])
                @test isapprox(node["voltage"], Float64(abs(expected)); rtol=1e-10, atol=0.0)
                @test isapprox(node["angle_rad"], Float64(angle(expected)); atol=1e-10)
                @test isapprox(node["p_mw"], -p; rtol=1e-9, atol=0.0)
                @test isapprox(node["q_mvar"], -q; rtol=1e-9, atol=0.0)
                @test abs(result["balance"]["residual_p_mw"]) / scale < 1e-9
                @test abs(result["balance"]["residual_q_mvar"]) / scale < 1e-9
            end
        end
    end
end

@testset "HTTP preserves the distinction between tiny and zero source impedance" begin
    payload = Dict("components" => [
        Dict("id"=>81, "type"=>"generator", "params"=>Dict("r"=>"1e-200", "x"=>"1e-200", "e"=>"1e-200", "p"=>"0", "voltage_nom"=>"1e-200")),
        Dict("id"=>82, "type"=>"load", "params"=>Dict("p"=>"1e-201", "q"=>"2e-202", "voltage_nom"=>"1e-200"))],
        "connections"=>[Dict("from"=>81, "to"=>82, "fromPort"=>"bottom", "toPort"=>"top")],
        "base"=>Dict("s_base_mva"=>1e-200, "v_base_kv"=>1e-200), "solverOptions"=>Dict("tolerance"=>1e-12))
    response = handle_request(HTTP.Request("POST", "/calculate", [], JSON.json(payload)))
    body = JSON.parse(response.body)
    @test response.status == 200
    @test body.success === true
    if response.status == 200
        node = only(n for n in body.nodes if !n.is_internal_source_node)
        expected = complex((1 + sqrt(0.4944))/2, -0.08)
        @test isapprox(node.voltage / 1e-200, abs(expected); rtol=1e-10)
        @test isapprox(node.angle_rad, angle(expected); atol=1e-10)
        @test isapprox(node.p_mw / 1e-200, -0.1; atol=1e-10)
        @test isapprox(node.q_mvar / 1e-200, -0.02; atol=1e-10)
    end
    payload["components"][1]["params"]["r"] = "0"
    payload["components"][1]["params"]["x"] = "-0.0"
    refused = handle_request(HTTP.Request("POST", "/calculate", [], JSON.json(payload)))
    error_body = JSON.parse(refused.body)
    @test refused.status == 400
    @test error_body.error_detail.code == "zero_impedance"
    @test occursin("generator#81", error_body.error_detail.detail)
end
