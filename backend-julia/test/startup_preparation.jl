using Sockets

@testset "Backend preparation fails before publishing a listening socket" begin
    probe = listen(ip"127.0.0.1", 0)
    port = Int(getsockname(probe)[2])
    close(probe)
    bad = EC.ComputeBackend("broken", (args...; kwargs...) -> error("preparation failure fixture"), (id="broken",))
    @test_throws ErrorException EC.start_server(;host="127.0.0.1",port,backends=(bad,))
    # A failed backend must not leave a supposedly ready server behind.
    replacement = listen(ip"127.0.0.1",port)
    close(replacement)
    @test_throws ErrorException EC.prepare_worker(())
    @test_throws ErrorException EC.prepare_worker((EC.julia_backend(),EC.julia_backend()))
end

@testset "Prepared server retains normal request-owned execution budgets" begin
    server = EC.start_server(;host="127.0.0.1",port=0)
    try
        url = "http://127.0.0.1:$(HTTP.port(server))"
        ready = HTTP.get(url*"/ready";proxy=HTTP.ProxyConfig())
        @test ready.status == 200
        @test collect(JSON.parse(ready.body).compute_backends) == ["julia"]
        input = read(joinpath(@__DIR__,"reference","json-wire-v1","json3-worker-input-v1.json"))
        response = HTTP.post(url*"/calculate",["Content-Type"=>"application/json"],input;
            proxy=HTTP.ProxyConfig(),status_exception=false)
        @test response.status == 200
        body = JSON.parse(response.body)
        @test body.success === true
        @test body.solver.execution.max_time_ms == 20_000
        @test body.solver.execution.policy == "cooperative-checkpoints-v1"
    finally
        HTTP.forceclose(server)
    end
end
