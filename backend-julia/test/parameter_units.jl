@testset "Declared catalogue units cannot silently change model scale" begin
    payload = Dict("components" => [
        Dict("id"=>1,"type"=>"generator","params"=>Dict("p"=>"0","r"=>"0.1","x"=>"0.5","e"=>"10","voltage_nom"=>"10")),
        Dict("id"=>2,"type"=>"load","params"=>Dict("p"=>"10","q"=>"3","voltage_nom"=>"10"))],
        "connections"=>[Dict("from"=>1,"to"=>2,"fromPort"=>"bottom","toPort"=>"top")],
        "base"=>Dict("s_base_mva"=>100,"v_base_kv"=>10))
    baseline = handle_request(HTTP.Request("POST","/calculate",[],JSON.json(payload)))
    @test baseline.status == 200
    before = JSON.parse(baseline.body)
    source, load = payload["components"]
    source["parameterUnits"] = Dict("p"=>"МВт","r"=>"Ом","x"=>"Ω","e"=>"кВ","voltage_nom"=>"kV")
    load["parameterUnits"] = Dict("p"=>"MW","q"=>"Мвар","voltage_nom"=>"кВ")
    accepted = handle_request(HTTP.Request("POST","/calculate",[],JSON.json(payload)))
    @test accepted.status == 200
    after = JSON.parse(accepted.body)
    @test after.nodes == before.nodes
    @test after.branches == before.branches
    @test after.balance == before.balance
    # Each declaration is at a different scale, dimension, or unknown. None
    # may be reinterpreted as MW, irrespective of the numeric string "10".
    for bad in ("W", "Вт", "kW", "mW", "MVAR", "p.u.", "", "bananas")
        load["parameterUnits"]["p"] = bad
        response = handle_request(HTTP.Request("POST","/calculate",[],JSON.json(payload)))
        body = JSON.parse(response.body)
        @test response.status == 400
        @test body.error_detail.code == "parameter_unit_mismatch"
        @test occursin("load#2.parameterUnits.p", body.error_detail.detail)
    end
end

@testset "Unit aliases, topology metadata and malformed declarations" begin
    for (unit, aliases) in EC.PARAMETER_UNIT_ALIASES, alias in aliases
        # Use real published keys; no independent duplicate expected-unit map.
        candidates = [(code, spec["key"]) for code in ("generator","transformer","transmission_line","load","capacitor")
            for spec in EC.model_parameters(code) if spec["unit"] == unit]
        code, key = first(candidates)
        @test EC.validate_parameter_units(code, Dict(key=>"1"), Dict(key=>alias), "fixture") === nothing
    end
    for code in ("busbar","breaker","disconnector","ground")
        @test EC.validate_parameter_units(code, Dict("voltage_nom"=>"10"), Dict("voltage_nom"=>"кВ"), "fixture") === nothing
        @test_throws EnersyError EC.validate_parameter_units(code, Dict("voltage_nom"=>"10"), Dict("voltage_nom"=>"V"), "fixture")
    end
    for declaration in (nothing, [], Dict("p"=>10), Dict("p"=>true), Dict("missing"=>"MW"))
        @test_throws EnersyError EC.validate_parameter_units("load", Dict("p"=>"10"), declaration, "load#2.parameterUnits")
    end
    @test EC.validate_parameter_units("load", Dict("p"=>"10"), Dict{String,String}(), "fixture") === nothing
    @test EC.validate_parameter_units("capacitor", Dict("c"=>"100"), Dict("c"=>"мкФ"), "fixture") === nothing
end
