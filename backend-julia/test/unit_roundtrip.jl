@testset "Complex engineering-unit round trips preserve each component" begin
    base = BaseSystem(100.0, 10.0, "roundtrip-reference")
    for (forward, inverse) in ((EC.kv_to_pu, EC.pu_to_kv), (EC.mva_to_pu, EC.pu_to_mva),
            (EC.ohm_to_pu, EC.pu_to_ohm), (EC.siemens_to_pu, EC.pu_to_siemens), (EC.ka_to_pu, EC.pu_to_ka))
        value = 0.125 - 0.0625im
        @test inverse(forward(value, base), base) ≈ value rtol=8eps(Float64)
    end
end

@testset "Absolute engineering scales follow three-phase electrical definitions" begin
    setprecision(BigFloat, 256) do
        for (s, v) in ((100.0, 110.0), (50.0, 35.0), (1.0, 0.4))
            base = BaseSystem(s, v, "absolute-reference")
            sb, vb = BigFloat(s), BigFloat(v)
            scales = ((EC.kv_to_pu, EC.pu_to_kv, vb),
                (EC.mva_to_pu, EC.pu_to_mva, sb),
                (EC.ohm_to_pu, EC.pu_to_ohm, vb^2/sb),
                (EC.siemens_to_pu, EC.pu_to_siemens, sb/vb^2),
                (EC.ka_to_pu, EC.pu_to_ka, sb/(sqrt(BigFloat(3))*vb)))
            for (forward, inverse, scale) in scales
                value = 0.125 - 0.0625im
                @test forward(value, base) ≈ ComplexF64(Complex{BigFloat}(value)/scale) rtol=16eps(Float64)
                @test inverse(value, base) ≈ ComplexF64(Complex{BigFloat}(value)*scale) rtol=16eps(Float64)
            end
            @test sqrt(3.0)*EC.pu_to_kv(1.0, base)*EC.pu_to_ka(1.0, base) ≈ s rtol=8eps(Float64)
            @test EC.pu_to_ohm(1.0, base)*EC.pu_to_ka(1.0, base) ≈ v/sqrt(3.0) rtol=8eps(Float64)
        end
    end
end

@testset "Unit conversion rejects nonfinite, boolean and lost nonzero components" begin
    base = BaseSystem(100.0, 10.0, "checked-units")
    operations = (EC.kv_to_pu, EC.pu_to_kv, EC.mva_to_pu, EC.pu_to_mva, EC.ohm_to_pu,
        EC.pu_to_ohm, EC.siemens_to_pu, EC.pu_to_siemens, EC.ka_to_pu, EC.pu_to_ka)
    for convert in operations
        for value in (NaN, Inf, -Inf, complex(1.0, Inf), complex(NaN, 1.0), true, false,
                complex(true, false), BigFloat("1e-400"), complex(BigFloat(1), BigFloat("1e-400")), BigFloat("1e400"))
            @test_throws EnersyError convert(value, base)
        end
        for value in (-0.0, complex(-0.0, -0.0))
            result = convert(value, base)
            @test result == 0
            @test signbit(real(result))
            value isa Complex && @test signbit(imag(result))
        end
    end
    @test_throws EnersyError BaseSystem(true, 10.0, "boolean")
    @test_throws EnersyError BaseSystem(100.0, true, "boolean")
    for convert in (EC.impedance_from_own_base, EC.admittance_from_own_base)
        @test_throws EnersyError convert(1.0, true, 10.0, base)
        @test_throws EnersyError convert(1.0 + 1.0im, 100.0, true, base)
    end
    small, large = BaseSystem(1e-200, 1e-200, "small"), BaseSystem(1e200, 1e200, "large")
    for convert in (EC.kv_to_pu, EC.mva_to_pu, EC.ohm_to_pu)
        @test_throws EnersyError convert(1e200, small)
        @test_throws EnersyError convert(1e-200, large)
        @test_throws EnersyError convert(complex(1.0, 1e-200), large)
    end
    for convert in (EC.pu_to_kv, EC.pu_to_mva, EC.pu_to_ohm, EC.siemens_to_pu)
        @test_throws EnersyError convert(1e200, large)
        @test_throws EnersyError convert(1e-200, small)
        @test_throws EnersyError convert(complex(1.0, 1e-200), small)
    end
    @test_throws EnersyError EC.pu_to_siemens(1e200, small)
    @test_throws EnersyError EC.pu_to_siemens(1e-200, large)
    small_i, large_i = BaseSystem(1e-200, 1.0, "small-current"), BaseSystem(1e200, 1.0, "large-current")
    @test_throws EnersyError EC.ka_to_pu(1e200, small_i)
    @test_throws EnersyError EC.ka_to_pu(1e-200, large_i)
    @test_throws EnersyError EC.pu_to_ka(1e200, large_i)
    @test_throws EnersyError EC.pu_to_ka(1e-200, small_i)
    err = try EC.mva_to_pu(1e200, small; owner="load#42.p"); nothing catch error; error end
    @test err isa EnersyError && err.code == "unrepresentable_parameter" && err.detail == "load#42.p"
