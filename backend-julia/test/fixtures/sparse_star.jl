# Original analytical radial network, 100 MVA / 110 kV base.
# Each leaf is connected to slack V=1 through z=0.01+j0.1 p.u.
# Leaf V*=0.99∠-0.01 gives S*=V*conj((V*-1)/z), explicitly independent
# of the production bus-power and matrix assembly routines.
function analytical_star(n::Int)
    n >= 2 || error("star needs at least two buses")
    y = inv(0.01 + 0.1im)
    expected = 0.99 * cis(-0.01)
    injection = expected * conj((expected - 1) * y)
    rows, cols, vals = Int[], Int[], ComplexF64[]
    for i in 2:n
        append!(rows, [1, i, 1, i]); append!(cols, [1, i, i, 1])
        append!(vals, [y, y, -y, -y])
    end
    Y = sparse(rows, cols, vals, n, n)
    setup = EnersyCompute.PowerFlowSetup(n, 1, 1.0, 0.0, Int[], collect(2:n),
        Float64[], Float64[], fill(real(injection), n-1), fill(imag(injection), n-1))
    return Y, setup, expected, injection
end
