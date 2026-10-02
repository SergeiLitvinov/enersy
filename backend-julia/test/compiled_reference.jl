@testset "Compiled loaded 110/10 kV transformer against PYPOWER" begin
    reference = JSON3.read(read(joinpath(@__DIR__, "reference", "ac-networks-v1.json"), String)).compiled_transformer
    cs = [component(1,"generator"; voltage_nom=110, e=113.3, p=0, r=0.1, x=0.5),
          component(2,"busbar"; voltage_nom=110),
          component(3,"busbar"; voltage_nom=10),
          component(4,"transformer"; power_nom=100, voltage_hv=110, voltage_lv=10,
                    p_kz=1, u_kz=10, p_xx=0.1, i_xx=1),
          component(5,"load"; voltage_nom=10, p=10, q=3)]
    es = [connection(1,2,"bottom","left"), connection(2,4,"right","top"),
          connection(4,3,"bottom","left"), connection(3,5,"right","top")]
    base = BaseSystem(100,110,"independent compiled reference")
    options = SolverOptions(tolerance=1e-10)
    result = calculate(cs, es; base, options)
    # Map by equipment membership, never by generated bus order.
    function compare_result(result, ids)
        nodes = result["nodes"]
        ordered = [only(filter(node -> id in node["members"] &&
            node["is_internal_source_node"] == internal, nodes))
            for (id, internal) in [(ids[1], true), (ids[2], false), (ids[3], false)]]
        e = reference.expected
        @test maximum(abs, [n["voltage_pu"] for n in ordered] - e.v_pu) < 1e-8
        @test maximum(abs, [n["angle_rad"] for n in ordered] - e.theta_rad) < 1e-8
        @test maximum(abs, [n["p_mw"]/100 for n in ordered] - e.p_pu) < 1e-8
        @test maximum(abs, [n["q_mvar"]/100 for n in ordered] - e.q_pu) < 1e-8
        for (k, id) in enumerate([ids[1], ids[4]])
            branch = only(filter(b -> b["component_id"] == id, result["branches"]))
            flow = [branch[key] for key in ["p_from_mw", "q_from_mvar", "p_to_mw", "q_to_mvar"]]
            expected_flow = collect(e.branch_mw_mvar[k])
            if k == 2
                # PYPOWER represents magnetization as a bus shunt; Enersy
                # includes it in the transformer's HV port power. Compare
                # the same physical boundary using independent reference V.
                hv = reference.bus[2]
                expected_flow[1] += e.v_pu[2]^2 * hv[5]
                expected_flow[2] -= e.v_pu[2]^2 * hv[6]
            end
            @test maximum(abs, flow - expected_flow) < 1e-6
        end
        return ordered
    end
    compare_result(result, collect(1:5))
    # Renumbering changes compiled bus order and coordinates change completely.
    ids = Dict(1=>901, 2=>505, 3=>101, 4=>709, 5=>303)
    moved = [RawComponent(ids[c.id], c.code, copy(c.params), 17.0*c.id, -83.0*c.id, 90)
             for c in reverse(cs)]
    rewired = [RawConnection(ids[e.from], ids[e.to], e.from_port, e.to_port) for e in reverse(es)]
    compare_result(calculate(moved, rewired; base, options), [ids[i] for i in 1:5])
    # Physical outputs must not depend on the chosen common per-unit base.
    other_base = BaseSystem(50,10,"alternate global reference base")
    other = calculate(cs, es; base=other_base, options)
    for original in result["nodes"]
        node = only(filter(n -> n["members"] == original["members"] &&
             n["is_internal_source_node"] == original["is_internal_source_node"], other["nodes"]))
        @test node["voltage"] ≈ original["voltage"] atol=1e-7
        @test node["angle"] ≈ original["angle"] atol=1e-7
        @test node["p_mw"] ≈ original["p_mw"] atol=1e-6
        @test node["q_mvar"] ≈ original["q_mvar"] atol=1e-6
    end
end
