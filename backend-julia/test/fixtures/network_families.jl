# Original manufactured AC cases, not imported equipment or normative cases.
# 100 MVA / 110 kV; all equations below use p.u. Line z is per phase.
function manufactured_network(family::AbstractString, n::Int; seed::UInt64=UInt64(20261021))
    n >= 4 || throw(ArgumentError("network requires at least four buses"))
    family in ("radial", "ring", "mesh") || throw(ArgumentError("unknown network family"))
    pairs = Tuple{Int,Int}[]
    if family == "radial"
        append!(pairs, [(i ÷ 2, i) for i in 2:n])
    elseif family == "ring"
        append!(pairs, [(i, i + 1) for i in 1:n-1]); push!(pairs, (1, n))
    else
        width = isqrt(n)
        for i in 1:n
            i % width != 0 && i < n && push!(pairs, (i, i + 1))
            i + width <= n && push!(pairs, (i, i + width))
        end
    end
    # Fixed integer generator: reproducible independently of Random/toolchain.
    state = seed
    edges = Tuple{Int,Int,ComplexF64}[]
    voltage = ComplexF64[(1 - 0.01 * (i - 1) / (n - 1)) * cis(-0.01 * (i - 1) / (n - 1)) for i in 1:n]
    currents = zeros(ComplexF64, n)
    rows, cols, values = Int[], Int[], ComplexF64[]
    sizehint!(edges, length(pairs)); sizehint!(rows, 4length(pairs))
    sizehint!(cols, 4length(pairs)); sizehint!(values, 4length(pairs))
    for (i, j) in pairs
        state = state * UInt64(6364136223846793005) + UInt64(1)
        factor = 0.75 + Float64((state >> 32) & UInt64(1023)) / 2048
        z = complex(0.01, 0.1) * factor
        push!(edges, (i, j, z))
        current = (voltage[i] - voltage[j]) / z
        currents[i] += current; currents[j] -= current
        y = inv(z)
        append!(rows, (i, j, i, j)); append!(cols, (i, j, j, i))
        append!(values, (y, y, -y, -y))
    end
    injection = voltage .* conj.(currents)
    Y = sparse(rows, cols, values, n, n)
    setup = EnersyCompute.PowerFlowSetup(n, 1, 1.0, 0.0, Int[], collect(2:n),
        Float64[], Float64[], real.(injection[2:end]), imag.(injection[2:end]))
    return (; family=String(family), seed, edges, Y, setup, voltage, injection)
end
