@testset "Internal EMF reactive limits against independent PQ references" begin
    cases = JSON3.read(read(joinpath(@__DIR__, "reference", "ac-networks-v1.json"), String)).q_limit_networks
    server = start_server(; host="127.0.0.1", port=0)
    try
        url = "http://127.0.0.1:$(HTTP.port(server))/calculate"
        for case in cases
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
            @test length(result["q_limit_events"]) == length(case.fixed_q_mvar)
            @test result["iterations"] <= options.max_iterations
            @test abs(result["balance"]["residual_q_mvar"]) < 1e-6
            for (cid, q) in pairs(case.fixed_q_mvar)
                id = parse(Int, String(cid))
                source = only(filter(s -> s["component_id"] == id, result["sources"]))
                @test source["type"] == "pq" && source["q_limit_status"] == "clamped"
                @test source["q_limits_applied"]
                @test source["q_mvar"] ≈ q atol=1e-6
            end
            for (k, id) in enumerate(case.branch_component_ids)
                b = only(filter(b -> b["component_id"] == id, result["branches"]))
                @test maximum(abs, [b[key] for key in ["p_from_mw", "q_from_mvar", "p_to_mw", "q_to_mvar"]] -
                              e.component_port_mw_mvar[k]) < 1e-6
            end
            response = HTTP.post(url, ["Content-Type"=>"application/json"], JSON3.write(case.scheme); proxy=HTTP.ProxyConfig())
            @test response.status == 200
            @test length(JSON3.read(response.body).q_limit_events) == length(case.fixed_q_mvar)
        end
        cs, es, _, _, base, options, _ = EC.parse_calculate_request(cases[1].scheme)
        budget_error = try calculate(cs, es; base, options=SolverOptions(tolerance=1e-10, max_iterations=3)) catch caught; caught end
        @test budget_error isa EnersyError && budget_error.code == "q_limit_iteration_budget"
        source = only(filter(c -> c.id == 2001, cs))
        source.params["q_min_emf_mvar"] = "0"
        source.params["q_max_emf_mvar"] = "0"
        equal = calculate(cs, es; base, options)
        @test only(filter(s -> s["component_id"] == 2001, equal["sources"]))["q_mvar"] ≈ 0 atol=1e-6
        for params in [Dict("q_min_emf_mvar"=>"0"),
                       Dict("q_min_emf_mvar"=>"5", "q_max_emf_mvar"=>"-5"),
                       Dict("q_min_emf_mvar"=>"NaN", "q_max_emf_mvar"=>"10")]
            source = only(filter(c -> c.id == 2001, cs))
            delete!(source.params, "q_min_emf_mvar"); delete!(source.params, "q_max_emf_mvar")
            merge!(source.params, params)
            @test_throws EnersyError calculate(cs, es; base, options)
        end
        delete!(only(filter(c -> c.id == 2001, cs)).params, "q_min_emf_mvar")
        delete!(only(filter(c -> c.id == 2001, cs)).params, "q_max_emf_mvar")
        slack = only(filter(c -> c.id == 2000, cs))
        merge!(slack.params, Dict("q_min_emf_mvar"=>"-1", "q_max_emf_mvar"=>"1"))
        error = try calculate(cs, es; base, options) catch caught; caught end
        @test error isa EnersyError && error.code == "slack_q_limit"
    finally
        HTTP.forceclose(server)
    end
end
