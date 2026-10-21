@testset "Declared parameter requirements agree with the current model behavior" begin
    for (code, keys) in (("generator", ["p", "x"]), ("transmission_line", ["length", "r0", "x0"]), ("load", ["p"]))
        specs = EC.model_parameters(code)
        @test Set(p["key"] for p in specs if p["requirement"] == "required") == Set(keys)
        for key in keys
            cs, es = fixture()
            owner = only(filter(c -> c.code == code, cs))
            delete!(owner.params, key)
            error = try calculate(cs, es); nothing catch caught; caught end
            @test error isa EnersyError
            @test error isa EnersyError && error.code == "missing_parameter"
        end
    end
    # Compare the documented defaults to actual execution, then to an analytical
    # series admittance. This catches metadata drift without changing the solver.
    cs, es = fixture()
    net = EC.compile_network(cs, es)
    branch = only(net.branches)
    base = BaseSystem(100, 10, "test")
    buses = Dict(b.index => b for b in net.buses)
    default_model = EC.line_model(branch, buses, base, String[], String[])
    explicit = copy(branch.params)
    for spec in EC.model_parameters("transmission_line")
        spec["default_value"] === nothing || (explicit[spec["key"]] = spec["default_value"])
    end
    explicit_branch = EC.Branch(branch.component_id, branch.code, branch.from_bus, branch.to_bus, branch.from_terminal, branch.to_terminal, explicit)
    explicit_model = EC.line_model(explicit_branch, buses, base, String[], String[])
    @test default_model.y_series ≈ inv(complex(0.1, 0.5) / EC.z_base_ohm(base)) rtol=1e-14
    @test default_model.y_series == explicit_model.y_series
    @test default_model.y_from == explicit_model.y_from == 0im
    @test default_model.y_to == explicit_model.y_to == 0im
    # Source zero-r default, PQ zero-q default, and conditional voltage fallback.
    source_defaults = Dict(p["key"] => p["default_value"] for p in EC.model_parameters("generator"))
    @test source_defaults["r"] == "0" && source_defaults["angle"] == "0"
    @test source_defaults["e"] === nothing && source_defaults["voltage_nom"] === nothing
    load_specs = EC.model_parameters("load")
    @test only(filter(p -> p["key"] == "q", load_specs))["default_value"] == "0"
    cs, es = fixture(); delete!(cs[1].params, "r"); delete!(cs[5].params, "q")
    net = EC.compile_network(cs, es); system = EC.assemble_system(net, base)
    source_branch = only(filter(b -> b.code == "generator", system.branch_models))
    @test source_branch.y_series ≈ inv(complex(0.0, 0.5) / EC.z_base_ohm(base)) rtol=1e-14
    @test only(filter(i -> i.code == "load", net.injections)).q_mvar == 0
    @test Set(p["key"] for p in EC.model_parameters("generator") if p["requirement"] == "conditional") == Set(["e", "voltage_nom", "q_min_emf_mvar", "q_max_emf_mvar"])
end

@testset "Shunt descriptions agree with rated three-phase power, voltage scaling and missing data" begin
    for (code, sign) in (("capacitor", 1), ("reactor", -1))
        specs = EC.model_parameters(code)
        @test Set(p["key"] for p in specs if p["requirement"] == "required") == Set(["q_nom"])
        @test all(p["default_value"] === nothing for p in specs)
        cs, es = fixture(shunt=code)
        shunt = only(filter(c -> c.code == code, cs))
        # Nominal voltage may come from the connected bus, not this component.
        delete!(shunt.params, "voltage_nom")
        net = EC.compile_network(cs, es)
        injection = only(filter(i -> i.code == code, net.injections))
        bus = only(filter(b -> b.index == injection.bus, net.buses))
        @test bus.v_nom_kv == 10
        for base in (BaseSystem(100, 10, "test"), BaseSystem(50, 20, "test"))
            model = EC.shunt_model(injection, bus, base, String[])
            # Independent physical expectation: 2 Mvar at 10 kV means 0.02 S
            # per phase. Three-phase S=U_LL²*conj(Y), not 3*U_LL²*conj(Y).
            @test model.y_pu / EC.z_base_ohm(base) ≈ sign * 0.02im atol=1e-14
            @test inv(model.y_pu) * EC.z_base_ohm(base) ≈ -sign * 50im atol=1e-12
            for voltage in (8.0, 10.0, 12.0)
                s_absorbed_mva = (voltage / base.v_base_kv)^2 * conj(model.y_pu) * base.s_base_mva
                @test real(s_absorbed_mva) == 0
                @test -imag(s_absorbed_mva) ≈ sign * 2 * (voltage / 10)^2 atol=1e-12
            end
        end
        no_nominal = EC.Bus(bus.index, bus.members, bus.codes, 0.0, false, false, bus.island)
        error = try EC.shunt_model(injection, no_nominal, BaseSystem(100, 10, "test"), String[]); nothing catch caught; caught end
        @test error isa EnersyError && error.code == "missing_parameter"
        shunt.params["q_nom"] = "0"
        zero_net = EC.compile_network(cs, es)
        zero_injection = only(filter(i -> i.code == code, zero_net.injections))
        assumptions = String[]
        @test EC.shunt_model(zero_injection, no_nominal, BaseSystem(100, 10, "test"), assumptions).y_pu == 0im
        @test !isempty(assumptions)
        delete!(shunt.params, "q_nom")
        error = try EC.compile_network(cs, es); nothing catch caught; caught end
        @test error isa EnersyError && error.code == "missing_parameter"
    end
end
