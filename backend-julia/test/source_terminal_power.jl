@testset "Source EMF and terminal powers against an independent circuit" begin
    # Three-phase MW/Mvar, line-to-line RMS kV, per-phase Ohm.
    # E*conj(V) = |V|² + Z*conj(S); solve the quadratic in |V|².
    for (rs, xs, p, q) in [(0.1, 0.5, 10.0, 3.0), (0.1, 0.5, 10.0, -3.0),
                            (0.1, 0.0, 10.0, 0.0), (0.0, 0.5, 10.0, 3.0)]
        cs, es = fixture()
        cs[1].params["r"], cs[1].params["x"] = string(rs), string(xs)
        cs[4].params["r0"], cs[4].params["x0"] = "0.1", "0.5"
        cs[5].params["p"], cs[5].params["q"] = string(p), string(q)
        zs, zl, demand, emf = complex(rs, xs), 0.1 + 0.5im, complex(p, q), 10.0
        a = (zs + zl) * conj(demand)
        b = 2real(a) - emf^2
        u = (-b + sqrt(b^2 - 4abs2(a))) / 2
        voltage = conj((u + a) / emf)
        current = conj(demand / voltage) # sqrt(3) times the phase current, kA
        terminal = voltage + zl * current
        terminal_power = terminal * conj(current)
        internal_power = emf * conj(current)
        loss = zs * abs2(current)
        result = calculate(cs, es; options=SolverOptions(tolerance=1e-11))
        source = only(result["sources"])
        for (key, expected) in [("terminal_p_mw", real(terminal_power)),
                                ("terminal_q_mvar", imag(terminal_power)),
                                ("p_mw", real(internal_power)), ("q_mvar", imag(internal_power)),
                                ("losses_p_mw", real(loss)), ("losses_q_mvar", imag(loss))]
            @test source[key] ≈ expected atol=1e-7 rtol=1e-9
        end
        @test source["p_mw"] ≈ source["terminal_p_mw"] + source["losses_p_mw"] atol=1e-7
        @test source["q_mvar"] ≈ source["terminal_q_mvar"] + source["losses_q_mvar"] atol=1e-7
        branch = only(filter(b -> b["code"] == "generator", result["branches"]))
        @test source["terminal_p_mw"] == -branch["p_to_mw"]
        @test source["terminal_q_mvar"] == -branch["q_to_mvar"]
        reordered = calculate(reverse(cs), reverse(es); options=SolverOptions(tolerance=1e-11))
        @test only(reordered["sources"])["terminal_p_mw"] ≈ source["terminal_p_mw"] atol=1e-7
    end
end
