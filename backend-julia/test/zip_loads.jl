function set_zip!(load; p=(0.2, 0.3, 0.5), q=(0.4, 0.1, 0.5))
    load.params["zip_enabled"] = "true"
    for (key, value) in zip(EC.ZIP_KEYS, (p..., q...))
        load.params[key] = string(value)
    end
    return load
end

@testset "Co-located ZIP and PQ loads retain separate nominal voltages" begin
    cs, es = fixture()
    set_zip!(cs[5])
    cs[5].params["voltage_nom"] = "9.5"
    push!(cs, component(8, "load"; p=2, q=-0.5, voltage_nom=10))
    push!(es, connection(4, 8, "right", "top"))
    result = calculate(cs, es; options=SolverOptions(tolerance=1e-11))
    zip = only(l for l in result["loads"] if l["component_id"] == 5)
    pq = only(l for l in result["loads"] if l["component_id"] == 8)
    ratio = zip["voltage_kv"] / 9.5
    @test zip["bus"] == pq["bus"]
    @test zip["p_mw"] ≈ 10 * (0.2ratio^2 + 0.3ratio + 0.5) atol=1e-9
    @test zip["q_mvar"] ≈ 3 * (0.4ratio^2 + 0.1ratio + 0.5) atol=1e-9
    @test pq["profile"] == "pq" && pq["p_mw"] == 2 && pq["q_mvar"] == -0.5
    @test result["balance"]["load_p_mw"] ≈ -zip["p_mw"] - 2 atol=1e-9
    @test abs(result["balance"]["residual_p_mw"]) < 1e-8
    @test abs(result["balance"]["residual_q_mvar"]) < 1e-8
    baseline, wires = fixture()
    old = calculate(baseline, wires)
    set_zip!(baseline[5]; p=(0.0, 0.0, 1.0), q=(0.0, 0.0, 1.0))
    explicit = calculate(baseline, wires)
    @test [n["voltage"] for n in explicit["nodes"]] ≈ [n["voltage"] for n in old["nodes"]] atol=1e-10
end

@testset "ZIP specification survives PV to PQ active-set reconstruction" begin
    cases = JSON.parse(read(joinpath(@__DIR__, "reference", "ac-networks-v1.json"), String)).q_limit_networks
    cs, es, _, _, base, options, _ = EC.parse_calculate_request(first(cases).scheme)
    for load in filter(c -> c.code == "load", cs)
        set_zip!(load)
    end
    result = calculate(cs, es; base, options)
    @test !isempty(result["q_limit_events"])
    @test all(l -> l["profile"] == "zip", result["loads"])
    for load in result["loads"]
        original = only(c for c in cs if c.id == load["component_id"])
        ratio = load["voltage_kv"] / parse(Float64, original.params["voltage_nom"])
        @test load["p_mw"] ≈ load["p_nom_mw"] * (0.2ratio^2 + 0.3ratio + 0.5) atol=1e-8
        @test load["q_mvar"] ≈ load["q_nom_mvar"] * (0.4ratio^2 + 0.1ratio + 0.5) atol=1e-8
    end
    @test abs(result["balance"]["residual_p_mw"]) < 1e-6
    @test abs(result["balance"]["residual_q_mvar"]) < 1e-6
end

@testset "ZIP contract rejects ambiguous or incomplete fractions" begin
    cs, es = fixture()
    load = cs[5]
    set_zip!(load)
    @test EC.load_profile(load.params, "test").zip
    for (key, value, code) in [("zip_p_z", "-0.1", "invalid_load_profile"),
                               ("zip_q_p", "0.8", "invalid_load_profile"),
                               ("zip_q_i", "NaN", "param_not_finite"),
                               ("zip_p_i", "", "missing_parameter"),
                               ("voltage_nom", "", "missing_parameter"),
                               ("voltage_nom", "0", "invalid_load_profile"),
                               ("zip_enabled", "false", "invalid_load_profile")]
        original = load.params[key]
        load.params[key] = value
        err = try calculate(cs, es); nothing catch e; e end
        @test err isa EnersyError && err.code == code
        load.params[key] = original
    end
    @test_throws EnersyError EC.PowerFlowSetup(2, 1, 1.0, 0.0, Int[], [2], Float64[], Float64[], [0.0], [0.0];
        voltage_demands=[EC.VoltageDemand(1, 0.1, 0.1, 0.1, 0.1)])
