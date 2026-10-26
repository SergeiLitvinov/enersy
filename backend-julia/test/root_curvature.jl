using LinearAlgebra, SparseArrays
include(joinpath(@__DIR__,"..","benchmark","diagnostics","root_curvature.jl"))
const RC=RootCurvatureDiagnostics

@testset "Two analytic roots: algebraic curvature is not a stability certificate" begin
    setup=EC.PowerFlowSetup(2,1,1.0,0.0,Int[],[2],Float64[],Float64[],[-0.2],[0.0])
    edges=[(1,2,1.0+0im)]
    for upper in (false,true)
        v=(1+(upper ? 1 : -1)*sqrt(0.2))/2
        V=ComplexF64[1,v]
        H=RC.edge_hessian(setup,edges,V;common_impedance=1.0+0im)
        @test Matrix(H) ≈ [v 0;0 v*(2v-1)] atol=1e-14
        result=RC.classify(H)
        @test result.status == (upper ? "positive_ldlt" : "negative_direction")
        if !upper
            @test norm(result.witness) ≈ 1.0 atol=1e-14
            @test result.rayleigh < 0
            @test Float64(RC.edge_quadratic(setup,edges,V,result.witness;common_impedance=1.0+0im)) ≈ result.rayleigh atol=1e-14
        end
    end
    @test_throws ArgumentError RC.edge_hessian(setup,edges,ComplexF64[1,0];common_impedance=1.0+0im)
    @test_throws ArgumentError RC.edge_hessian(setup,[(1,2,1.0+1im)],ComplexF64[1,.9];common_impedance=1.0+0im)
    @test_throws ArgumentError RC.edge_hessian(setup,[(0,2,1.0+0im)],ComplexF64[1,.9];common_impedance=1.0+0im)
    @test_throws ArgumentError RC.edge_hessian(setup,[(1,2,1.0+0im,1.1)],ComplexF64[1,.9];common_impedance=1.0+0im)
    @test_throws ArgumentError RC.edge_quadratic(setup,[(1,2,1.0+0im,1.1)],ComplexF64[1,.9],[1.0,0.0];common_impedance=1.0+0im)
    @test_throws ArgumentError RC.classify(spzeros(2,2))
    @test_throws ArgumentError RC.classify(sparse([1.0 1;0 1]))
    pv=EC.PowerFlowSetup(2,1,1.0,0.0,[2],Int[],[1.0],[0.0],Float64[],Float64[])
    @test_throws ArgumentError RC.edge_hessian(pv,edges,ComplexF64[1,1];common_impedance=1.0+0im)
end

@testset "Edge Hessian matches independent finite differences and the rotated AC Jacobian" begin
    network=manufactured_network("radial",9)
    s=network.setup;m=length(s.pq)
    point=vcat(angle.(network.voltage[s.pq]),log.(abs.(network.voltage[s.pq])))
    function gradient(x)
        V=copy(network.voltage)
        V[s.pq]=exp.(x[m+1:end]).*cis.(x[1:m])
        current=zeros(ComplexF64,s.nbus)
        for (i,j,z) in network.edges
            w=real((0.01+0.1im)/z)
            branch=-im*w*(V[i]-V[j])
            current[i]+=branch;current[j]-=branch
        end
        injection=V.*conj.(current)
        vcat(real.(injection[s.pq]),imag.(injection[s.pq]))
    end
    H=RC.edge_hessian(s,network.edges,network.voltage;common_impedance=0.01+0.1im)
    for k in eachindex(point)
        plus,minus=copy(point),copy(point)
        plus[k]+=1e-6;minus[k]-=1e-6
        @test H[:,k] ≈ (gradient(plus)-gradient(minus))/(2e-6) atol=2e-8 rtol=1e-8
    end
    @test RC.classify(H).status=="positive_ldlt"
end

@testset "100k manufactured reference has a verified negative algebraic direction" begin
    network=manufactured_network("radial",100_000)
    s=network.setup;V=network.voltage;v=abs.(V);theta=angle.(V);m=length(s.pq)
    H=RC.edge_hessian(s,network.edges,V;common_impedance=0.01+0.1im)
    powers=EC.bus_powers(network.Y,v,theta)
    J,ct,cv=EC.jacobian(network.Y,v,theta,powers.P,powers.Q,s)
    # Independent edge formula versus the production power derivatives after
    # the explicit common-admittance rotation and rho=log|V| coordinate change.
    admittance=inv(0.01+0.1im);g=real(admittance);b=-imag(admittance)
    I0=spdiagm(0=>ones(m))
    rotation=[b*I0 -g*I0;g*I0 b*I0]/abs2(admittance)
    columns=vcat([ct[i] for i in s.pq],[cv[i] for i in s.pq])
    from_ac=rotation*J[:,columns]*spdiagm(0=>vcat(ones(m),v[s.pq]))
    @test maximum(abs,nonzeros(H-from_ac);init=0.0)<1e-11
    classified=RC.classify(H)
    @test classified.status=="negative_direction"
    @test classified.negative_pivots>0
    @test classified.rayleigh < -1e-10
    independent=RC.edge_quadratic(s,network.edges,V,classified.witness;common_impedance=0.01+0.1im)
    @test independent<0
    @test Float64(independent) ≈ classified.rayleigh atol=1e-12
    # A nearby known state tests local convergence, not deployable initialisation.
    warm=EC.newton_raphson(network.Y,s,SolverOptions(tolerance=1e-10,max_iterations=20);
        initial_v=v.+[i==s.slack ? 0.0 : 1e-4*sin(i) for i in 1:s.nbus],
        initial_theta=theta.+[i==s.slack ? 0.0 : 1e-4*cos(i) for i in 1:s.nbus])
    @test 0<warm.iterations<=20
    @test maximum(abs,warm.voltages-V)<1e-8
    @test warm.max_mismatch<1e-10
end
