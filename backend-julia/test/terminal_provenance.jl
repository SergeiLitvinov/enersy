@testset "Canonical buses and complete physical terminal provenance" begin
    signature(net) = [(t.component_id, t.component_type, t.terminal, t.bus, t.omitted_reason) for t in net.terminal_buses]
    cs = [component(1, "transmission_line"; length=1, r0=0.1, x0=0.5),
          component(2, "busbar"; voltage_nom=10), component(3, "busbar"; voltage_nom=10)]
    wires = [connection(1, 2, "left", "left"), connection(1, 3, "right", "left")]
    baseline = EC.compile_network(cs, wires)
    @test [b.members for b in baseline.buses] == [[1, 2], [1, 3]]
    @test signature(baseline) == [(1,"transmission_line",1,1,nothing), (1,"transmission_line",2,2,nothing),
        (2,"busbar",1,1,nothing), (3,"busbar",1,2,nothing)]
    # Reproducer: formerly reversing only the first wire made DSU root 2 sort
    # before root 3 and swapped the buses of the very same electrical network.
    for reverse_components in (false, true), reverse_wires in (false, true), flips in 0:3
        es = [iszero(flips & (1 << (i - 1))) ? e : connection(e.to, e.from, e.to_port, e.from_port)
              for (i, e) in enumerate(wires)]
        net = EC.compile_network(reverse_components ? reverse(cs) : cs, reverse_wires ? reverse(es) : es)
        @test signature(net) == signature(baseline)
        @test [b.members for b in net.buses] == [b.members for b in baseline.buses]
        @test [(b.from_bus, b.to_bus) for b in net.branches] == [(1, 2)]
    end
    for closed in (true, false)
        components, connections = fixture(switch_status=closed)
        net = EC.compile_network(components, connections)
        bindings = Dict((t.component_id,t.terminal) => t for t in net.terminal_buses)
        @test length(bindings) == 7
        @test all(t.bus !== nothing && t.omitted_reason === nothing for t in net.terminal_buses)
        @test (bindings[(2,1)].bus == bindings[(2,2)].bus) == closed
        @test bindings[(1,1)].bus == bindings[(2,1)].bus
        @test bindings[(2,2)].bus == bindings[(3,1)].bus == bindings[(4,1)].bus
        @test bindings[(4,2)].bus == bindings[(5,1)].bus
        push!(components, component(99, "breaker"; status=closed))
        with_unused = EC.compile_network(components, connections)
        unused = filter(t -> t.component_id == 99, with_unused.terminal_buses)
        @test length(unused) == 2
        @test all(t.bus === nothing && t.omitted_reason === :unused_switch for t in unused)
        @test length(with_unused.buses) == length(net.buses)
    end
end

@testset "Result provenance retains global bus IDs across powered islands" begin
    cs, es = fixture()
    push!(cs, component(99, "disconnector"; status=false))
    other_cs, other_es = fixture()
    append!(cs, [RawComponent(c.id+100, c.code, copy(c.params), c.x+999, c.y-999, c.rotation) for c in other_cs])
    append!(es, [connection(e.from+100,e.to+100,e.from_port,e.to_port) for e in other_es])
    result = calculate(cs, es)
    map = result["topology"]
    @test map["schema_version"] == 1
    @test map["node_numbering"] == "min-component-terminal"
    physical = Set(t["bus_id"] for t in map["terminals"] if t["bus_id"] !== nothing)
    internal = Set(t["bus_id"] for t in map["internal_nodes"])
    @test isempty(intersect(physical, internal))
    @test union(physical, internal) == Set(n["node_id"] for n in result["nodes"])
    @test length(map["terminals"]) == 16
    @test length(map["internal_nodes"]) == 2
    for source in result["sources"]
        t = only(filter(t -> t["component_id"] == source["component_id"], map["terminals"]))
        emf = only(filter(n -> n["component_id"] == source["component_id"], map["internal_nodes"]))
        @test t["terminal"] == 1 && t["bus_id"] == source["terminal_bus"]
        @test emf["role"] == "source_emf" && emf["bus_id"] == source["internal_bus"]
    end
    @test calculate(reverse(cs), [connection(e.to,e.from,e.to_port,e.from_port) for e in reverse(es)])["topology"] == map
    @test all(t["bus_id"] === nothing for t in map["terminals"] if t["component_id"] == 99)
    @test abs(result["balance"]["residual_p_mw"]) < 1e-6
    @test abs(result["balance"]["residual_q_mvar"]) < 1e-6
end
