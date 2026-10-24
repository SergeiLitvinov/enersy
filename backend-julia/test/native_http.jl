@testset "Explicit native HTTP selection and request-owned resources" begin
    native = RJ.native_backend(LIBRARY)
    backends = (EC.julia_backend(),native)
    refs = JSON3.read(read(joinpath(@__DIR__,"reference","ac-networks-v1.json"),String))
    scheme = JSON3.read(JSON3.write(first(refs.compiled_networks).scheme),Dict{String,Any})
    server = EC.start_server(;host="127.0.0.1",port=0,backends)
    try
        url = "http://127.0.0.1:$(HTTP.port(server))"
        ready = JSON3.read(HTTP.get(url*"/ready";proxy=HTTP.ProxyConfig()).body)
        @test collect(ready.compute_backends) == ["julia","julia-rust-jacobian"]
        post(body) = HTTP.post(url*"/calculate",["Content-Type"=>"application/json"],
            JSON3.write(body);status_exception=false,proxy=HTTP.ProxyConfig())
        baseline = JSON3.read(post(scheme).body)
        @test baseline.solver.compute_backend.id == "julia"
        target = first(t for t in baseline.topology.terminals if t.bus_id !== nothing)
        voltage = only(n.voltage for n in baseline.nodes if n.node_id == target.bus_id)
        study_limit = Dict("component_id"=>target.component_id,"terminal"=>target.terminal,
            "min_kv"=>voltage*1.1,"max_kv"=>voltage*1.2)
        assessments = []
        for selection in ("julia","julia-rust-jacobian")
            assessed = post(merge(scheme,Dict("computeBackend"=>selection,"operatingLimits"=>[study_limit])))
            @test assessed.status == 200
            assessment = JSON3.read(assessed.body).operating_assessment
            @test assessment.status == "violated" && only(assessment.checks).status == "below_min"
            push!(assessments,assessment)
        end
        @test assessments[1] == assessments[2]
        for selection in ("julia-rust-jacobian","julia")
            response = post(merge(scheme,Dict("computeBackend"=>selection)))
            @test response.status == 200
            result = JSON3.read(response.body)
            @test result.solver.compute_backend.id == selection
            @test maximum(abs,[n.voltage_pu for n in result.nodes]-[n.voltage_pu for n in baseline.nodes]) < 1e-10
            if selection == "julia-rust-jacobian"
                @test result.solver.compute_backend.library_sha256 == native.metadata.library_sha256
                @test length(result.solver.compute_backend.julia_core_sha256) == 64
                @test result.solver.compute_backend.linear_solver == "umfpack"
            end
        end
        for selection in ("arbitrary-library.so","/tmp/lib.so",Dict("path"=>LIBRARY),5)
            response = post(merge(scheme,Dict("computeBackend"=>selection)))
            @test response.status == (selection isa String ? 422 : 400)
        end
        request = merge(scheme,Dict("computeBackend"=>"julia-rust-jacobian"))
        unavailable = EC.handle_request(HTTP.Request("POST","/calculate",[],JSON3.write(request)))
        @test unavailable.status == 422
        @test JSON3.read(unavailable.body).error_detail.code == "compute_backend_unavailable"
        responses = @sync [@async post(merge(scheme,Dict("computeBackend"=>(isodd(i) ? "julia" : "julia-rust-jacobian")))) for i in 1:8]
        for (i,task) in enumerate(responses)
            response = fetch(task)
            @test response.status == 200
            @test JSON3.read(response.body).solver.compute_backend.id == (isodd(i) ? "julia" : "julia-rust-jacobian")
        end
        RJ.with_library(LIBRARY) do library
            @test RJ.live_plans(library) == 0
        end
    finally
        HTTP.forceclose(server)
    end
end
