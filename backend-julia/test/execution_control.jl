using SparseArrays

@testset "Request-owned cancellation and monotonic deadlines" begin
    Y = sparse(ComplexF64[1 -1; -1 1])
    setup = EC.PowerFlowSetup(2,1,1.0,0.0,Int[],[2],Float64[],Float64[],[-0.2],[0.0])
    options = SolverOptions(1e-12,50)
    now = Ref(UInt64(100))
    control = CalculationControl(;max_time_ms=1,clock=()->now[])
    @test EC.execution_checkpoint(control,:before) === nothing
    now[] += UInt64(1_000_000)
    deadline = try EC.execution_checkpoint(control,:expired,3) catch e; e end
    @test deadline isa EnersyError && deadline.kind == EXECUTION
    @test deadline.code == "calculation_deadline_exceeded"
    @test EC.http_status(deadline) == 504
    @test occursin("stage=expired iteration=3",deadline.detail)
    for invalid in (0,-1,true)
        @test_throws EnersyError CalculationControl(;max_time_ms=invalid)
    end
    # time_ns uses a wrapping UInt64 counter; elapsed arithmetic remains valid.
    now[] = typemax(UInt64)-UInt64(500_000)
    wrapped = CalculationControl(;max_time_ms=1,clock=()->now[])
    now[] += UInt64(1_000_000)
    @test_throws EnersyError EC.execution_checkpoint(wrapped,:wrapped)

    cancelled = CalculationControl()
    canceller = @async cancel_calculation!(cancelled)
    stopped = try EC.newton_raphson(Y,setup,options;control=cancelled) catch e; e end
    wait(canceller)
    @test stopped isa EnersyError && stopped.code == "calculation_cancelled"
    @test EC.http_status(stopped) == 409
    fresh = EC.newton_raphson(Y,setup,options;control=CalculationControl())
    @test fresh.v[2] ≈ (1+sqrt(0.2))/2 atol=1e-11
    @test fresh.max_mismatch < 1e-12

    # Stop after a genuine assembled Jacobian, before linear factorization.
    cancelled = CalculationControl()
    builder = function (args...)
        matrix = EC.jacobian(args...)
        cancel_calculation!(cancelled)
        matrix
    end
    stopped = try EC.newton_raphson(Y,setup,options;control=cancelled,jacobian_builder=builder) catch e; e end
    @test stopped isa EnersyError && stopped.kind == EXECUTION
    @test occursin("stage=jacobian_assembly",stopped.detail)
    ct, cv = EC.unknown_columns(setup)
    @test_throws EnersyError EC.backtracked_step(Y,setup,[1.0,0.8],zeros(2),zeros(2),ct,cv,1.0,1;control=cancelled)
end

@testset "Expired completed island is never published as a partial success" begin
    case = first(JSON3.read(read(joinpath(@__DIR__,"reference","ac-networks-v1.json"),String)).compiled_networks)
    cs, es, _, _, base, options, _ = EC.parse_calculate_request(case.scheme)
    now = Ref(UInt64(0))
    control = CalculationControl(;max_time_ms=1,clock=()->now[])
    original = EC.julia_backend()
    late = EC.ComputeBackend("julia", function (Y,setup,opts,limits;kwargs...)
        result = original.solve(Y,setup,opts,limits;kwargs...)
        now[] += UInt64(1_000_000)
        result
    end, original.metadata)
    stopped = try calculate(cs,es;base,options,backend=late,control) catch e; e end
    @test stopped isa EnersyError && stopped.code == "calculation_deadline_exceeded"
    @test occursin("stage=island_finished",stopped.detail)
    valid = calculate(cs,es;base,options,control=CalculationControl())
    @test valid["success"] === true
    @test valid["solver"]["execution"]["max_time_ms"] === nothing
end

@testset "HTTP execution budgets reject invalid input and recover after expiry" begin
    case = first(JSON3.read(read(joinpath(@__DIR__,"reference","ac-networks-v1.json"),String)).compiled_networks)
    body = JSON3.read(JSON3.write(case.scheme),Dict{String,Any})
    original = EC.julia_backend()
    delayed = EC.ComputeBackend("julia", function (Y,setup,opts,limits;kwargs...)
        sleep(0.02) # Test-only latency; the production physical solver is unchanged.
        original.solve(Y,setup,opts,limits;kwargs...)
    end, original.metadata)
    server = EC.start_server(;host="127.0.0.1",port=0,backends=(delayed,))
    try
        url = "http://127.0.0.1:$(HTTP.port(server))/calculate"
        post(options) = HTTP.post(url,["Content-Type"=>"application/json"],JSON3.write(merge(body,Dict("executionOptions"=>options)));
            proxy=HTTP.ProxyConfig(),status_exception=false)
        for invalid in (0,-1,true,nothing,"10",20_001)
            @test post(Dict("max_time_ms"=>invalid)).status == 400
        end
        @test post(Dict("ignored_timeout"=>10)).status == 400
        @test post([]).status == 400
        expired = post(Dict("max_time_ms"=>1))
        @test expired.status == 504
        @test JSON3.read(expired.body).error_detail.kind == "EXECUTION"
        @test JSON3.read(expired.body).error_detail.code == "calculation_deadline_exceeded"
        recovered = post(Dict("max_time_ms"=>20_000))
        @test recovered.status == 200
        execution = JSON3.read(recovered.body).solver.execution
        @test execution.max_time_ms == 20_000
        @test execution.native_calls_interruptible === false
        @test execution.disconnect_cancels === false
    finally
        HTTP.forceclose(server)
    end
end