end

@testset "ZIP load derivative is included in dense and sparse Newton equations" begin
    cs, es = fixture()
    set_zip!(cs[5])
    base = BaseSystem(100, 20, "derivative")
    sys = EC.assemble_system(EC.compile_network(cs, es), base)
    setup = EC.power_flow_setup(sys, EC.classify_buses(sys, base), base)
    Y = EC.build_admittance(sys)
    v, theta = [0.47, 0.49, 0.5], [-0.09, -0.04, 0.0]
    @test length(v) == setup.nbus
    powers = EC.bus_powers(Y, v, theta)
    J, ct, cv = EC.jacobian(Y, v, theta, powers.P, powers.Q, setup)
    dense = first(EC.jacobian(Matrix(Y), v, theta, powers.P, powers.Q, setup))
    @test J isa SparseMatrixCSC
    @test Matrix(J) ≈ dense atol=1e-12
    h = 1e-6
    for (indices, original, angle) in ((ct, theta, true), (cv, v, false))
        for (bus, col) in indices
            plus, minus = copy(original), copy(original)
            plus[bus] += h; minus[bus] -= h
            fplus = EC.mismatch_vector(EC.bus_powers(Y, angle ? v : plus, angle ? plus : theta), setup)
            fminus = EC.mismatch_vector(EC.bus_powers(Y, angle ? v : minus, angle ? minus : theta), setup)
            @test maximum(abs, J[:, col] + (fplus - fminus) / (2h)) < 1e-8
        end
    end
end

@testset "Pure ZIP impedance matches an independent complex voltage divider" begin
    cs, es = fixture()
    set_zip!(cs[5]; p=(1.0, 0.0, 0.0), q=(1.0, 0.0, 0.0))
    # Linear circuit in physical Ohm/kV: each phase has the same voltage ratio.
    zload = 10.0^2 / conj(10.0 + 3.0im)
    expected = 10.0 * zload / (0.2 + 1.0im + zload)
    for base in (BaseSystem(100, 10, "reference"), BaseSystem(50, 20, "different-base"))
        result = calculate(cs, es; base, options=SolverOptions(tolerance=1e-11))
        node = only(n for n in result["nodes"] if 5 in n["members"])
        @test node["voltage"] ≈ abs(expected) atol=1e-8
        @test node["angle_rad"] ≈ angle(expected) atol=1e-9
        load = only(result["loads"])
        @test load["profile"] == "zip"
        @test load["voltage_nom_kv"] == 10.0
        @test load["bus"] == node["node_id"]
        @test load["p_mw"] ≈ abs(expected)^2 / 10 atol=1e-8
        @test load["q_mvar"] ≈ 3 * abs2(expected / 10) atol=1e-8
        @test result["balance"]["load_p_mw"] ≈ -load["p_mw"] atol=1e-9
        @test abs(result["balance"]["residual_p_mw"]) < 1e-8
        @test abs(result["balance"]["residual_q_mvar"]) < 1e-8
    end
end

