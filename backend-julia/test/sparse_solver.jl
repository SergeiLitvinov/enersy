using SparseArrays
include("fixtures/sparse_star.jl")

@testset "Sparse AC equations preserve independent references" begin
    cases = JSON3.read(read(joinpath(@__DIR__, "reference", "ac-networks-v1.json"), String)).cases
    for case in cases
        Y, setup, _ = reference_network(case)
        Ys = sparse(Y)
        # Nonzero angles, nonuniform voltages, transformer phase shift and PV
        # voltage equations exercise terms that vanish at a flat start.
        v = collect(range(0.97, 1.04; length=setup.nbus))
        theta = collect(range(-0.03, 0.05; length=setup.nbus))
        powers = EC.bus_powers(Y, v, theta)
        dense, ct, cv = EC.jacobian(Y, v, theta, powers.P, powers.Q, setup)
        sparse_J, sct, scv = EC.jacobian(Ys, v, theta, powers.P, powers.Q, setup)
        @test sparse_J isa SparseMatrixCSC
        @test ct == sct && cv == scv
        @test maximum(abs, Matrix(sparse_J) - dense) < 1e-12
        result = EC.newton_raphson(Ys, setup, SolverOptions(tolerance=1e-10))
        e = case.expected
        @test maximum(abs, result.v - e.v_pu) < 1e-8
        @test maximum(abs, result.theta - e.theta_rad) < 1e-8
        @test maximum(abs, result.p - e.p_pu) < 1e-8
        @test maximum(abs, result.q - e.q_pu) < 1e-8
    end
    # An absent diagonal still has P/Q contributions to the derivatives.
    Y = ComplexF64[0 1+im; 1+im 0]
    setup = EC.PowerFlowSetup(2, 1, 1.0, 0.0, Int[], [2], Float64[], Float64[], [0.0], [0.0])
    v, theta = [1.0, 1.1], [0.0, 0.05]
    p = EC.bus_powers(Y, v, theta)
    @test Matrix(first(EC.jacobian(sparse(Y), v, theta, p.P, p.Q, setup))) ≈
                 first(EC.jacobian(Y, v, theta, p.P, p.Q, setup)) atol=1e-12
    err = try EC.solve_jacobian(spzeros(2, 2), ones(2), 1) catch e; e end
    @test err isa EnersyError && err.code == "singular_jacobian"
end

@testset "1000-bus radial AC analytical reference" begin
    Y, setup, expected, injection = analytical_star(1000)
    result = EC.newton_raphson(Y, setup, SolverOptions(tolerance=1e-10))
    @test maximum(abs, result.voltages[2:end] .- expected) < 1e-8
    @test maximum(abs, result.p[2:end] .- real(injection)) < 1e-8
    @test maximum(abs, result.q[2:end] .- imag(injection)) < 1e-8
    @test result.max_mismatch < 1e-10
    loss = 999 * abs2((expected - 1) / (0.01 + 0.1im)) * (0.01 + 0.1im)
    @test sum(result.p) ≈ real(loss) atol=1e-7
    @test sum(result.q) ≈ imag(loss) atol=1e-7
    powers = EC.bus_powers(Y, result.v, result.theta)
    J, _, _ = EC.jacobian(Y, result.v, result.theta, powers.P, powers.Q, setup)
    @test nnz(Y) == 2998
    @test nnz(J) <= 4 * 999
    @test Base.summarysize(Y) + Base.summarysize(J) < 300_000
end

@testset "Compiled Y sums parallel branches without dense storage" begin
    case = JSON3.read(read(joinpath(@__DIR__, "reference", "ac-networks-v1.json"), String)).compiled_networks[1]
    cs, es, _, _, base, _, _ = EC.parse_calculate_request(case.scheme)
    sys = EC.assemble_system(EC.compile_network(cs, es), base)
    # Two stamps for exactly the same endpoints exercise parallel summation.
    push!(sys.branch_models, first(sys.branch_models))
    Ys = EC.build_admittance(sys)
    dense = zeros(ComplexF64, length(sys.buses), length(sys.buses))
    for m in sys.branch_models; EC.stamp!(dense, m); end
    for m in sys.shunts; EC.stamp!(dense, m); end
    @test Ys isa SparseMatrixCSC
    @test Matrix(Ys) ≈ dense atol=1e-12
    @test nnz(Ys) <= 4 * length(sys.branch_models) + length(sys.shunts)
end
