@testset "Explicit study voltage limits preserve the physical solution" begin
    # One 1-ohm source branch feeds 0.2 MW at unity power factor, E=1 kV.
    # P=V(E-V)/R gives V=(1+sqrt(1-4*0.2))/2 kV on the high root.
    cs = [RawComponent(1,"generator",Dict("e"=>"1","voltage_nom"=>"1","r"=>"1","x"=>"0","p"=>"0.2"),0.,0.,0),
          RawComponent(2,"load",Dict("p"=>"0.2","q"=>"0","voltage_nom"=>"1"),200.,0.,0)]
    es = [RawConnection(1,2,"bottom","top")]
    options = SolverOptions(1e-12,50)
    plain = calculate(cs,es;options)
    @test plain["operating_assessment"]["status"] == "not_declared"
    @test isempty(plain["operating_assessment"]["checks"])
    expected = (1+sqrt(1-4*0.2))/2
    for (low,high,status) in ((0.7,0.8,"within_bounds"),(0.8,0.9,"below_min"),(0.5,0.6,"above_max"))
        result = calculate(cs,es;options,operating_limits=[TerminalVoltageLimit(2,1,low,high)])
        assessment = result["operating_assessment"]
        check = only(assessment["checks"])
        @test result["success"] === true
        @test result["nodes"] == plain["nodes"]
        @test check["measured"] ≈ expected atol=1e-10
        @test check["status"] == status
        @test check["unit"] == "kV" && check["component_id"] == 2 && check["terminal"] == 1
        @test assessment["status"] == (status == "within_bounds" ? "within_declared_bounds" : "violated")
        @test assessment["stability_assessed"] === false
    end
    measured = only(n["voltage"] for n in plain["nodes"] if !n["is_internal_source_node"])
    exact = [TerminalVoltageLimit(2,1,measured,measured)]
    @test calculate(cs,es;options,operating_limits=exact)["operating_assessment"]["status"] == "within_declared_bounds"
    moved = [RawComponent(c.id,c.code,c.params,-c.x+5000,c.y-800,90) for c in reverse(cs)]
    @test calculate(moved,reverse(es);options,operating_limits=exact)["operating_assessment"] ==
        calculate(cs,es;options,operating_limits=exact)["operating_assessment"]
    original = EC.julia_backend()
    uncalled = EC.ComputeBackend("julia", (args...;kwargs...)->error("solver must not run"), original.metadata)
    for (limits,code) in (([TerminalVoltageLimit(999,1,0.7,0.8)],"unknown_limit_terminal"),
                         ([TerminalVoltageLimit(2,99,0.7,0.8)],"unknown_limit_terminal"),
                         (vcat(exact,exact),"duplicate_operating_limit"))
        err = try calculate(cs,es;options,operating_limits=limits,backend=uncalled) catch e; e end
        @test err isa EnersyError && err.code == code
    end
    payload = Dict("components"=>[Dict("id"=>c.id,"type"=>c.code,"params"=>c.params) for c in cs],
        "connections"=>[Dict("from"=>1,"to"=>2,"from_port"=>"bottom","to_port"=>"top")])
    target = Dict("component_id"=>2,"terminal"=>1,"min_kv"=>0.8,"max_kv"=>0.9)
    post(limits) = EC.handle_request(HTTP.Request("POST","/calculate",[],JSON.json(merge(payload,Dict("operatingLimits"=>limits)))))
    response = post([target])
    @test response.status == 200
    @test JSON.parse(response.body).operating_assessment.status == "violated"
    for invalid in (nothing,Dict(),[merge(target,Dict("unit"=>"V"))],
                    [merge(target,Dict("component_id"=>true))],[merge(target,Dict("terminal"=>1.5))],
                    [merge(target,Dict("min_kv"=>"0.8"))],[merge(target,Dict("min_kv"=>0))],
                    [merge(target,Dict("max_kv"=>0.7))],[merge(target,Dict("max_kv"=>nothing))])
        @test post(invalid).status == 400
    end
    for args in ((true,1,0.7,0.8),(1,0,0.7,0.8),(1,1,NaN,0.8),(1,1,0.7,Inf))
        @test_throws EnersyError TerminalVoltageLimit(args...)
    end
    unused = RawComponent(3,"breaker",Dict("status"=>"false","voltage_nom"=>"1"),0.,0.,0)
    err = try calculate(vcat(cs,[unused]),es;operating_limits=[TerminalVoltageLimit(3,1,0.7,0.8)],backend=uncalled) catch e; e end
    @test err isa EnersyError && err.code == "omitted_limit_terminal" && err.kind == UNSUPPORTED
    # Two independent islands: the second target must bind to the global node.
    shifted = [RawComponent(c.id+100,c.code,c.params,c.x,c.y,0) for c in cs]
    double = calculate(vcat(cs,shifted),vcat(es,[RawConnection(101,102,"bottom","top")]);options,
        operating_limits=[TerminalVoltageLimit(2,1,0.7,0.8),TerminalVoltageLimit(102,1,0.8,0.9)])
    checks = double["operating_assessment"]["checks"]
    @test [c["status"] for c in checks] == ["within_bounds","below_min"]
    @test checks[1]["bus_id"] != checks[2]["bus_id"]
    @test all(c -> isapprox(c["measured"],expected;atol=1e-10),checks)
end
