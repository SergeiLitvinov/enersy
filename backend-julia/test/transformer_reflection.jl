@testset "Transformer reflection matches an independent ideal-ratio circuit" begin
    base = BaseSystem(1, 1, "ideal-ratio-reference")
    setprecision(BigFloat, 256) do
        for ratio in (1e-200, 0.1, 1.0, 10.0, 1e200), angle in (-0.3, 0.0, 0.3)
            ys = complex(0.6ratio, -0.8ratio)
            m = EC.BranchModel(9,"transformer",1,2,ratio,ys,0im,0im,"transformer#9",angle)
            # Independent voltage/current identities for an ideal transformer
            # followed by impedance: If=Y*(Vi-Vj/t), It=-If/conj(t).
            y = Complex{BigFloat}(ys)
            tap = BigFloat(ratio) * cis(BigFloat(angle))
            expected = [y -y/tap; -y/conj(tap) y/abs2(tap)]
            dense = zeros(ComplexF64,2,2)
            EC.stamp!(dense,m)
            buses = [EC.Bus(i,[i],["busbar"],1.0,true,false,1) for i in 1:2]
            system = EC.AcSystem(buses,[m],EC.ShuntModel[],EC.Injection[],EC.Injection[],String[],String[])
            sparse = EC.build_admittance(system)
            for actual in (dense,sparse), index in eachindex(expected)
                reference = ComplexF64(expected[index])
                @test isfinite(actual[index])
                @test isapprox(real(actual[index]), real(reference); rtol=32eps(Float64),atol=nextfloat(0.0))
                @test isapprox(imag(actual[index]), imag(reference); rtol=32eps(Float64),atol=nextfloat(0.0))
            end
            vi, vj = BigFloat(1), BigFloat(0.5ratio)
            current_from = y*(vi-vj/tap)
            current_to = -current_from/conj(tap)
            sf, st = vi*conj(current_from), vj*conj(current_to)
            flow = EC.branch_flow(m,[1.0,0.5ratio],[0.0,0.0],base)
            for (actual,reference) in ((flow.p_from_mw,real(sf)),(flow.q_from_mvar,imag(sf)),
                    (flow.p_to_mw,real(st)),(flow.q_to_mvar,imag(st)),
                    (flow.losses_p_mw,real(sf+st)),(flow.losses_q_mvar,imag(sf+st)))
                @test isfinite(actual)
                @test isapprox(actual,Float64(reference);rtol=64eps(Float64),atol=nextfloat(0.0))
            end
        end
    end
end
