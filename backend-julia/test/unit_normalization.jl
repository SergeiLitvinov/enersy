@testset "Scaled AC units: dimensions, precision and immutable originals" begin
    for (code, key, unit, text, expected) in [
        ("load", "p", "W", "12300000.0000", 12.3),
        ("load", "p", "mW", "1000000000", 1.0),
        ("load", "p", "МВт", "1.2300", 1.23),
        ("load", "q", "kvar", "3000", 3.0),
        ("load", "voltage_nom", "В", "10000.0000", 10.0),
        ("generator", "r", "mOhm", "100", 0.1),
        ("generator", "x", "kΩ", "0.0005", 0.5),
        ("generator", "angle", "rad", string(pi/6), 30.0),
        ("transformer", "power_nom", "VA", "100000000", 100.0),
        ("transformer", "u_kz", "1", "0.1", 10.0),
        ("transmission_line", "length", "m", "2000", 2.0),
        ("transmission_line", "r0", "Ohm/m", "0.0001", 0.1),
        ("transmission_line", "b0", "µS/km", "10", 1e-5),
    ]
        original = Dict(key=>text)
        normalized = EC.normalize_parameter_units(code, original, Dict(key=>unit), "fixture")
        @test parse(Float64, normalized[key]) ≈ expected rtol=1e-14
        @test original == Dict(key=>text)
        unit in get(EC.PARAMETER_UNIT_ALIASES, EC.AC_PARAMETER_UNIT_SPECS[code][key], ()) && @test normalized[key] == text
    end
    @test EC.normalize_parameter_units("load", Dict("zip_enabled"=>"true", "p"=>""), Dict("zip_enabled"=>"1", "p"=>"W"), "fixture") == Dict("zip_enabled"=>"true", "p"=>"")
    @test_throws EnersyError EC.parse_component(Dict("id"=>1,"type"=>"load","params"=>Dict("p"=>"1")), "fixture"; scaling=true)
    for (text, unit) in [("1e-400", "MW"), ("5e-324", "W"), ("Inf", "MW"), ("NaN", "W"), ("1e309", "W"), ("bad", "W")]
        @test_throws EnersyError EC.normalize_parameter_units("load", Dict("p"=>text), Dict("p"=>unit), "fixture")
    end
    @test_throws EnersyError EC.normalize_parameter_units("transmission_line", Dict("r0"=>"1e308"), Dict("r0"=>"Ohm/m"), "fixture")
    for unit in ("p.u.", "V", "", " W", "W ", "bananas")
        @test_throws EnersyError EC.normalize_parameter_units("load", Dict("p"=>"1"), Dict("p"=>unit), "fixture")
    end
end

@testset "Scaled AC HTTP profile matches an independent physical quadratic" begin
    payload = Dict{String,Any}("unitContract"=>Dict("formatVersion"=>1,"profile"=>EC.AC_SCALED_INPUT_UNIT_PROFILE),
        "components"=>[
            Dict("id"=>1,"type"=>"generator","params"=>Dict("p"=>"0","r"=>"100","x"=>"500","e"=>"10000","voltage_nom"=>"10000","angle"=>"0.1"),
                 "parameterUnits"=>Dict("p"=>"W","r"=>"mOhm","x"=>"mOhm","e"=>"V","voltage_nom"=>"V","angle"=>"rad")),
            Dict("id"=>2,"type"=>"load","params"=>Dict("p"=>"10000000.0000","q"=>"3000000.0000","voltage_nom"=>"10000"),
                 "parameterUnits"=>Dict("p"=>"W","q"=>"var","voltage_nom"=>"V"))],
        "connections"=>[Dict("from"=>1,"to"=>2,"fromPort"=>"bottom","toPort"=>"top")],
        "base"=>Dict("s_base_mva"=>100,"v_base_kv"=>10))
    send(value) = handle_request(HTTP.Request("POST","/calculate",[],JSON.json(value)))
    frozen = deepcopy(payload)
    response = send(payload)
    @test response.status == 200
    body = JSON.parse(response.body)
    @test body.success
    @test body.input_unit_contract.profile == EC.AC_SCALED_INPUT_UNIT_PROFILE
    @test body.input_unit_contract.validation_scope == "request-declarations-with-scale-normalization"
    @test body.input_unit_contract.parameter_count == 9
    @test payload == frozen
    # E_LL=10 kV, Z_phase=.1+j.5 Ohm, S_3phase=10+j3 MVA.
    # V/E solves Re(V/E)^2-Re(V/E)+.025+.047^2=0 and Im(V/E)=-.047.
    re, im = (1+sqrt(1-4*.025-4*.047^2))/2, -.047
    node = only(filter(row->!row.is_internal_source_node, body.nodes))
    @test abs(node.voltage-10*hypot(re,im)) <= 1e-8
    @test abs(node.angle_rad-(0.1+atan(im,re))) <= 1e-9
    derived = deepcopy(payload); delete!(derived,"base")
    result = JSON.parse(send(derived).body)
    @test result.base.v_base_kv == 10
    @test abs(only(filter(row->!row.is_internal_source_node,result.nodes)).voltage-node.voltage) <= 1e-9
    legacy = deepcopy(payload); legacy["unitContract"]["profile"] = EC.AC_INPUT_UNIT_PROFILE
    @test send(legacy).status == 400
    bad = deepcopy(payload); delete!(bad["components"][2]["parameterUnits"],"p")
    @test send(bad).status == 400
end
