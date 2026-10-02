@testset "PQ release restores feasible voltage regulation" begin
    case = JSON3.read(read(joinpath(@__DIR__, "reference", "ac-networks-v1.json"), String)).q_release_network
    cs, es, _, _, base, options, _ = EC.parse_calculate_request(case.scheme)
    result = calculate(cs, es; base, options)
    ordered = [only(filter(n -> member.component_id in n["members"] &&
                     n["is_internal_source_node"] == member.internal, result["nodes"]))
               for member in case.bus_equipment]
    e = case.expected
    @test maximum(abs, [n["voltage_pu"] for n in ordered] - e.v_pu) < 1e-8
    @test maximum(abs, [n["angle_rad"] for n in ordered] - e.theta_rad) < 1e-8
    @test maximum(abs, [n["p_mw"]/100 for n in ordered] - e.p_pu) < 1e-8
    @test maximum(abs, [n["q_mvar"]/100 for n in ordered] - e.q_pu) < 1e-8
    released = only(filter(s -> s["component_id"] == 2001, result["sources"]))
    @test released["type"] == "pv" && released["q_limit_status"] == "within_bounds"
    @test -100 <= released["q_mvar"] <= -5
    @test any(event -> event["component_id"] == 2001 && event["from"] == "pq" && event["to"] == "pv", result["q_limit_events"])
    @test result["iterations"] <= options.max_iterations
    @test result["solver"]["q_limit_policy"] == "internal-emf-active-set-pv-pq"
    @test abs(result["balance"]["residual_p_mw"]) < 1e-6
    @test abs(result["balance"]["residual_q_mvar"]) < 1e-6
    for (k, id) in enumerate(case.branch_component_ids)
        branch = only(filter(b -> b["component_id"] == id, result["branches"]))
        @test maximum(abs, [branch[key] for key in ["p_from_mw", "q_from_mvar", "p_to_mw", "q_to_mvar"]] -
                      e.component_port_mw_mvar[k]) < 1e-6
    end
    server = start_server(; host="127.0.0.1", port=0)
    try
        response = HTTP.post("http://127.0.0.1:$(HTTP.port(server))/calculate",
            ["Content-Type"=>"application/json"], JSON3.write(case.scheme); proxy=HTTP.ProxyConfig())
        @test response.status == 200
        body = JSON3.read(response.body)
        source = only(filter(s -> s.component_id == 2001, body.sources))
        @test source.type == "pv" && source.q_limit_status == "within_bounds"
        @test any(e -> e.from == "pq" && e.to == "pv", body.q_limit_events)
    finally
        HTTP.forceclose(server)
    end
end

@testset "Q active set reports cycles and pass exhaustion" begin
    # Capacitive two-bus branch: P=0, Q2=V2-V2². With Vset=1.1,
    # Q=-0.11 violates Qmin=-0.1. Its high-voltage PQ root is
    # (1+sqrt(1.4))/2 < Vset, causing release and a repeated active set.
    # This is a deliberately reversed voltage/Q sensitivity, not an AVR
    # model valid across voltage collapse. It must not report success.
    Y = ComplexF64[im -im; -im im]
    setup = EC.PowerFlowSetup(2, 1, 1.0, 0.0, [2], Int[], [1.1], [0.0], Float64[], Float64[])
    limits = Dict(2=>(-0.1, 0.0))
    err = try EC.solve_with_q_limits(Y, setup, SolverOptions(tolerance=1e-10, max_iterations=20), limits) catch e; e end
    @test err isa EnersyError && err.code == "q_limit_active_set_cycle"
    err = try EC.solve_with_q_limits(Y, setup, SolverOptions(tolerance=1e-10, max_iterations=1), limits) catch e; e end
    @test err isa EnersyError && err.code == "q_limit_active_set_budget"
end
