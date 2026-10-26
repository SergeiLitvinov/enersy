@testset "Native Jacobian cancellation releases request plans" begin
    Y = sparse(ComplexF64[1 -1; -1 1])
    setup = EC.PowerFlowSetup(2,1,1.0,0.0,Int[],[2],Float64[],Float64[],[-0.2],[0.0])
    options = EC.SolverOptions(1e-12,50)
    RJ.with_library(LIBRARY) do library
        for action in (:cancel,:deadline)
            now = Ref(UInt64(0))
            control = EC.CalculationControl(;max_time_ms=1,clock=()->now[])
            stopped = try
                RJ.with_plan(library,Y,setup) do plan
                    ct, cv = EC.unknown_columns(setup)
                    builder = function (matrix,v,theta,p,q,current)
                        J = RJ.assemble(plan,matrix,v,theta,p,q,current)
                        action == :cancel ? EC.cancel_calculation!(control) : (now[] += UInt64(1_000_000))
                        J, ct, cv
                    end
                    EC.newton_raphson(Y,setup,options;control,jacobian_builder=builder)
                end
            catch e
                e
            end
            @test stopped isa EC.EnersyError && stopped.kind == EC.EXECUTION
            @test stopped.code == (action == :cancel ? "calculation_cancelled" : "calculation_deadline_exceeded")
            @test occursin("stage=jacobian_assembly",stopped.detail)
            @test RJ.live_plans(library) == 0
        end
        fresh = RJ.solve_newton(library,Y,setup,options;control=EC.CalculationControl())
        @test fresh.v[2] ≈ (1+sqrt(0.2))/2 atol=1e-11
        @test RJ.live_plans(library) == 0
        cancelled = EC.CalculationControl()
        EC.cancel_calculation!(cancelled)
        @test_throws EC.EnersyError RJ.solve_newton(library,Y,setup,options;control=cancelled)
        @test RJ.live_plans(library) == 0
    end
end

@testset "Native HTTP deadline failure does not poison the next request" begin
    native = RJ.native_backend(LIBRARY)
    delayed = EC.ComputeBackend(native.id, function (Y,setup,options,limits;kwargs...)
        sleep(0.02) # Failure fixture only; actual native solver follows unchanged.
        native.solve(Y,setup,options,limits;kwargs...)
    end, native.metadata)
    refs = JSON.parse(read(joinpath(@__DIR__,"reference","ac-networks-v1.json"),String))
    body = JSON.parse(JSON.json(first(refs.compiled_networks).scheme),Dict{String,Any})
    body["computeBackend"] = native.id
    server = EC.start_server(;host="127.0.0.1",port=0,backends=(delayed,))
    try
        url = "http://127.0.0.1:$(HTTP.port(server))/calculate"
        post(budget) = HTTP.post(url,["Content-Type"=>"application/json"],
            JSON.json(merge(body,Dict("executionOptions"=>Dict("max_time_ms"=>budget))));
            proxy=HTTP.ProxyConfig(),status_exception=false)
        expired = post(1)
        @test expired.status == 504
        @test JSON.parse(expired.body).error_detail.code == "calculation_deadline_exceeded"
        recovered = post(20_000)
        @test recovered.status == 200
        @test JSON.parse(recovered.body).solver.compute_backend.id == native.id
        @test JSON.parse(recovered.body).solver.execution.max_time_ms == 20_000
        RJ.with_library(LIBRARY) do library
            @test RJ.live_plans(library) == 0
        end
    finally
        HTTP.forceclose(server)
    end
end
