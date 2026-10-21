@testset "Shunts use their own rated voltage independently of bus metadata" begin
    for (code, sign) in (("capacitor", 1), ("reactor", -1)), rated in (9.5, 10.5)
        cs, es = fixture(shunt=code)
        shunt = only(c for c in cs if c.code == code)
        shunt.params["voltage_nom"] = string(rated)
        net = EC.compile_network(cs, es)
        inj = only(i for i in net.injections if i.code == code)
        for nominal in (10.0, 10.5), base in (BaseSystem(100, 10, "test"), BaseSystem(50, 20, "test"))
            bus = EC.Bus(inj.bus, [6], [code], nominal, true, false, 1)
            model = EC.shunt_model(inj, bus, base, String[])
            @test model.y_pu / EC.z_base_ohm(base) ≈ sign * im * 2 / rated^2 atol=1e-14
        end
    end
end

@testset "Two differently rated shunts match a physical voltage divider" begin
    cs = [component(1, "generator"; p=0, r=0.1, x=0.5, e=10, voltage_nom=10),
          component(2, "load"; p=10, q=3, voltage_nom=10, zip_enabled=true,
              zip_p_z=1, zip_p_i=0, zip_p_p=0, zip_q_z=1, zip_q_i=0, zip_q_p=0),
          component(3, "capacitor"; q_nom=2, voltage_nom=9.5),
          component(4, "reactor"; q_nom=1, voltage_nom=10.5)]
    es = [connection(1, 2, "bottom", "top"), connection(2, 3, "top", "top"), connection(2, 4, "top", "top")]
    # Three-phase MVA, line-to-line RMS kV, admittances in S per phase.
    y = conj(10 + 3im) / 10^2 + 2im / 9.5^2 - 1im / 10.5^2
    expected = 10 / (1 + (0.1 + 0.5im) * y)
    for base in (BaseSystem(100, 10, "reference"), BaseSystem(50, 20, "base-invariance"))
        result = calculate(cs, es; base, options=SolverOptions(tolerance=1e-11))
        node = only(n for n in result["nodes"] if !n["is_internal_source_node"])
        @test node["voltage"] ≈ abs(expected) atol=1e-8
        @test node["angle_rad"] ≈ angle(expected) atol=1e-9
        capacitor = only(s for s in result["shunts"] if s["component_id"] == 3)
        reactor = only(s for s in result["shunts"] if s["component_id"] == 4)
        @test capacitor["q_mvar"] ≈ -2 * abs2(expected / 9.5) atol=1e-8
        @test reactor["q_mvar"] ≈ abs2(expected / 10.5) atol=1e-8
        @test abs(result["balance"]["residual_p_mw"]) < 1e-8
        @test abs(result["balance"]["residual_q_mvar"]) < 1e-8
    end
end

@testset "Empty optional nominal voltage is absent, not invalid numeric data" begin
    for index in (4, 5, 6)
        cs, es = fixture(shunt="capacitor")
        delete!(cs[index].params, "voltage_nom")
        expected = calculate(cs, es)
        cs[index].params["voltage_nom"] = "  "
        actual = calculate(cs, es)
        @test [n["voltage"] for n in actual["nodes"]] ≈ [n["voltage"] for n in expected["nodes"]] atol=1e-9
        @test actual["shunts"][1]["q_mvar"] ≈ expected["shunts"][1]["q_mvar"] atol=1e-9
        for bad in ("0", "-1", "NaN", "invalid")
            cs[index].params["voltage_nom"] = bad
            @test_throws EnersyError calculate(cs, es)
        end
    end
    cs, es = fixture()
    set_zip!(cs[5]); cs[5].params["voltage_nom"] = " "
    @test_throws EnersyError calculate(cs, es)
end

@testset "Shunt nominal fallback is explicit and invalid ratings are rejected" begin
    for code in ("capacitor", "reactor")
        cs, es = fixture(shunt=code)
        shunt = only(c for c in cs if c.code == code)
        delete!(shunt.params, "voltage_nom")
        net = EC.compile_network(cs, es)
        inj = only(i for i in net.injections if i.code == code)
        bus = only(b for b in net.buses if b.index == inj.bus)
        assumptions = String[]
        EC.shunt_model(inj, bus, BaseSystem(100, 10, "fallback"), assumptions)
        @test any(occursin("$(code)#6", a) && occursin("10.0 кВ", a) for a in assumptions)
        for bad in ("0", "-1", "Inf", "NaN", "invalid")
            inj.params["voltage_nom"] = bad
            @test_throws EnersyError EC.shunt_model(inj, bus, BaseSystem(100, 10, "invalid"), String[])
        end
    end
end
