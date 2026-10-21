@testset "Base scales avoid intermediate overflow and underflow" begin
    # Independent high-precision evaluation of the electrical base definitions:
    # three-phase MVA, line-to-line RMS kV, per-phase Ohm and RMS kA.
    setprecision(BigFloat, 256) do
        for (s, v) in [(100.0, 10.0), (50.0, 110.0),
                       (1e200, 1e200), (1e-200, 1e-200),
                       (1.5e308, 1.5e308), (1e308, 0.5),
                       (nextfloat(0.0), nextfloat(0.0))]
            base = BaseSystem(s, v, "arithmetic-reference")
            z_ref = Float64(BigFloat(v)^2 / BigFloat(s))
            i_ref = Float64(BigFloat(s) / (sqrt(BigFloat(3)) * BigFloat(v)))
            @test isfinite(EC.z_base_ohm(base)) && EC.z_base_ohm(base) > 0
            @test isfinite(EC.i_base_ka(base)) && EC.i_base_ka(base) > 0
            @test isapprox(EC.z_base_ohm(base), z_ref; rtol=8eps(Float64), atol=nextfloat(0.0))
            @test isapprox(EC.i_base_ka(base), i_ref; rtol=8eps(Float64), atol=nextfloat(0.0))
        end
    end
    for (s, v) in [(1.0, 1e308), (1.0, 1e-308), (1e308, 1e-308)]
        err = try BaseSystem(s, v, "unrepresentable"); nothing catch error; error end
        @test err isa EnersyError
        if err isa EnersyError
            @test err.code == "invalid_base"
            @test err.kind == EC.CONTRACT
        end
    end
end

@testset "Base scale exponent range against BigFloat" begin
    setprecision(BigFloat, 256) do
        for es in (-1070, -1000, -600, -20, 0, 20, 600, 1000, 1023),
            ev in (-1070, -1000, -600, -20, 0, 20, 600, 1000, 1023)
            s, v = ldexp(0.625, es), ldexp(0.875, ev)
            z_ref = Float64(BigFloat(v)^2 / BigFloat(s))
            i_ref = Float64(BigFloat(s) / (sqrt(BigFloat(3)) * BigFloat(v)))
            if isfinite(z_ref) && z_ref > 0 && isfinite(i_ref) && i_ref > 0
                base = BaseSystem(s, v, "exponent-reference")
                @test isapprox(EC.z_base_ohm(base), z_ref; rtol=8eps(Float64), atol=nextfloat(0.0))
                @test isapprox(EC.i_base_ka(base), i_ref; rtol=8eps(Float64), atol=nextfloat(0.0))
            else
                @test_throws EnersyError BaseSystem(s, v, "unrepresentable")
            end
        end
    end
end

@testset "Unrepresentable base is an HTTP input error" begin
    for v in (1e308, 1e-308)
        payload = Dict("components" => [], "connections" => [],
                       "base" => Dict("s_base_mva" => 1.0, "v_base_kv" => v))
        response = handle_request(HTTP.Request("POST", "/calculate", [], JSON3.write(payload)))
        @test response.status == 400
        @test JSON3.read(response.body).error_detail.code == "invalid_base"
    end
end
