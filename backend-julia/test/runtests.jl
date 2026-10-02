using Test, LinearAlgebra, JSON3, HTTP, EnersyCompute
# Import the executable entrypoint too; it must parse without starting a listener.
include(joinpath(@__DIR__, "..", "server", "main.jl"))
const EC = EnersyCompute
include("ac_reference.jl")
withenv("S_BASE_MVA" => "50") do
    @test EC.default_s_base_mva() == 50.0
end

component(id, code; params...) = RawComponent(id, code,
    Dict(string(k) => string(v) for (k, v) in params), 0.0, 0.0, 0)
connection(a, b, ap, bp) = RawConnection(a, b, ap, bp)
include("compiled_reference.jl")
include("compiled_network_reference.jl")
include("q_limits.jl")
include("q_release.jl")
include("sparse_solver.jl")
include("islands.jl")

function fixture(; switch_status=true, emf=true, shunt=nothing)
    gp = Dict("voltage_nom" => "10", "p" => "10", "r" => "0.1", "x" => "0.5")
    emf && (gp["e"] = "10")
    cs = [RawComponent(1, "generator", gp, 0.0, 0.0, 0),
          component(2, "breaker"; status=switch_status, voltage_nom=10),
          component(3, "busbar"; voltage_nom=10),
          component(4, "transmission_line"; length=1, r0=0.1, x0=0.5, voltage_nom=10),
          component(5, "load"; p=10, q=3, voltage_nom=10)]
    es = [connection(1, 2, "bottom", "top"), connection(2, 3, "bottom", "left"),
          connection(3, 4, "right", "left"), connection(4, 5, "right", "top")]
    if shunt !== nothing
        push!(cs, component(6, shunt; q_nom=2, voltage_nom=10))
        push!(es, connection(3, 6, "left", "top"))
    end
    return cs, es
end

@testset "Passive equipment rejects artificial energy generation" begin
    for (id, key, value) in [(1,"r","-0.1"), (4,"r0","-0.1"),
                             (4,"g0","-0.001"), (4,"circuits","1e100")]
        cs, es = fixture()
        component = only(filter(c -> c.id == id, cs))
        component.params[key] = value
        error = try
            calculate(cs, es)
            nothing
        catch caught
            caught
        end
        @test error isa EnersyError
        @test error isa EnersyError && error.kind == EC.CONTRACT &&
              error.code == (key == "circuits" ? "out_of_range" : "invalid_parameter")
    end
end

@testset "Units and input contract" begin
    base = BaseSystem(100, 10, "test")
    @test EC.z_base_ohm(base) == 1
    @test EC.pu_to_kv(EC.kv_to_pu(7.3, base), base) ≈ 7.3
    @test EC.impedance_from_own_base(0.01 + 0.1im, 50, 10, base) ≈ 0.02 + 0.2im
    @test_throws EnersyError BaseSystem(-1.0, 10.0, "test")
    @test_throws EnersyError EC.as_int(1e100, "id")
    @test EC.param_number(Dict{String,String}(), "e"; required=false) === nothing
    @test_throws EnersyError EC.param_number(Dict{String,String}(), "p")
    @test_throws EnersyError EC.as_string_map(Dict("p" => nothing), "params")
    @test_throws EnersyError EC.parse_linear_request(JSON3.read("{\"A\":[[1,2],[3]],\"b\":[1,2]}"))
    @test_throws EnersyError EC.solve_linear([1.0 2; 2 4], [1.0, 2])
    @test_throws EnersyError EC.solve_linear([NaN 0; 0 1], [1.0, 2])
end

@testset "Analytical two-bus load flow" begin
    # E=1, z=jX, P=0: Q = V*(E-V)/X, high-voltage root.
    X, Q = 0.2, 0.2
    y = inv(im * X)
    Y = ComplexF64[y -y; -y y]
    setup = EC.PowerFlowSetup(2, 1, 1.0, 0.0, Int[], [2], Float64[], Float64[], [0.0], [-Q])
    result = EC.newton_raphson(Y, setup, SolverOptions())
    expected = (1 + sqrt(1 - 4X * Q)) / 2
    @test result.v[2] ≈ expected atol=1e-9
    @test result.theta[2] ≈ 0 atol=1e-10
    @test result.p[2] ≈ 0 atol=1e-9
    @test result.q[2] ≈ -Q atol=1e-9
    @test EC.newton_raphson(Y, setup, SolverOptions(max_iterations=result.iterations)).v ≈ result.v
    @test_throws EnersyError EC.newton_raphson(Y, setup, SolverOptions(max_iterations=1))
    @test_throws EnersyError EC.check_state([1.0, NaN], [0.0, 0.0], 1)
end

