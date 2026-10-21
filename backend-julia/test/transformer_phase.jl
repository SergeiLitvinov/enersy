@testset "Transformer phase shift against independent PYPOWER circuits" begin
    path = joinpath(@__DIR__, "reference", "transformer-phase-v1.json")
    reference = JSON3.read(read(path, String))
    @test reference.provenance.solver == "PYPOWER 5.1.19"
    for (name, hash) in pairs(reference.provenance.files)
        content = replace(read(joinpath(@__DIR__, "reference", String(name)), String), "\r\n" => "\n")
        @test bytes2hex(EC.sha256(content)) == hash
    end
    for case in reference.cases
        cs, es, _, _, base, options, _ = EC.parse_calculate_request(case.scheme)
        function compare(result; remap=identity)
            @test result["success"] && result["solver"]["matrix_storage"] == "csc"
            for (index, owner) in enumerate(case.node_owners)
                node = only(n for n in result["nodes"] if remap(Int(owner.id)) in n["members"] && n["is_internal_source_node"] == owner.internal)
                @test node["voltage"] / 110 ≈ case.expected.v_pu[index] atol=1e-8 rtol=0
                @test node["angle_rad"] ≈ case.expected.theta_rad[index] atol=1e-8 rtol=0
                @test node["p_mw"] / 100 ≈ case.expected.p_pu[index] atol=1e-8 rtol=0
                @test node["q_mvar"] / 100 ≈ case.expected.q_pu[index] atol=1e-8 rtol=0
            end
            for (index, id) in enumerate(case.branch_ids)
                branch = only(b for b in result["branches"] if b["component_id"] == remap(Int(id)))
                for (column, key) in enumerate(("p_from_mw", "q_from_mvar", "p_to_mw", "q_to_mvar"))
                    @test branch[key] ≈ case.expected.branch_mw_mvar[index][column] atol=1e-6 rtol=0
                end
                @test branch["i_from_ka"] ≈ case.expected.i_from_ka[index] atol=1e-8 rtol=0
                @test branch["i_to_ka"] ≈ case.expected.i_to_ka[index] atol=1e-8 rtol=0
                @test branch["phase_shift_deg"] ≈ (index == 1 ? 0 : case.shifts[index - 1]) atol=1e-12
            end
            @test abs(result["balance"]["residual_p_mw"]) < 1e-6
            @test abs(result["balance"]["residual_q_mvar"]) < 1e-6
        end
        compare(calculate(cs, es; base, options))
        compare(calculate(cs, es; base=BaseSystem(50, 10, "alternative"), options))
        moved = [RawComponent(1000-c.id, c.code, copy(c.params), 37.0*c.id, -82.0*c.id, 90) for c in reverse(cs)]
        rewired = [RawConnection(1000-e.to, 1000-e.from, e.to_port, e.from_port) for e in reverse(es)]
        compare(calculate(moved, rewired; base, options); remap=id -> 1000-id)
        # Dense reference stamp and sparse assembly must agree for an
        # unsymmetric Y too. Compare Jacobians to finite differences below.
        sys = EC.assemble_system(EC.compile_network(cs, es), base)
        dense = zeros(ComplexF64, length(sys.buses), length(sys.buses))
        for m in sys.branch_models; EC.stamp!(dense, m); end
        @test Matrix(EC.build_admittance(sys)) ≈ dense atol=1e-12
        setup = EC.power_flow_setup(sys, EC.classify_buses(sys, base), base)
        v = [b.v_nom_kv / base.v_base_kv for b in sys.buses]
        theta = collect(range(-0.04, 0.05; length=length(v)))
        powers = EC.bus_powers(dense, v, theta)
        jd, ct, cv = EC.jacobian(dense, v, theta, powers.P, powers.Q, setup)
        js = first(EC.jacobian(EC.build_admittance(sys), v, theta, powers.P, powers.Q, setup))
        @test Matrix(js) ≈ jd atol=1e-10
        numeric = zeros(size(jd)); h = 1e-6
        for (columns, values, is_angle) in ((ct, theta, true), (cv, v, false))
            for (i, column) in columns
                plus, minus = copy(values), copy(values)
                plus[i] += h; minus[i] -= h
                pp = EC.bus_powers(dense, is_angle ? v : plus, is_angle ? plus : theta)
                pm = EC.bus_powers(dense, is_angle ? v : minus, is_angle ? minus : theta)
                numeric[:, column] = -(EC.mismatch_vector(pp, setup) - EC.mismatch_vector(pm, setup)) / (2h)
            end
        end
        @test jd ≈ numeric atol=1e-6 rtol=1e-7
        response = EC.handle_request(HTTP.Request("POST", "/calculate", [], JSON3.write(case.scheme)))
        @test response.status == 200
        compare(JSON3.read(String(response.body), Dict{String,Any}))
    end
end

@testset "Transformer phase convention, passivity and input boundaries" begin
    params = Dict("power_nom"=>"100", "voltage_hv"=>"110", "voltage_lv"=>"10", "p_kz"=>"1", "u_kz"=>"10", "p_xx"=>"0", "i_xx"=>"0")
    buses = Dict(1=>EC.Bus(1,[1],["busbar"],110.0,true,false,1), 2=>EC.Bus(2,[2],["busbar"],10.0,true,false,1))
    base = BaseSystem(100,110,"phase-convention")
    model() = EC.transformer_model(EC.Branch(4,"transformer",1,2,1,2,params), buses, base, String[], String[])
    for phi in (-180.0, -30.0, 0.0, 30.0, 180.0)
        params["phase_shift_deg"] = string(phi)
        m = model()
        # At zero series current Vlv=k*exp(jphi)*Vhv and both powers vanish.
        flow = EC.branch_flow(m, [1.0,10/110], [0.0,deg2rad(phi)], base)
        @test abs(flow.p_from_mw) < 1e-10 && abs(flow.q_from_mvar) < 1e-10
        @test abs(flow.p_to_mw) < 1e-10 && abs(flow.q_to_mvar) < 1e-10
        loaded = EC.branch_flow(m, [1.0,9.5/110], [0.0,deg2rad(phi)-0.03], base)
        @test loaded.losses_p_mw >= 0 && loaded.losses_q_mvar >= 0
    end
    for bad in ("NaN", "Inf", "invalid", "181", "-181")
        params["phase_shift_deg"] = bad
        @test_throws EnersyError model()
    end
end
