using SparseArrays
include(joinpath(@__DIR__, "fixtures", "network_families.jl"))

@testset "Manufactured network families preserve circuit laws and reproducibility" begin
    for family in ("radial", "ring", "mesh"), n in (9, 33)
        network = manufactured_network(family, n)
        repeated = manufactured_network(family, n)
        @test network.edges == repeated.edges
        @test network.Y == repeated.Y
        @test manufactured_network(family, n; seed=UInt64(7)).edges != network.edges
        @test length(unique((i, j) for (i, j, _) in network.edges)) == length(network.edges)
        @test length(network.edges) >= n - 1
        @test sum(network.injection) ≈ sum(z * abs2((network.voltage[i] - network.voltage[j]) / z)
            for (i, j, z) in network.edges) atol=1e-12
        powers = EC.bus_powers(network.Y, abs.(network.voltage), angle.(network.voltage))
        @test powers.S ≈ network.injection atol=1e-12
        result = EC.newton_raphson(network.Y, network.setup, SolverOptions(tolerance=1e-10, max_iterations=20))
        @test maximum(abs, result.voltages - network.voltage) < 1e-8
        @test result.max_mismatch < 1e-10
        @test nnz(network.Y) <= n + 2length(network.edges)
    end
    @test_throws ArgumentError manufactured_network("other", 9)
    @test_throws ArgumentError manufactured_network("ring", 3)
end