@testset "Power flow setup cannot bypass validation" begin
    for tolerance in [0.0, -1.0, NaN, Inf]
        @test_throws EnersyError SolverOptions(tolerance, 10)
        @test_throws EnersyError SolverOptions(tolerance=tolerance)
    end
    for iterations in [0, -1, big(typemax(Int))+1]
        @test_throws EnersyError SolverOptions(1e-8, iterations)
        @test_throws EnersyError SolverOptions(max_iterations=iterations)
    end
    setup(; n=3, slack=1, sv=1.0, angle=0.0, pv=[2], pq=[3], vv=[1.02], pp=[0.3], pl=[-0.5], ql=[-0.2]) =
        EC.PowerFlowSetup(n, slack, sv, angle, pv, pq, vv, pp, pl, ql)
    for make in [() -> setup(n=0), () -> setup(slack=0), () -> setup(slack=4),
                 () -> setup(pv=[1]), () -> setup(pq=[2]), () -> setup(pq=[4]),
                 () -> setup(pv=Int[], vv=Float64[], pp=Float64[]),
                 () -> setup(pv=[2,2], vv=[1.0,1.0], pp=[0.0,0.0]),
                 () -> setup(vv=Float64[]), () -> setup(pl=Float64[]),
                 () -> setup(sv=NaN), () -> setup(sv=0.0), () -> setup(angle=Inf),
                 () -> setup(vv=[Inf]), () -> setup(vv=[-1.0]),
                 () -> setup(pp=[NaN]), () -> setup(pl=[Inf]), () -> setup(ql=[NaN])]
        @test_throws EnersyError make()
    end
    # Typed Float64 inputs used to dispatch to the unchecked default constructor.
    pv = [2]; pp = [0.3]
    valid = setup(pv=pv, pp=pp)
    pv[1] = 99; pp[1] = NaN
    @test valid.pv == [2] && valid.p_pv == [0.3]
    valid.pv[1] = 99
    @test_throws EnersyError EC.newton_raphson(zeros(ComplexF64,3,3),valid,SolverOptions())

    # A one-bus shunt is analytic: S=|V|² conj(Y), injection in p.u.
    one = EC.PowerFlowSetup(1,1,1.2,0.2,Int[],Int[],Float64[],Float64[],Float64[],Float64[])
    result = EC.newton_raphson(reshape(ComplexF64[0.5-0.25im],1,1),one,SolverOptions())
    @test result.p[1] ≈ 0.72 atol=1e-12
    @test result.q[1] ≈ 0.36 atol=1e-12
    for y in [ComplexF64(NaN),ComplexF64(Inf)]
        @test_throws EnersyError EC.newton_raphson(reshape([y],1,1),one,SolverOptions())
    end
    huge = EC.PowerFlowSetup(1,1,2.0,0.0,Int[],Int[],Float64[],Float64[],Float64[],Float64[])
    @test_throws EnersyError EC.newton_raphson(reshape(ComplexF64[floatmax(Float64)],1,1),huge,SolverOptions())
    @test_throws EnersyError EC.newton_raphson(zeros(ComplexF64,1,1),one,SolverOptions();initial_v=[NaN])
end

@testset "Jacobian agrees with finite differences at nonzero angles" begin
    Y = ComplexF64[0 0 0; 0 0 0; 0 0 0]
    for (i,j,z) in [(1,2,0.02+0.15im), (2,3,0.01+0.1im), (1,3,0.04+0.2im)]
        y = inv(z)
        Y[i,i] += y; Y[j,j] += y; Y[i,j] -= y; Y[j,i] -= y
    end
    s = EC.PowerFlowSetup(3,1,1.0,0.0,[2],[3],[1.02],[0.3],[-0.5],[-0.2])
    v, theta = [1.0,1.02,0.97], [0.0,0.04,-0.08]
    powers = EC.bus_powers(Y,v,theta)
    F = EC.mismatch_vector(powers,s)
    @test eltype(F) <: Real
    J, ct, cv = EC.jacobian(Y,v,theta,powers.P,powers.Q,s)
    numeric = zeros(size(J)); h = 1e-6
    for (columns, values, is_angle) in [(ct,theta,true),(cv,v,false)]
        for (i,c) in columns
            plus, minus = copy(values), copy(values)
            plus[i] += h; minus[i] -= h
            pp = EC.bus_powers(Y,is_angle ? v : plus,is_angle ? plus : theta)
            pm = EC.bus_powers(Y,is_angle ? v : minus,is_angle ? minus : theta)
            numeric[:,c] = -(EC.mismatch_vector(pp,s)-EC.mismatch_vector(pm,s))/(2h)
        end
    end
    @test J ≈ numeric atol=1e-7 rtol=1e-7
end

