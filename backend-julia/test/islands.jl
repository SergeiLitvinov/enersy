@testset "Independent powered islands retain physical provenance" begin
    fixtures = JSON3.read(read(joinpath(@__DIR__, "reference", "ac-networks-v1.json"), String))
    cases = [fixtures.q_release_network, fixtures.compiled_networks[2]]
    cs, es = RawComponent[], RawConnection[]
    offsets, rotations = [0, 10000], [-11.0, 27.0]
    base, options = BaseSystem(100, 110, "independent islands"), SolverOptions(tolerance=1e-10)
    for (k, case) in enumerate(cases)
        components, connections, _, _, _, _, _ = EC.parse_calculate_request(case.scheme)
        for c in components
            params = copy(c.params)
            c.id == 2000 && (params["angle"] = string(rotations[k]))
            push!(cs, RawComponent(c.id + offsets[k], c.code, params, c.x, c.y, c.rotation))
        end
        append!(es, [RawConnection(e.from + offsets[k], e.to + offsets[k], e.from_port, e.to_port) for e in connections])
    end
    function compare(result)
        @test result["success"] && result["solver"]["islands"] == 2
        @test sort(result["solver"]["slack_components"]) == [2000, 12000]
        @test !haskey(result["solver"], "slack_bus")
        @test result["iterations"] == sum(i["iterations"] for i in result["island_results"])
        @test result["iterations"] <= options.max_iterations
        @test result["solver"]["equations"] == 2 * (result["node_count"] - 2)
        @test length(unique(n["node_id"] for n in result["nodes"])) == result["node_count"]
        @test sort(vcat([i["bus_ids"] for i in result["island_results"]]...)) == collect(1:result["node_count"])
        for (k, case) in enumerate(cases)
            ordered = [only(filter(n -> Int(member.component_id) + offsets[k] in n["members"] &&
                             n["is_internal_source_node"] == member.internal, result["nodes"]))
                       for member in case.bus_equipment]
            e = case.expected
            @test maximum(abs, [n["voltage_pu"] for n in ordered] - e.v_pu) < 1e-8
            @test maximum(abs, [n["angle_rad"] for n in ordered] - e.theta_rad .- deg2rad(rotations[k])) < 1e-8
            @test maximum(abs, [n["p_mw"]/100 for n in ordered] - e.p_pu) < 1e-8
            @test maximum(abs, [n["q_mvar"]/100 for n in ordered] - e.q_pu) < 1e-8
            island = only(filter(i -> i["slack_component"] == 2000 + offsets[k], result["island_results"]))
            @test all(n -> n["island"] == island["island_id"] && n["node_id"] in island["bus_ids"], ordered)
            @test abs(island["balance"]["residual_p_mw"]) < 1e-6
            @test abs(island["balance"]["residual_q_mvar"]) < 1e-6
            for (j, id) in enumerate(case.branch_component_ids)
                branch = only(filter(b -> b["component_id"] == Int(id) + offsets[k], result["branches"]))
                @test branch["from_bus"] in island["bus_ids"] && branch["to_bus"] in island["bus_ids"]
                @test maximum(abs, [branch[key] for key in ["p_from_mw", "q_from_mvar", "p_to_mw", "q_to_mvar"]] -
                              e.component_port_mw_mvar[j]) < 1e-6
            end
        end
        @test all(s -> s["internal_bus"] != s["terminal_bus"] &&
                    s["internal_bus"] in [n["node_id"] for n in result["nodes"]], result["sources"])
        @test any(e -> e["component_id"] == 2001 && e["to"] == "pv" && haskey(e, "island_id"), result["q_limit_events"])
    end
    result = calculate(cs, es; base, options)
    compare(result)
    compare(calculate(reverse(cs), reverse(es); base, options))
    server = start_server(; host="127.0.0.1", port=0)
    try
        payload = Dict("components"=>[Dict("id"=>c.id, "type"=>c.code, "params"=>c.params) for c in cs],
            "connections"=>[Dict("from"=>e.from, "to"=>e.to, "fromPort"=>e.from_port, "toPort"=>e.to_port) for e in es],
            "base"=>Dict("s_base_mva"=>100, "v_base_kv"=>110), "solverOptions"=>Dict("tolerance"=>1e-10, "max_iterations"=>50))
        response = HTTP.post("http://127.0.0.1:$(HTTP.port(server))/calculate", [], JSON3.write(payload); proxy=HTTP.ProxyConfig())
        @test response.status == 200
        compare(JSON3.read(response.body))
    finally
        HTTP.forceclose(server)
    end
    ambiguous = [RawComponent(c.id, c.code, Dict(key=>value for (key,value) in c.params if !(c.id == 12000 && key == "is_slack")), c.x, c.y, c.rotation) for c in cs]
    err = try calculate(ambiguous, es; base, options) catch e; e end
    @test err isa EnersyError && err.code == "ambiguous_slack" && occursin("island=", err.detail)
    # Open interconnection preserves independent references; closing it requires
    # resolving the now-invalid pair of slack sources in the single island.
    a = first(filter(c -> c.code == "busbar" && c.id < 10000, cs)).id
    b = first(filter(c -> c.code == "busbar" && c.id > 10000, cs)).id
    bridge = component(90000, "breaker"; status=false, voltage_nom=110)
    links = vcat(es, [connection(a, 90000, "right", "top"), connection(90000, b, "bottom", "left")])
    @test calculate(vcat(cs, [bridge]), links; base, options)["solver"]["islands"] == 2
    bridge.params["status"] = "true"
    err = try calculate(vcat(cs, [bridge]), links; base, options) catch e; e end
    @test err isa EnersyError && err.code == "multiple_slack"
    budget = result["island_results"][1]["iterations"]
    err = try calculate(cs, es; base, options=SolverOptions(tolerance=1e-10, max_iterations=budget)) catch e; e end
    @test err isa EnersyError && err.code == "island_iteration_budget"
    # No artificial grounding/voltage is assigned to a disconnected load area.
    powered = [c for c in cs if !(c.code == "generator" && c.id > 10000)]
    present = Set(c.id for c in powered)
    retained = [e for e in es if e.from in present && e.to in present]
    err = try calculate(powered, retained; base, options) catch e; e end
    @test err isa EnersyError && err.code == "island_without_source"
    # Automatic reference selection is safe independently in a one-source island.
    solo_cs, solo_es = RawComponent[], RawConnection[]
    for shift in [0, 100]
        append!(solo_cs, [component(shift+1, "generator"; voltage_nom=10, e=10, p=0, r=0.1, x=0.5),
                         component(shift+2, "load"; voltage_nom=10, p=1, q=0.3)])
        push!(solo_es, connection(shift+1, shift+2, "bottom", "top"))
    end
    solo = calculate(solo_cs, solo_es; options)
    @test solo["solver"]["slack_components"] == [1, 101]
    @test length(solo["island_results"]) == 2
end
