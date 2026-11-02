source_base(s=10.0, v=10.0) = Dict{String,Any}("profile"=>"ac-three-phase-rms-v1", "s_base_mva"=>s, "v_base_kv"=>v)

function based_ac_fixture()
    generator = Dict{String,Any}("id"=>1,"type"=>"generator",
        "params"=>Dict("p"=>"0","r"=>"0.0100","x"=>"0.0500","e"=>"1.0000","voltage_nom"=>"1","angle"=>"0.1"),
        "parameterUnits"=>Dict("p"=>"p.u.","r"=>"p.u.","x"=>"p.u.","e"=>"p.u.","voltage_nom"=>"p.u.","angle"=>"rad"),
        "parameterBases"=>Dict{String,Any}(key=>source_base() for key in ("p","r","x","e","voltage_nom")))
    load = Dict{String,Any}("id"=>2,"type"=>"load",
        "params"=>Dict("p"=>"0.5000","q"=>"0.3000","voltage_nom"=>"1"),
        "parameterUnits"=>Dict("p"=>"p.u.","q"=>"p.u.","voltage_nom"=>"p.u."),
        "parameterBases"=>Dict{String,Any}("p"=>source_base(20,35),"q"=>source_base(10,110),"voltage_nom"=>source_base(100,10)))
    Dict{String,Any}("unitContract"=>Dict("formatVersion"=>1,"profile"=>EC.AC_BASED_INPUT_UNIT_PROFILE),
        "components"=>[generator,load], "connections"=>[Dict("from"=>1,"to"=>2,"fromPort"=>"bottom","toPort"=>"top")],
        "base"=>Dict("s_base_mva"=>50,"v_base_kv"=>20))
end

@testset "Parameter source bases: checked physical scaling against BigFloat" begin
    setprecision(BigFloat, 256) do
        for (unit, reference) in [("MW",(s,v)->s),("Mvar",(s,v)->s),("MVA",(s,v)->s),
                                  ("kV",(s,v)->v),("Ohm",(s,v)->v*v/s)]
            for (coefficient,s,v) in [(0.2,10.0,35.0),(-0.3,20.0,110.0),(1e-300,1e-100,1e100),
                                     (1e300,1e100,1e-100),(0.0,1e-300,1e300),(-0.0,1e300,1e-300)]
                expected = Float64(BigFloat(coefficient)*reference(BigFloat(s),BigFloat(v)))
                if !isfinite(expected) || coefficient!=0 && expected==0
                    @test_throws EnersyError EC.parameter_pu_to_physical(coefficient,unit,s,v,"fixture.p")
                else
                    actual = EC.parameter_pu_to_physical(coefficient,unit,s,v,"fixture.p")
                    @test actual ≈ expected rtol=5e-15 atol=0
                    @test signbit(actual) == signbit(expected)
                end
            end
        end
    end
    @test_throws EnersyError EC.parameter_pu_to_physical(1.0,"Ohm/km",10.0,10.0,"fixture")
    for raw in [nothing,Dict(),merge(source_base(),Dict("extra"=>1)),
                merge(source_base(),Dict("profile"=>"other")),
                [merge(source_base(),Dict(key=>number)) for key in ("s_base_mva","v_base_kv") for number in (0,-1,true,"10",Inf,NaN)]...]
        @test_throws EnersyError EC.parse_parameter_source_base(raw,"fixture")
    end
end

@testset "Based AC HTTP: independent quadratic, distinct source and Study bases" begin
    send(value) = handle_request(HTTP.Request("POST","/calculate",[],JSON.json(value)))
    # Independent constant-power two-bus quadratic, E_LL=10 kV,
    # Z_phase=.1+j.5 Ohm, S_3phase=10+j3 MVA, source angle=.1 rad.
    re, im = (1+sqrt(1-4*.025-4*.047^2))/2, -.047
    for (s,v) in [(50,20),(100,10),(5,35)]
        payload=based_ac_fixture(); payload["base"]=Dict("s_base_mva"=>s,"v_base_kv"=>v)
        original=deepcopy(payload)
        response=send(payload)
        @test response.status==200
        body=JSON.parse(response.body)
        @test body.success
        @test body.input_unit_contract.profile==EC.AC_BASED_INPUT_UNIT_PROFILE
        @test body.input_unit_contract.validation_scope=="request-declarations-with-parameter-bases"
        @test body.input_unit_contract.basis_count==8
        @test body.input_unit_contract.parameter_count==9
        node=only(filter(row->!row.is_internal_source_node,body.nodes))
        @test abs(node.voltage-10*hypot(re,im))<=1e-8
        @test abs(node.angle_rad-(.1+atan(im,re)))<=1e-9
        @test payload==original
        @test body.base.s_base_mva==s && body.base.v_base_kv==v
    end
    derived=based_ac_fixture(); delete!(derived,"base")
    response=send(derived)
    @test response.status==200
    @test JSON.parse(response.body).base.v_base_kv==10
    mutations = [
        p->delete!(p["components"][2],"parameterBases"),
        p->delete!(p["components"][2]["parameterBases"],"p"),
        p->(p["components"][2]["parameterBases"]["p"]=nothing),
        p->(p["components"][1]["parameterBases"]["angle"]=source_base()),
        p->(p["components"][2]["params"]["p"]="1e-400"),
        p->(p["components"][2]["params"]["p"]=""),
        p->(p["components"][2]["parameterBases"]["p"]["s_base_mva"]=0),
        p->(p["unitContract"]["profile"]=EC.AC_SCALED_INPUT_UNIT_PROFILE),
        p->(p["unitContract"]["profile"]=EC.AC_INPUT_UNIT_PROFILE),
        p->delete!(p,"unitContract"),
    ]
    for mutate in mutations
        payload=based_ac_fixture(); mutate(payload)
        response=send(payload)
        @test response.status==400
        @test !haskey(JSON.parse(response.body),:nodes)
    end
    # A base cannot turn a per-length quantity or angle into an absolute one.
    @test_throws EnersyError EC.normalize_based_parameter_units("transmission_line",Dict("x0"=>".1"),Dict("x0"=>"p.u."),Dict("x0"=>source_base()),"line#4")
    @test_throws EnersyError EC.normalize_based_parameter_units("generator",Dict("angle"=>".1"),Dict("angle"=>"p.u."),Dict("angle"=>source_base()),"generator#1")
end
