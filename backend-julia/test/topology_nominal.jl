@testset "Voltage-level validation is independent of member order and equipment IDs" begin
    # Equipment IDs and iteration order cannot change physical compatibility.
    # 9/10/11 kV has a pair outside the existing 10% relative tolerance,
    # although each consecutive pair in ascending order passes it.
    permutations = ((1, 2, 3), (1, 3, 2), (2, 1, 3),
                    (2, 3, 1), (3, 1, 2), (3, 2, 1))
    for (ratings, accepted) in (((9.0, 10.0, 11.0), false),
                              ((9.5, 10.0, 10.5), true),
                              ((9.0, 9.5, 10.0), true))
        for order in permutations
            cs = [component(id, "busbar"; voltage_nom=ratings[order[id]]) for id in 1:3]
            by_id = Dict(c.id => c for c in cs)
            edges = [connection(1, 2, "left", "right"), connection(2, 3, "left", "right")]
            # Check both the helper and the public topology compilation path.
            for run in (() -> EC.bus_nominal(by_id, [3, 1, 2]),
                        () -> EC.compile_network(reverse(cs), reverse(edges)))
                if accepted
                    result = run()
                    if result isa Tuple
                        @test result == (maximum(ratings), true)
                    else
                        @test length(result.buses) == 1
                        @test only(result.buses).v_nom_kv == maximum(ratings)
                        @test only(result.buses).v_nom_complete
                    end
                else
                    err = try
                        run()
                        nothing
                    catch caught
                        caught
                    end
                    @test err isa EnersyError
                    @test err isa EnersyError && err.code == "voltage_level_mismatch"
                end
            end
        end
    end
end
