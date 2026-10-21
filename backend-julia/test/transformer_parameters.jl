@testset "Transformer metadata agrees with passport tests and actual validation" begin
    specs = EC.model_parameters("transformer")
    required = Set(["power_nom", "voltage_hv", "voltage_lv", "p_kz", "u_kz"])
    @test Set(p["key"] for p in specs if p["requirement"] == "required") == required
    @test Dict(p["key"] => p["default_value"] for p in specs if p["requirement"] == "optional") ==
          Dict("p_xx" => "0", "i_xx" => "0", "phase_shift_deg" => "0")
    params = Dict("power_nom" => "100", "voltage_hv" => "110", "voltage_lv" => "10",
                  "p_kz" => "1", "u_kz" => "10", "p_xx" => "0.1", "i_xx" => "1")
    buses = Dict(1 => EC.Bus(1, [1], ["busbar"], 110.0, true, false, 1),
                 2 => EC.Bus(2, [2], ["busbar"], 10.0, true, false, 1))
    branch(p) = EC.Branch(17, "transformer", 1, 2, 1, 2, p)
    for base in (BaseSystem(100, 110, "passport"), BaseSystem(50, 10, "alternate"))
        model(p) = EC.transformer_model(branch(p), buses, base, String[], String[])
        for key in required
            missing = copy(params); delete!(missing, key)
            err = try model(missing); nothing catch caught; caught end
            @test err isa EnersyError && err.code == "missing_parameter"
        end
        # Independent passport identities, not a copy of the Y-stamp:
        # at nominal winding voltages and zero series current, input equals
        # the no-load test: S0=I0[%]*Sn/100, P0=0.1 MW.
        m = model(copy(params))
        no_load = EC.branch_flow(m, [110, 10] ./ base.v_base_kv, [0.0, 0.0], base)
        @test no_load.p_from_mw ≈ 0.1 atol=1e-10
        @test no_load.q_from_mvar ≈ sqrt(1 - 0.1^2) atol=1e-10
        @test abs(no_load.p_to_mw) < 1e-10
        @test abs(no_load.q_to_mvar) < 1e-10
        # With magnetization explicitly off, applying Uk=10% of Uhv to a
        # shorted LV winding gives rated current and the passport Pk=1 MW.
        no_mag = copy(params); no_mag["p_xx"] = "0"; no_mag["i_xx"] = "0"
        sc = EC.branch_flow(model(no_mag), [11, 0] ./ base.v_base_kv, [0.0, 0.0], base)
        @test sc.p_from_mw ≈ 1 atol=1e-10
        @test sc.q_from_mvar ≈ sqrt(10^2 - 1) atol=1e-10
        @test sc.i_from_ka ≈ 100 / (sqrt(3) * 110) atol=1e-12
        @test sc.i_to_ka ≈ 100 / (sqrt(3) * 10) atol=1e-12
        absent = copy(params); delete!(absent, "p_xx"); delete!(absent, "i_xx")
        @test model(absent).y_from == model(no_mag).y_from == 0im
        for (key, value) in (("power_nom", "0"), ("voltage_hv", "-1"), ("voltage_lv", "0"),
                             ("u_kz", "0"), ("p_kz", "-1"), ("p_kz", "11"),
                             ("p_xx", "-1"), ("i_xx", "-1"), ("i_xx", "0"))
            invalid = copy(params); invalid[key] = value
            @test_throws EnersyError model(invalid)
        end
    end
end
