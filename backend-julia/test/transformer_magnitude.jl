@testset "Transformer passport magnitudes against independent 256-bit identities" begin
    buses = Dict(1 => EC.Bus(1, [1], ["busbar"], 1.0, true, false, 1),
                 2 => EC.Bus(2, [2], ["busbar"], 1.0, true, false, 1))
    base = BaseSystem(1, 1, "passport-magnitude-reference")
    setprecision(BigFloat, 256) do
        for exponent in (-700, 0, 700), fraction in (0.0, 0.6, prevfloat(1.0), 1.0)
            magnitude = ldexp(1.0, exponent)
            active = fraction * magnitude
            params = Dict("power_nom"=>"1", "voltage_hv"=>"1", "voltage_lv"=>"1",
                "p_kz"=>string(active), "u_kz"=>string(100magnitude),
                "p_xx"=>string(active), "i_xx"=>string(100magnitude))
            model = try
                EC.transformer_model(EC.Branch(17,"transformer",1,2,1,2,params), buses, base, String[], String[])
            catch error
                error
            end
            @test model isa EC.BranchModel
            model isa EC.BranchModel || continue
            # Sn=1 MVA, U=1 kV: own and system bases coincide.
            # Independent passport relations |Z|=Uk/100 and |Y0|=I0/100.
            z = BigFloat(parse(Float64, params["u_kz"])) / 100
            r = BigFloat(parse(Float64, params["p_kz"]))
            reactive = sqrt(z^2 - r^2)
            expected_series = ComplexF64(inv(complex(r, reactive)))
            expected_shunt = ComplexF64(complex(r, -reactive))
            for (actual, expected) in ((model.y_series, expected_series), (model.y_from, expected_shunt))
                @test isfinite(actual)
                @test isapprox(real(actual), real(expected); rtol=32eps(Float64), atol=nextfloat(0.0))
                @test isapprox(imag(actual), imag(expected); rtol=32eps(Float64), atol=nextfloat(0.0))
            end
            # At equal rated winding voltages series current is zero. The
            # three-phase input must reproduce the physical no-load test.
            flow = EC.branch_flow(model, [1.0, 1.0], [0.0, 0.0], base)
            @test isapprox(flow.p_from_mw, Float64(r); rtol=32eps(Float64), atol=nextfloat(0.0))
            @test isapprox(flow.q_from_mvar, Float64(reactive); rtol=32eps(Float64), atol=nextfloat(0.0))
            @test flow.p_to_mw == 0
            @test flow.q_to_mvar == 0
        end
    end
end
