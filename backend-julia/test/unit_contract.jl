@testset "Complete versioned AC input unit contract" begin
    payload = Dict{String,Any}("unitContract"=>Dict("formatVersion"=>1,"profile"=>"legacy-ac-three-phase-rms-v1"),
        "components"=>[
            Dict("id"=>1,"type"=>"generator","params"=>Dict("p"=>"0","r"=>"0.1","x"=>"0.5","e"=>"10","voltage_nom"=>"10"),
                 "parameterUnits"=>Dict("p"=>"MW","r"=>"Ohm","x"=>"Ω","e"=>"kV","voltage_nom"=>"кВ")),
            Dict("id"=>2,"type"=>"load","params"=>Dict("p"=>"10","q"=>"3","voltage_nom"=>"10"),
                 "parameterUnits"=>Dict("p"=>"MW","q"=>"Mvar","voltage_nom"=>"kV"))],
        "connections"=>[Dict("from"=>1,"to"=>2,"fromPort"=>"bottom","toPort"=>"top")],
        "base"=>Dict("s_base_mva"=>100,"v_base_kv"=>10))
    send(value) = handle_request(HTTP.Request("POST","/calculate",[],JSON.json(value)))
    frozen = deepcopy(payload)
    response = send(payload)
    @test response.status == 200
    body = JSON.parse(response.body)
    @test body.input_unit_contract.formatVersion == 1
    @test body.input_unit_contract.profile == "legacy-ac-three-phase-rms-v1"
    @test body.input_unit_contract.validation_scope == "request-declarations-only"
    @test body.input_unit_contract.component_count == 2
    @test body.input_unit_contract.parameter_count == 8
    @test payload == frozen
    # Independent E=10 kV, Z=.1+j.5 Ohm, S=10+j3 MVA quadratic.
    # Re(V/E) = (1+sqrt(1-4*.025-4*.047^2))/2; Im(V/E)=-.047.
    re, im = (1+sqrt(1-4*.025-4*.047^2))/2, -.047
    physical = filter(row->!row.is_internal_source_node,body.nodes)
    @test length(physical) == 1
    @test abs(only(physical).voltage-10*hypot(re,im)) <= 1e-8
    @test abs(only(physical).angle_rad-atan(im,re)) <= 1e-9
    legacy = deepcopy(payload); delete!(legacy,"unitContract")
    before = JSON.parse(send(legacy).body)
    @test body.nodes == before.nodes
    @test body.branches == before.branches
    @test body.balance == before.balance
    @test !haskey(before,"input_unit_contract")

    for declaration in (nothing,[],"1",Dict(),Dict("formatVersion"=>1),
            Dict("formatVersion"=>1,"profile"=>"unknown"),
            Dict("formatVersion"=>1,"profile"=>EC.AC_INPUT_UNIT_PROFILE,"extra"=>true))
        bad = deepcopy(payload); bad["unitContract"] = declaration
        result = send(bad)
        @test result.status == 400
        @test occursin("unitContract",JSON.parse(result.body).error_detail.detail)
    end
    for version in (true,false,1.0,"1",0,2)
        bad = deepcopy(payload); bad["unitContract"]["formatVersion"] = version
        result = send(bad)
        @test result.status == 400
        @test JSON.parse(result.body).error_detail.code == "unsupported_unit_contract_version"
    end
    for key in ("p","q","voltage_nom")
        bad = deepcopy(payload); delete!(bad["components"][2]["parameterUnits"],key)
        result = send(bad)
        @test result.status == 400
        @test JSON.parse(result.body).error_detail.code == "missing_parameter_unit"
        @test occursin("load#2.parameterUnits.$key",JSON.parse(result.body).error_detail.detail)
    end
    bad = deepcopy(payload); delete!(bad["components"][2],"parameterUnits")
    result = send(bad)
    @test result.status == 400
    @test JSON.parse(result.body).error_detail.code == "missing_parameter_units"
    for unit in ("W","kW","mW","p.u.","","bananas")
        bad = deepcopy(payload); bad["components"][2]["parameterUnits"]["p"] = unit
        result = send(bad)
        @test result.status == 400
        @test JSON.parse(result.body).error_detail.code == "parameter_unit_mismatch"
    end
    bad = deepcopy(payload)
    bad["components"][2]["params"]["unreviewed"] = "1"
    bad["components"][2]["parameterUnits"]["unreviewed"] = "MW"
    result = send(bad)
    @test result.status == 400
    @test JSON.parse(result.body).error_detail.code == "unsupported_unit_contract_parameter"
    @test occursin("load#2.parameterUnits.unreviewed",JSON.parse(result.body).error_detail.detail)
    bad = deepcopy(payload); bad["components"][2]["parameterUnits"]["absent"] = "MW"
    result = send(bad)
    @test result.status == 400
    @test JSON.parse(result.body).error_detail.code == "unexpected_parameter_unit"
    @test EC.validate_parameter_units("breaker",Dict("status"=>"true"),Dict("status"=>"1"),"fixture";complete=true) === nothing
    @test_throws EnersyError EC.validate_parameter_units("breaker",Dict("status"=>"true"),Dict("status"=>""),"fixture";complete=true)
    @test_throws EnersyError EC.validate_parameter_units("unknown",Dict{String,String}(),Dict(),"fixture";complete=true)
    @test EC.validate_parameter_units("busbar",Dict{String,String}(),Dict(),"fixture";complete=true) === nothing
    @test EC.validate_parameter_units("transformer",Dict("phase_shift_deg"=>"30"),Dict("phase_shift_deg"=>"deg"),"fixture";complete=true) === nothing
    @test_throws EnersyError EC.validate_parameter_units("transformer",Dict("phase_shift_deg"=>"30"),Dict("phase_shift_deg"=>"rad"),"fixture";complete=true)
    @test EC.validate_parameter_units("load",Dict("zip_p_z"=>"0.2"),Dict("zip_p_z"=>"1"),"fixture";complete=true) === nothing

    server = start_server(;host="127.0.0.1",port=0)
    try
        url = "http://127.0.0.1:$(HTTP.port(server))/calculate"
        wire = HTTP.post(url,[],JSON.json(payload);proxy=HTTP.ProxyConfig())
        wire_body = JSON.parse(wire.body)
        @test wire.status == 200
        @test wire_body.input_unit_contract == body.input_unit_contract
        @test abs(only(filter(row->!row.is_internal_source_node,wire_body.nodes)).voltage-10*hypot(re,im)) <= 1e-8
        invalid = deepcopy(payload); delete!(invalid["components"][2]["parameterUnits"],"p")
        rejected = HTTP.post(url,[],JSON.json(invalid);proxy=HTTP.ProxyConfig(),status_exception=false)
        rejection = JSON.parse(rejected.body)
        @test rejected.status == 400
        @test rejection.error_detail.code == "missing_parameter_unit"
        @test rejection.success === false
        @test !haskey(rejection,"nodes")
    finally
        HTTP.forceclose(server)
    end
end
