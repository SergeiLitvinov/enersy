using SparseArrays
if !isdefined(@__MODULE__, :manufactured_network)
    include(joinpath(@__DIR__, "fixtures", "network_families.jl"))
end

@testset "Bounded Newton step against two analytic roots" begin
    # Unit conductance, slack V=1; PQ P=-0.2, Q=0.
    # V(V-1)=-0.2 has roots (1±sqrt(0.2))/2. Choice depends on start.
    Y = ComplexF64[1 -1; -1 1]
    setup = EC.PowerFlowSetup(2, 1, 1.0, 0.0, Int[], [2], Float64[], Float64[], [-0.2], [0.0])
    for matrix in (Y, sparse(Y)), initial in (0.49, 0.51)
        v, theta = [1.0, initial], zeros(2)
        original_v, original_theta = copy(v), copy(theta)
        powers = EC.bus_powers(matrix, v, theta)
        F = EC.mismatch_vector(powers, setup)
        J, ct, cv = EC.jacobian(matrix, v, theta, powers.P, powers.Q, setup)
        dx = EC.solve_jacobian(J, F, 1)
        tv, tt, alpha, attempts = EC.backtracked_step(matrix, setup, v, theta, dx, ct, cv, maximum(abs, F), 1)
        @test 0 < alpha < 1
        @test 1 < attempts <= EC.NEWTON_MAX_BACKTRACKS + 1
        @test minimum(tv) > 0
        @test tv[1] == 1 && tt[1] == 0
        @test v == original_v && theta == original_theta
        actual = maximum(abs, EC.mismatch_vector(EC.bus_powers(matrix, tv, tt), setup))
        @test actual <= (1 - EC.NEWTON_ARMIJO * alpha) * maximum(abs, F)
        result = EC.newton_raphson(matrix, setup, SolverOptions(tolerance=1e-11, max_iterations=20); initial_v=v)
        expected = (1 + (initial > 0.5 ? 1 : -1) * sqrt(0.2)) / 2
        @test result.v[2] ≈ expected atol=1e-9
        @test result.damped_steps >= 1 && result.min_step_length < 1
        @test result.line_search_trials >= result.iterations
    end
    powers = EC.bus_powers(Y, [1.0, 0.49], zeros(2))
    F = EC.mismatch_vector(powers, setup)
    _, ct, cv = EC.jacobian(Y, [1.0, 0.49], zeros(2), powers.P, powers.Q, setup)
    err = try EC.backtracked_step(Y, setup, [1.0, 0.49], zeros(2), zeros(2), ct, cv, maximum(abs, F), 1) catch e; e end
    @test err isa EnersyError && err.code == "line_search_failed"
    @test occursin("trials=25", err.detail)
    overflow = try EC.backtracked_step(Y, setup, [1.0, 0.49], zeros(2), [0.0, 1e200], ct, cv, maximum(abs, F), 1) catch e; e end
    @test overflow isa EnersyError && overflow.code == "line_search_failed"
    impossible = EC.PowerFlowSetup(2, 1, 1.0, 0.0, Int[], [2], Float64[], Float64[], [-0.3], [0.0])
    err = try EC.newton_raphson(Y, impossible, SolverOptions(tolerance=1e-11, max_iterations=20)) catch e; e end
    @test err isa EnersyError && err.code in ("line_search_failed", "no_convergence", "singular_jacobian")
end

@testset "Radial 100k: feasible root is not a reference-root guarantee" begin
    network = manufactured_network("radial", 100_000)
    result = EC.newton_raphson(network.Y, network.setup,
        SolverOptions(tolerance=1e-10, max_iterations=20))
    @test minimum(result.v) > 0
    @test result.max_mismatch < 1e-10
    currents = zeros(ComplexF64, 100_000)
    losses = 0.0im
    for (i, j, z) in network.edges
        current = (result.voltages[i] - result.voltages[j]) / z
        currents[i] += current; currents[j] -= current
        losses += z * abs2(current)
    end
    injections = result.voltages .* conj.(currents)
    @test maximum(abs, injections[2:end] - network.injection[2:end]) < 1e-10
    @test abs(sum(injections) - losses) < 1e-7
    @test result.damped_steps > 0
    reference = EC.newton_raphson(network.Y, network.setup,
        SolverOptions(tolerance=1e-10, max_iterations=20);
        initial_v=abs.(network.voltage), initial_theta=angle.(network.voltage))
    @test maximum(abs, reference.voltages - network.voltage) < 1e-8
    @test reference.iterations == 0
    @info "Radial root comparison; not a passing strict manufactured benchmark" error=maximum(abs, result.voltages-network.voltage) mismatch=result.max_mismatch min_voltage=minimum(result.v) max_voltage=maximum(result.v) damped_steps=result.damped_steps min_step=result.min_step_length
end
