# Three-phase Mvar, line-to-line RMS kV, per-phase S; result is p.u.
# This oracle evaluates the physical definition B=Q/U_nom^2 before applying
# Z_base=U_base^2/S_base at 256 bits. It does not call conversion helpers.
function shunt_scale_fixture(code, q, un, sb, ub; fallback=false)
    params = fallback ? Dict{String,String}() : Dict("voltage_nom" => string(un))
    injection = EC.Injection(71, code, 1, :shunt, 0.0, q, params, 0.0, false, false)
    bus = EC.Bus(1, [71], [code], un, true, false, 1)
    return injection, bus, BaseSystem(sb, ub, "shunt-scaling-reference")
end

@testset "Shunt scaling preserves representable physical admittance" begin
    setprecision(BigFloat, 256) do
        cases = [(2.0, 9.5, 100.0, 10.0),
                 (1e-200, 1e100, 1e200, 1e200),
                 (1e-200, 1e-100, 1e100, 1e100),
                 (1e200, 1e100, 1e-100, 1e-100)]
        for (code, sign) in (("capacitor", 1), ("reactor", -1)), (q, un, sb, ub) in cases
            injection, bus, base = shunt_scale_fixture(code, q, un, sb, ub)
            physical_b = BigFloat(q) / BigFloat(un)^2
            reference = Float64(sign * physical_b * BigFloat(ub)^2 / BigFloat(sb))
            actual = EC.shunt_model(injection, bus, base, String[])
            @test real(actual.y_pu) == 0.0
            @test isfinite(actual.y_pu)
            @test isapprox(imag(actual.y_pu), reference; rtol=16eps(Float64), atol=nextfloat(0.0))
        end
    end
end

@testset "Shunt exponent sweep refuses lost or overflowing nonzero values" begin
    setprecision(BigFloat, 256) do
        for (code, sign) in (("capacitor", 1), ("reactor", -1)),
            (sb, ub) in ((100.0, 10.0), (50.0, 110.0), (1e200, 1e200), (1e-200, 1e-200)),
            eq in (-600, 0, 600), eu in (-600, 0, 600)
            q, un = ldexp(0.625, eq), ldexp(0.875, eu)
            injection, bus, base = shunt_scale_fixture(code, q, un, sb, ub)
            reference = Float64(sign * (BigFloat(q) / BigFloat(un)^2) * BigFloat(ub)^2 / BigFloat(sb))
            if isfinite(reference) && reference != 0
                actual = EC.shunt_model(injection, bus, base, String[])
                @test real(actual.y_pu) == 0.0
                @test isapprox(imag(actual.y_pu), reference; rtol=16eps(Float64), atol=nextfloat(0.0))
            else
                err = try EC.shunt_model(injection, bus, base, String[]); nothing catch error; error end
                @test err isa EnersyError
                @test err isa EnersyError && err.code == "unrepresentable_parameter"
                @test err isa EnersyError && occursin("$(code)#71", err.detail)
            end
        end
    end
end

@testset "Shunt rated-voltage fallback and zero rating survive safe scaling" begin
    for (code, sign) in (("capacitor", 1), ("reactor", -1))
        injection, bus, base = shunt_scale_fixture(code, 1e-200, 1e100, 1e200, 1e200; fallback=true)
        assumptions = String[]
        model = EC.shunt_model(injection, bus, base, assumptions)
        @test isapprox(imag(model.y_pu), sign * 1e-200; rtol=16eps(Float64))
        @test any(occursin("$(code)#71", a) && occursin("принят номинал узла", a) for a in assumptions)
        zero, zero_bus, zero_base = shunt_scale_fixture(code, 0.0, 1e-200, 1e200, 1e200)
        zero_model = EC.shunt_model(zero, zero_bus, zero_base, String[])
        @test zero_model.y_pu == 0
        @test zero_model.q_nom_mvar == 0
    end
end

@testset "Unrepresentable shunts are diagnosed before solving over HTTP" begin
    server = start_server(; host="127.0.0.1", port=0)
    try
        for code in ("capacitor", "reactor"), (q, sb, ub) in ((1e-300, 1e100, 1e100), (1e300, 1e-100, 1e-100))
            payload = JSON.json(Dict("components" => [Dict("id" => 71, "type" => code,
                "params" => Dict("q_nom" => string(q), "voltage_nom" => string(ub)))],
                "connections" => [], "base" => Dict("s_base_mva" => sb, "v_base_kv" => ub)))
            direct = handle_request(HTTP.Request("POST", "/calculate", [], payload))
            reply = HTTP.post("http://127.0.0.1:$(HTTP.port(server))/calculate", [], payload;
                status_exception=false, proxy=HTTP.ProxyConfig())
            for response in (direct, reply)
                body = JSON.parse(response.body)
                @test response.status == 400
                @test body.error_detail.code == "unrepresentable_parameter"
                @test occursin("$(code)#71", body.error_detail.detail)
            end
        end
    finally
        HTTP.forceclose(server)
    end
end
