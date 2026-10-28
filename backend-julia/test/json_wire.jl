# Floating results are checked by independent numerical references elsewhere.
# This guard keeps the full recursive wire structure and discrete metadata exact.
function same_wire_contract(expected, actual)
    if expected isa AbstractDict
        actual isa AbstractDict || return false
        Set(keys(expected)) == Set(keys(actual)) || return false
        return all(keys(expected)) do key
            same_wire_contract(expected[key], actual[key]) &&
                (key != "computation_time_ms" ||
                 (actual[key] isa AbstractFloat && actual[key] >= 0))
        end
    elseif expected isa AbstractVector
        actual isa AbstractVector || return false
        length(expected) == length(actual) || return false
        return all(same_wire_contract(a, b) for (a, b) in zip(expected, actual))
    elseif expected isa AbstractFloat
        return actual isa AbstractFloat && isfinite(actual)
    else
        return typeof(expected) === typeof(actual) && isequal(expected, actual)
    end
end

@testset "Wire contract guard rejects structural and discrete mutations" begin
    original = JSON.parse("""{"id":9007199254740993,"success":true,"method":"lu","values":[1.0],"optional":null,"computation_time_ms":1.0}""")
    @test same_wire_contract(original, deepcopy(original))
    for (key, value) in (("id", 9007199254740992), ("success", 1),
            ("method", "qr"), ("values", Any[]), ("values", ["1.0"]),
            ("values", [Inf]), ("optional", "null"), ("computation_time_ms", -1.0))
        changed = deepcopy(original)
        changed[key] = value
        @test !same_wire_contract(original, changed)
    end
    missing = deepcopy(original)
    delete!(missing, "optional")
    @test !same_wire_contract(original, missing)
    extra = deepcopy(original)
    extra["extra"] = nothing
    @test !same_wire_contract(original, extra)
    rounded = deepcopy(original)
    rounded["values"] = [nextfloat(1.0)]
    @test same_wire_contract(original, rounded)
    # An equal-looking integer is not a floating result in the wire contract.
    rounded["values"] = [1]
    @test !same_wire_contract(original, rounded)
end

@testset "JSON transport compatibility with frozen JSON3 responses" begin
    directory = joinpath(@__DIR__, "reference", "json-wire-v1")
    input = read(joinpath(directory, "json3-worker-input-v1.json"))
    old_result = read(joinpath(directory, "json3-worker-result-v1.json"))
    provenance = JSON.parse(read(joinpath(directory, "json3-worker-provenance-v1.json")))
    @test provenance.codec == "JSON3"
    @test provenance.codec_version == "1.14.3"
    @test bytes2hex(EC.sha256(input)) == provenance.input_sha256
    @test bytes2hex(EC.sha256(old_result)) == provenance.result_sha256
    current = handle_request(HTTP.Request("POST", "/calculate", [], copy(input)))
    @test current.status == 200
    # Test codec preservation on identical data, not a second BLAS calculation:
    # CPU-dependent floating-point rounding belongs to the physical references.
    before = JSON.parse(old_result)
    @test JSON.parse(EC.json_response(200, before).body) == before
    @test JSON.parse(current.body).success === true
    @test same_wire_contract(before, JSON.parse(current.body))

    for fixture in JSON.parse(read(joinpath(directory, "json3-http-contract-v1.json")))
        response = handle_request(HTTP.Request("POST", "/solve", [], fixture.body))
        value = JSON.parse(response.body)
        if endswith(fixture.body, " trailing")
            # JSON3 silently accepted a valid prefix; the entire body is now required.
            @test response.status == 400
            @test value.error_detail.code == "invalid_json"
        else
            @test response.status == fixture.status
            before = JSON.parse(fixture.response)
            if response.status == 200
                @test JSON.parse(EC.json_response(200, before).body) == before
                @test same_wire_contract(before, value)
                @test value.success === true
            else
                @test value.success === false
                @test value.error_detail.code == before.error_detail.code
                @test value.error_detail.kind == before.error_detail.kind
            end
        end
    end
end

@testset "Strict JSON and exact integer identifiers" begin
    for body in ("{\"A\":[[1]],\"A\":[[2]],\"b\":[1]}",
                 "{\"A\":[[1]],\"b\":[NaN]}",
                 "{\"A\":[[1]],\"b\":[Infinity]}")
        response = handle_request(HTTP.Request("POST", "/solve", [], body))
        @test response.status == 400
        @test JSON.parse(response.body).error_detail.code == "invalid_json"
    end
    payload = (text="Кириллица Ω 😀\n\"\\", missing=nothing, empty=Any[],
        integer=Int64(9007199254740993), signed_zero=-0.0, tiny=nextfloat(0.0), large=floatmax(Float64))
    response = EC.json_response(200, payload)
    parsed = JSON.parse(response.body)
    @test parsed.text == payload.text
    @test haskey(parsed, "missing") && parsed.missing === nothing
    @test isempty(parsed.empty)
    @test parsed.integer == payload.integer
    @test signbit(parsed.signed_zero)
    @test parsed.tiny == payload.tiny
    @test parsed.large == payload.large
    for invalid in (NaN, Inf, -Inf)
        response = @test_logs (:error, r"не удалось сериализовать ответ") EC.json_response(200, (value=invalid,))
        @test response.status == 500
        @test JSON.parse(response.body).error_detail.code == "serialization_failure"
    end
    for id in (Int64(9007199254740993), typemax(Int64))
        parsed_id = JSON.parse(string(id))
        @test EC.as_int(parsed_id, "id"; positive=true) === id
    end
    @test_throws EnersyError EC.as_int(JSON.parse("9223372036854775808"), "id")
    @test_throws EnersyError EC.as_int(true, "id")
end