end

@testset "Base changes preserve physical quantities against independent BigFloat references" begin
    setprecision(BigFloat, 256) do
        bases = [BaseSystem(s, v, "explicit-base") for (s, v) in
            [(100.0, 110.0), (50.0, 35.0), (1.0, 0.4), (1e200, 1e200), (1e-200, 1e-200), (1e200, 1.0), (1e-200, 1.0)]]
        for from in bases, to in bases
            sf, vf, st, vt = BigFloat(from.s_base_mva), BigFloat(from.v_base_kv), BigFloat(to.s_base_mva), BigFloat(to.v_base_kv)
            # Independent definitions; do not reuse the kernel's cached scales.
            factors = ((EC.rebase_voltage, EC.pu_to_kv, vf/vt),
                (EC.rebase_power, EC.pu_to_mva, sf/st),
                (EC.rebase_current, EC.pu_to_ka, (sf/vf)/(st/vt)),
                (EC.rebase_impedance, EC.pu_to_ohm, (vf^2/sf)/(vt^2/st)),
                (EC.rebase_admittance, EC.pu_to_siemens, (vt^2/st)/(vf^2/sf)))
            for (rebase, physical, factor) in factors, coefficient in (0.125, 1e-200, 1e200), complex_input in (false, true)
                value = complex_input ? complex(coefficient, -coefficient/2) : coefficient
                reference = complex_input ? ComplexF64(Complex{BigFloat}(value) * factor) : Float64(BigFloat(value) * factor)
                representable = isfinite(reference) && real(reference) != 0 && (!complex_input || imag(reference) != 0)
                if !representable
                    @test_throws EnersyError rebase(value, from, to)
                    continue
                end
                actual = rebase(value, from, to)
                @test typeof(actual) == typeof(value)
                @test isapprox(real(actual), real(reference); rtol=32eps(Float64), atol=nextfloat(0.0))
                @test isapprox(imag(actual), imag(reference); rtol=32eps(Float64), atol=nextfloat(0.0))
                restored = rebase(actual, to, from)
                @test isapprox(real(restored), real(value); rtol=64eps(Float64), atol=nextfloat(0.0))
                @test isapprox(imag(restored), imag(value); rtol=64eps(Float64), atol=nextfloat(0.0))
                # Ordinary engineering bases additionally preserve the actual
                # physical quantity through the two public inverse conversions.
                if sf < 1e5 && st < 1e5 && vf > 0.1 && vt > 0.1 && coefficient == 0.125
                    @test isapprox(physical(actual, to), physical(value, from); rtol=64eps(Float64))
                end
            end
        end
    end
end

@testset "HTTP conversion error names the physical component and parameter" begin
    payload = Dict("components"=>[
        Dict("id"=>1,"type"=>"generator","params"=>Dict("p"=>"0","e"=>"1","voltage_nom"=>"1","r"=>"1","x"=>"0")),
        Dict("id"=>2,"type"=>"load","params"=>Dict("p"=>"1e200","q"=>"0","voltage_nom"=>"1"))],
        "connections"=>[Dict("from"=>1,"to"=>2,"fromPort"=>"bottom","toPort"=>"top")],
        "base"=>Dict("s_base_mva"=>1e-200,"v_base_kv"=>1.0))
    response = EC.handle_request(EC.HTTP.Request("POST", "/calculate", [], EC.JSON.json(payload)))
    result = EC.JSON.parse(response.body)
    @test response.status == 400
    @test result.success === false
    @test result.error_detail.code == "unrepresentable_parameter"
    @test endswith(result.error_detail.detail, "load#2.p")
    @test occursin("island=1", result.error_detail.detail)
    @test !haskey(result, "nodes")
end
