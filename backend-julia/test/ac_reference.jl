# This adapter belongs to the test harness, not the editor's network compiler.
# MATPOWER/PYPOWER column conventions: GS/BS in MW/Mvar at nominal voltage,
# branch r/x/b in p.u., tap and phase shift on the from side.
function reference_network(case; order=collect(eachindex(case.bus)), reverse_branches=false,
                           angle_offset=0.0)
    buses = case.bus[order]
    n = length(buses)
    index = Dict(Int(row[1]) => i for (i, row) in enumerate(buses))
    base = Float64(case.base_mva)
    Y = zeros(ComplexF64, n, n)
    p = Float64[-row[3] / base for row in buses]
    q = Float64[-row[4] / base for row in buses]
    vg = ones(n)
    for (i, row) in enumerate(buses)
        Y[i, i] += complex(row[5], row[6]) / base
    end
    branches = reverse_branches ? reverse(case.branch) : case.branch
    stamps = []
    for row in branches
        row[11] == 0 && continue
        f, t = index[Int(row[1])], index[Int(row[2])]
        y = inv(complex(row[3], row[4]))
        tap = (row[9] == 0 ? 1.0 : row[9]) * cis(deg2rad(row[10]))
        ytt = y + im * row[5] / 2
        yff, yft, ytf = ytt / abs2(tap), -y / conj(tap), -y / tap
        Y[f, f] += yff
        Y[f, t] += yft
        Y[t, f] += ytf
        Y[t, t] += ytt
        push!(stamps, (f, t, yff, yft, ytf, ytt))
    end
    for row in case.gen
        row[8] == 0 && continue
        i = index[Int(row[1])]
        p[i] += row[2] / base
        q[i] += row[3] / base
        vg[i] = row[6]
    end
    slack = only(findall(row -> row[2] == 3, buses))
    pv = findall(row -> row[2] == 2, buses)
    pq = findall(row -> row[2] == 1, buses)
    setup = EC.PowerFlowSetup(n, slack, vg[slack], angle_offset,
                             pv, pq, vg[pv], p[pv], p[pq], q[pq])
    return Y, setup, stamps
end

@testset "Independent synthetic AC references (PYPOWER 5.1.19)" begin
    fixtures = JSON3.read(read(joinpath(@__DIR__, "reference", "ac-networks-v1.json"), String))
    @test fixtures.schema_version == 1
    @test fixtures.provenance.tolerance_pu == 1e-10
    for case in fixtures.cases
        @testset "$(case.name)" begin
            Y, setup, stamps = reference_network(case)
            expected_Y = complex.(reduce(hcat, case.y_real)', reduce(hcat, case.y_imag)')
            @test maximum(abs, Y - expected_Y) < 1e-12
            result = EC.newton_raphson(Y, setup, SolverOptions(tolerance=1e-10))
            e = case.expected
            errors = (voltage=maximum(abs, result.v - e.v_pu),
                      angle=maximum(abs, result.theta - e.theta_rad),
                      active=maximum(abs, result.p - e.p_pu),
                      reactive=maximum(abs, result.q - e.q_pu))
            @info "Independent AC comparison" case=case.name errors iterations=result.iterations
            @test errors.voltage < 1e-8
            @test errors.angle < 1e-8
            @test errors.active < 1e-8
            @test errors.reactive < 1e-8
            @test result.max_mismatch < 1e-10
            powers = Vector{Float64}[]
            loss = 0.0im
            for (f, t, yff, yft, ytf, ytt) in stamps
                V = result.voltages
                sf = V[f] * conj(yff * V[f] + yft * V[t])
                st = V[t] * conj(ytf * V[f] + ytt * V[t])
                push!(powers, [real(sf), imag(sf), real(st), imag(st)] * case.base_mva)
                loss += sf + st
            end
            @test maximum(abs, reduce(hcat, powers) - reduce(hcat, e.branch_mw_mvar)) < 1e-6
            shunt = sum(abs2(result.voltages[i]) * conj(complex(row[5], row[6])) /
                        case.base_mva for (i, row) in enumerate(case.bus))
            @test abs(sum(complex.(result.p, result.q)) - loss - shunt) < 1e-10
            # External IDs are mapped independently of array order; slack moves too.
            order = reverse(collect(eachindex(case.bus)))
            yp, sp, _ = reference_network(case; order, reverse_branches=true, angle_offset=0.37)
            permuted = EC.newton_raphson(yp, sp, SolverOptions(tolerance=1e-10))
            @test maximum(abs, permuted.v - result.v[order]) < 1e-10
            @test maximum(abs, permuted.theta .- 0.37 - result.theta[order]) < 1e-10
            @test maximum(abs, permuted.p - result.p[order]) < 1e-10
            @test maximum(abs, permuted.q - result.q[order]) < 1e-10
        end
    end
end