@testset "Compiled terminals and full result" begin
    cs, es = fixture()
    n = EC.compile_network(cs,es)
    @test length(n.buses) == 2
    @test length(n.branches) == 1
    @test n.branches[1].from_bus != n.branches[1].to_bus
    result = calculate(cs,es)
    @test result["success"]
    @test result["capability"]["status"] == "experimental"
    @test result["sources"][1]["terminal_bus"] != result["sources"][1]["internal_bus"]
    @test abs(result["balance"]["residual_p_mw"]) < 1e-6
    @test abs(result["balance"]["residual_q_mvar"]) < 1e-6
    @test result["balance"]["branch_losses_p_mw"] > 0
    reordered = calculate(reverse(cs),reverse(es))
    @test [n["voltage"] for n in reordered["nodes"]] ≈ [n["voltage"] for n in result["nodes"]]
    @test calculate(fixture(emf=false)...)["success"]
    @test_throws EnersyError calculate(fixture(switch_status=false)...)
    @test_throws EnersyError EC.compile_network(cs,[connection(3,4,"made-up","left")])
    @test_throws EnersyError EC.compile_network(cs,[connection(3,4,"right","")])
    bad = copy(cs)
    bad[5] = component(5,"load"; p=10,q=3,voltage_nom=20)
    @test_throws EnersyError calculate(bad,es)
    @test_throws EnersyError calculate(cs,es;method="direct")
    for code in ["capacitor","reactor"]
        r = calculate(fixture(shunt=code)...)
        @test abs(r["balance"]["residual_q_mvar"]) < 1e-6
        @test code == "capacitor" ? r["shunts"][1]["q_mvar"] < 0 : r["shunts"][1]["q_mvar"] > 0
    end
end

@testset "Transformer and branch energy" begin
    base = BaseSystem(100,110,"test")
    p = Dict("power_nom"=>"100", "voltage_hv"=>"110", "voltage_lv"=>"10",
             "p_kz"=>"1", "u_kz"=>"10", "p_xx"=>"0.1", "i_xx"=>"1")
    buses = Dict(i => EC.Bus(i,[i],["busbar"],v,true,false,1) for (i,v) in [(1,110.0),(2,10.0)])
    m = EC.transformer_model(EC.Branch(9,"transformer",1,2,1,2,p),buses,base,String[],String[])
    # Single global voltage base: the physical ratio must multiply the LV voltage.
    @test m.ratio ≈ 1/11
    @test inv(m.y_series) ≈ 0.01 + sqrt(0.1^2-0.01^2)*im
    Y = zeros(ComplexF64,2,2); EC.stamp!(Y,m)
    powers = EC.bus_powers(Y,[1.0,1/11],[0.0,0.0])
    @test powers.S[2] ≈ 0 atol=1e-10
    @test real(powers.S[1]) ≈ 0.001
    @test imag(powers.S[1]) ≈ sqrt(0.01^2-0.001^2)
    f = EC.branch_flow(m,[1.0,0.089],[0.0,-0.03],base)
    @test f.losses_p_mw ≈ f.p_from_mw + f.p_to_mw
    @test f.losses_q_mvar ≈ f.q_from_mvar + f.q_to_mvar
end

@testset "HTTP contract and real socket" begin
    response(method,path,body="") = handle_request(HTTP.Request(method,path,[],body))
    @test response("GET","/health?check=1").status == 200
    @test response("GET","/solve").status == 405
    @test response("PUT","/health").status == 405
    @test response("GET","/unknown").status == 404
    @test response("POST","/solve", "{").status == 400
    @test response("POST","/solve", "{}").status == 400
    @test handle_request(HTTP.Request("POST","/solve",[],"xxxx");max_body_bytes=3).status == 413
    @test response("HEAD","/health").body == UInt8[]
    @test JSON3.read(response("GET","/capabilities").body).capabilities[1].status == "experimental"
    for entry in EC.CAPABILITY_REGISTRY
        entry.status == EC.STATUS_UNSUPPORTED || continue
        rejected = response("POST", "/calculate", JSON3.write(Dict(
            "components" => [], "connections" => [], "modelGroup" => entry.model_group, "method" => entry.method)))
        @test rejected.status == 422
        @test JSON3.read(rejected.body).error_detail.code == "unsupported_method"
    end
    server = start_server(;host="127.0.0.1",port=0)
    try
        url = "http://127.0.0.1:$(HTTP.port(server))"
        r = HTTP.post(url*"/solve",["Content-Type"=>"application/json"],
                      JSON3.write(Dict("A"=>[[2,3],[1,4]],"b"=>[5,7]));proxy=HTTP.ProxyConfig())
        @test r.status == 200
        @test JSON3.read(r.body).solution ≈ [-0.2,1.8]
        cs, es = fixture()
        payload = Dict("components"=>[Dict("id"=>c.id,"type"=>c.code,"params"=>c.params) for c in cs],
                       "connections"=>[Dict("from"=>e.from,"to"=>e.to,"fromPort"=>e.from_port,"toPort"=>e.to_port) for e in es])
        r = HTTP.post(url*"/calculate",[],JSON3.write(payload);proxy=HTTP.ProxyConfig())
        @test JSON3.read(r.body).success
    finally
        HTTP.forceclose(server)
    end
end
