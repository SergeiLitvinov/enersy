# Network acceptance for A04/A06/A07/A08. No manually started service is needed.
@testset "Historical audit: real HTTP rejection and recovery" begin
    server = start_server(; host="127.0.0.1", port=0)
    try
        url = "http://127.0.0.1:$(HTTP.port(server))"
        post(path, body) = HTTP.post(url * path, ["Content-Type" => "application/json"],
            JSON3.write(body); proxy=HTTP.ProxyConfig(), status_exception=false)
        linear = Dict("A" => [[2, 3], [1, 4]], "b" => [5, 7])
        cases = [
            ([], "type_error"),
            (Dict("A" => [], "b" => [1]), "empty_matrix"),
            (Dict("A" => [[1, 2], [3]], "b" => [1, 2]), "ragged_matrix"),
            (Dict("A" => [[1, 2]], "b" => [1]), "non_square_matrix"),
            (Dict("A" => [[1]], "b" => []), "empty_vector"),
            (Dict("A" => [[1]], "b" => [1, 2]), "dimension_mismatch"),
            (Dict("A" => [["invalid"]], "b" => [1]), "type_error"),
            (Dict("A" => [[1]], "b" => [nothing]), "type_error"),
        ]
        for (body, code) in cases
            @testset "$code" begin
                response = post("/solve", body)
                parsed = JSON3.read(response.body)
                @test response.status == 400
                @test startswith(HTTP.header(response, "Content-Type"), "application/json")
                @test parsed.success === false
                @test parsed.error_detail.kind == "CONTRACT"
                @test parsed.error_detail.code == code
                # A malformed request must not poison the next valid solve.
                recovered = post("/solve", linear)
                @test recovered.status == 200
                @test JSON3.read(recovered.body).solution ≈ [-0.2, 1.8] atol=1e-12
            end
        end
        for (group, method) in [("three-phase", "direct"),
                                ("phase-coordinates", "newton-raphson")]
            response = post("/calculate", Dict("components" => [], "connections" => [],
                "modelGroup" => group, "method" => method))
            parsed = JSON3.read(response.body)
            @test response.status == 422
            @test parsed.success === false
            @test parsed.error_detail.kind == "UNSUPPORTED"
            @test parsed.error_detail.code == "unsupported_method"
        end
        # A07: serialized DTOs really cross JSON3 and the socket boundary.
        cs, es = fixture()
        payload = Dict("components" => [Dict("id" => c.id, "type" => c.code,
            "params" => c.params) for c in cs], "connections" => [Dict("from" => e.from,
            "to" => e.to, "fromPort" => e.from_port, "toPort" => e.to_port) for e in es])
        response = post("/calculate", payload)
        parsed = JSON3.read(response.body)
        @test response.status == 200
        @test parsed.success === true
        @test abs(parsed.balance.residual_p_mw) < 1e-6
        @test abs(parsed.balance.residual_q_mvar) < 1e-6
        invalid = deepcopy(payload)
        invalid["components"][1]["id"] = "invalid-id"
        response = post("/calculate", invalid)
        @test response.status == 400
        @test JSON3.read(response.body).error_detail.kind == "CONTRACT"
        @test post("/calculate", payload).status == 200
    finally
        HTTP.forceclose(server)
    end
end