@testset "Mixed active and reactive ZIP recovers a manufactured physical phasor" begin
    cs, es = fixture()
    load = set_zip!(cs[5])
    load.params["voltage_nom"] = "9.5"
    expected = 9.7 - 0.4im # line-to-line kV, internal EMF = 10∠0 kV
    # Kirchhoff/three-phase power in physical units, independent of assembled Y.
    # U_LL*conj((E_LL-U_LL)/Z) gives total MVA (sqrt(3) factors cancel).
    current_scaled = (10.0 - expected) / (0.2 + 1.0im)
    actual = expected * conj(current_scaled)
    ratio = abs(expected) / 9.5
    load.params["p"] = string(real(actual) / (0.2ratio^2 + 0.3ratio + 0.5))
    load.params["q"] = string(imag(actual) / (0.4ratio^2 + 0.1ratio + 0.5))
    losses = abs2(current_scaled) * (0.2 + 1.0im)
    for base in (BaseSystem(100, 10, "physical-reference"), BaseSystem(50, 20, "base-invariance"))
        result = calculate(cs, es; base, options=SolverOptions(tolerance=1e-11))
        node = only(n for n in result["nodes"] if 5 in n["members"])
        @test node["voltage"] ≈ abs(expected) atol=1e-8
        @test node["angle_rad"] ≈ angle(expected) atol=1e-9
        @test only(result["loads"])["p_mw"] ≈ real(actual) atol=1e-8
        @test only(result["loads"])["q_mvar"] ≈ imag(actual) atol=1e-8
        @test result["balance"]["branch_losses_p_mw"] ≈ real(losses) atol=1e-8
        @test result["balance"]["branch_losses_q_mvar"] ≈ imag(losses) atol=1e-8
        @test abs(result["balance"]["residual_p_mw"]) < 1e-8
        @test abs(result["balance"]["residual_q_mvar"]) < 1e-8
    end
end

@testset "Z, I, P and mixed ZIP match a physical quadratic root" begin
    for fractions in ((1.0, 0.0, 0.0), (0.0, 1.0, 0.0), (0.0, 0.0, 1.0), (0.2, 0.3, 0.5))
        cs, es = fixture()
        cs[1].params["x"] = "0"
        cs[4].params["x0"] = "0"
        cs[5].params["q"] = "0"
        set_zip!(cs[5]; p=fractions)
        # U*(E-U)/R = Pnom*(z*(U/Unom)^2 + i*U/Unom + p).
        z, i, p = fractions
        a, b, c = 1 / 0.2 + 10z / 10^2, 10i / 10 - 10 / 0.2, 10p
        expected = (-b + sqrt(b^2 - 4a*c)) / (2a)
        result = calculate(cs, es; options=SolverOptions(tolerance=1e-11))
        node = only(n for n in result["nodes"] if 5 in n["members"])
        @test node["voltage"] ≈ expected atol=1e-8
        @test node["angle_rad"] ≈ 0 atol=1e-10
        @test only(result["loads"])["p_mw"] ≈ expected * (10 - expected) / 0.2 atol=1e-8
        @test abs(result["balance"]["residual_p_mw"]) < 1e-8
    end
end

@testset "ZIP load results survive islands and coordinate/ID ordering" begin
    cs, es = fixture()
    set_zip!(cs[5])
    reference = calculate(cs, es; options=SolverOptions(tolerance=1e-11))
    second = [RawComponent(c.id + 100, c.code, copy(c.params), -900.0, 700.0, 270) for c in cs]
    wires = [RawConnection(e.from + 100, e.to + 100, e.from_port, e.to_port) for e in es]
    result = calculate(reverse(vcat(cs, second)), reverse(vcat(es, wires)); options=SolverOptions(tolerance=1e-11))
    @test length(result["loads"]) == 2
    @test result["solver"]["islands"] == 2
    for load in result["loads"]
        @test load["p_mw"] ≈ only(reference["loads"])["p_mw"] atol=1e-8
        @test load["q_mvar"] ≈ only(reference["loads"])["q_mvar"] atol=1e-8
        node = only(n for n in result["nodes"] if load["component_id"] in n["members"])
        @test load["bus"] == node["node_id"]
    end
    @test abs(result["balance"]["residual_p_mw"]) < 1e-8
    @test abs(result["balance"]["residual_q_mvar"]) < 1e-8
    payload = Dict("components" => [Dict("id" => c.id, "type" => c.code, "params" => c.params) for c in cs],
        "connections" => [Dict("from" => e.from, "to" => e.to, "fromPort" => e.from_port, "toPort" => e.to_port) for e in es])
    response = handle_request(HTTP.Request("POST", "/calculate", [], JSON.json(payload)))
    @test response.status == 200
    @test only(JSON.parse(response.body).loads).profile == "zip"
end
