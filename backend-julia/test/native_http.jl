@testset "Explicit native HTTP selection and request-owned resources" begin
    native = RJ.native_backend(LIBRARY)
    backends = (EC.julia_backend(),native)
    refs = JSON.parse(read(joinpath(@__DIR__,"reference","ac-networks-v1.json"),String))
    scheme = JSON.parse(JSON.json(first(refs.compiled_networks).scheme),Dict{String,Any})
    server = EC.start_server(;host="127.0.0.1",port=0,backends)
    try
        url = "http://127.0.0.1:$(HTTP.port(server))"
        ready = JSON.parse(HTTP.get(url*"/ready";proxy=HTTP.ProxyConfig()).body)
        @test collect(ready.compute_backends) == ["julia","julia-rust-jacobian"]
        post(body) = HTTP.post(url*"/calculate",["Content-Type"=>"application/json"],
            JSON.json(body);status_exception=false,proxy=HTTP.ProxyConfig())
        baseline_response = post(scheme)
        if baseline_response.status != 200
            @error "Native HTTP baseline failed" status=baseline_response.status body=String(copy(baseline_response.body))
        end
        @test baseline_response.status == 200
        baseline = JSON.parse(baseline_response.body)
        @test baseline.solver.compute_backend.id == "julia"
        target = first(t for t in baseline.topology.terminals if t.bus_id !== nothing)
        voltage = only(n.voltage for n in baseline.nodes if n.node_id == target.bus_id)
        study_limit = Dict("component_id"=>target.component_id,"terminal"=>target.terminal,
            "min_kv"=>voltage*1.1,"max_kv"=>voltage*1.2)
        assessments = []
        for selection in ("julia","julia-rust-jacobian")
            assessed = post(merge(scheme,Dict("computeBackend"=>selection,"operatingLimits"=>[study_limit])))
            @test assessed.status == 200
            assessment = JSON.parse(assessed.body).operating_assessment
            @test assessment.status == "violated" && only(assessment.checks).status == "below_min"
            push!(assessments,assessment)
        end
        @test assessments[1] == assessments[2]
        for selection in ("julia-rust-jacobian","julia")
            response = post(merge(scheme,Dict("computeBackend"=>selection)))
            @test response.status == 200
            result = JSON.parse(response.body)
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
        unavailable = EC.handle_request(HTTP.Request("POST","/calculate",[],JSON.json(request)))
        @test unavailable.status == 422
        @test JSON.parse(unavailable.body).error_detail.code == "compute_backend_unavailable"
        responses = @sync [@async post(merge(scheme,Dict("computeBackend"=>(isodd(i) ? "julia" : "julia-rust-jacobian")))) for i in 1:8]
        for (i,task) in enumerate(responses)
            response = fetch(task)
            @test response.status == 200
            @test JSON.parse(response.body).solver.compute_backend.id == (isodd(i) ? "julia" : "julia-rust-jacobian")
        end
        RJ.with_library(LIBRARY) do library
            @test RJ.live_plans(library) == 0
        end
    finally
        HTTP.forceclose(server)
    end
end
