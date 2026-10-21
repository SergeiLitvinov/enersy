@testset "Own-base conversions against independent high precision" begin
    # Three-phase MVA and line-to-line RMS kV. Evaluate the electrical
    # definitions directly at 256-bit precision, independently of the kernel.
    setprecision(BigFloat, 256) do
        for (s, v, sn, un, value) in [
            (100.0, 10.0, 50.0, 10.0, 0.01 + 0.1im),
            (1e200, 1e200, 100.0, 10.0, 0.01 + 0.1im),
            (1e-200, 1e-200, 100.0, 10.0, 0.01 + 0.1im),
            (100.0, 10.0, 1e200, 1e200, 0.01 + 0.1im),
            (1e200, 1e200, 1e-200, 1e-200, 1e200 + 1e200im),
            (1e-200, 1e-200, 1e200, 1e200, 1e-200 + 1e-200im),
        ]
            base = BaseSystem(s, v, "own-base-reference")
            z_scale = (BigFloat(s) / BigFloat(sn)) * (BigFloat(un) / BigFloat(v))^2
            for (convert, scale) in [(EC.impedance_from_own_base, z_scale), (EC.admittance_from_own_base, inv(z_scale))]
                reference = ComplexF64(Complex{BigFloat}(value) * scale)
                if isfinite(reference) && reference != 0
                    actual = convert(value, sn, un, base)
                    @test isfinite(actual)
                    @test isapprox(real(actual), real(reference); rtol=16eps(Float64), atol=nextfloat(0.0))
                    @test isapprox(imag(actual), imag(reference); rtol=16eps(Float64), atol=nextfloat(0.0))
                end
            end
        end
    end
end

@testset "Own-base exponent sweep and invalid ranges" begin
    setprecision(BigFloat, 256) do
        for (s, v) in [(100.0, 10.0), (50.0, 110.0), (1e200, 1e200), (1e-200, 1e-200)],
            es in (-900, -300, 0, 300, 900), eu in (-900, -300, 0, 300, 900),
            ez in (-900, -300, 0, 300, 900)
            sn, un = ldexp(0.625, es), ldexp(0.875, eu)
            value = complex(ldexp(0.75, ez), -ldexp(0.625, ez))
            base = BaseSystem(s, v, "own-base-exponents")
            factor = (BigFloat(s) / BigFloat(sn)) * (BigFloat(un) / BigFloat(v))^2
            for (convert, scale) in [(EC.impedance_from_own_base, factor), (EC.admittance_from_own_base, inv(factor))]
                reference = ComplexF64(Complex{BigFloat}(value) * scale)
                if isfinite(reference) && real(reference) != 0 && imag(reference) != 0
                    actual = convert(value, sn, un, base)
                    @test isapprox(real(actual), real(reference); rtol=16eps(Float64), atol=nextfloat(0.0))
                    @test isapprox(imag(actual), imag(reference); rtol=16eps(Float64), atol=nextfloat(0.0))
                else
                    err = try convert(value, sn, un, base); nothing catch error; error end
                    @test err isa EnersyError
                    @test err isa EnersyError && err.code == "unrepresentable_parameter"
                end
            end
        end
    end
    base = BaseSystem(100.0, 10.0, "own-base-validation")
    for convert in (EC.impedance_from_own_base, EC.admittance_from_own_base)
        for (sn, un) in [(0.0, 10.0), (-1.0, 10.0), (NaN, 10.0), (Inf, 10.0), (100.0, 0.0), (100.0, -1.0), (100.0, Inf)]
            @test_throws EnersyError convert(1.0 + 1.0im, sn, un, base)
        end
        for value in (complex(NaN, 0.0), complex(0.0, Inf))
            @test_throws EnersyError convert(value, 100.0, 10.0, base)
        end
        zero = convert(complex(-0.0, 0.0), 1e-200, 1e200, base)
        @test zero == 0
        @test signbit(real(zero))
    end
end

@testset "Engineering units and inverse own-base conversion" begin
    for (sn, un, sb, ub) in [(100.0, 110.0, 50.0, 35.0), (1.0, 10.0, 100.0, 0.4), (250.0, 220.0, 100.0, 110.0)]
        base = BaseSystem(sb, ub, "engineering")
        own = BaseSystem(sn, un, "passport")
        z = 0.01 + 0.1im
        y = inv(z)
        converted_z = EC.impedance_from_own_base(z, sn, un, base)
        converted_y = EC.admittance_from_own_base(y, sn, un, base)
        @test isapprox(converted_z * converted_y, 1; rtol=16eps(Float64))
        @test isapprox(EC.impedance_from_own_base(converted_z, sb, ub, own), z; rtol=16eps(Float64))
        @test isapprox(EC.admittance_from_own_base(converted_y, sb, ub, own), y; rtol=16eps(Float64))
        ohms = converted_z * EC.z_base_ohm(base)
        @test isapprox(ohms, z * (un^2/sn); rtol=16eps(Float64))
    end
end

@testset "Unrepresentable transformer parameter is an HTTP contract error" begin
    payload = Dict("components" => [Dict("id" => 17, "type" => "transformer", "params" => Dict(
        "power_nom" => "100", "voltage_hv" => "1e-200", "voltage_lv" => "1e-200", "p_kz" => "1", "u_kz" => "10"))],
        "connections" => [], "base" => Dict("s_base_mva" => 100.0, "v_base_kv" => 10.0))
    response = handle_request(HTTP.Request("POST", "/calculate", [], JSON3.write(payload)))
    @test response.status == 400
    @test JSON3.read(response.body).error_detail.code == "unrepresentable_parameter"
    @test occursin("transformer#17", JSON3.read(response.body).error_detail.detail)
    server = start_server(; host="127.0.0.1", port=0)
    try
        reply = HTTP.post("http://127.0.0.1:$(HTTP.port(server))/calculate", [], JSON3.write(payload);
                          status_exception=false, proxy=HTTP.ProxyConfig())
        @test reply.status == 400
        @test JSON3.read(reply.body).error_detail.code == "unrepresentable_parameter"
        @test occursin("transformer#17", JSON3.read(reply.body).error_detail.detail)
    finally
        HTTP.forceclose(server)
    end
end
