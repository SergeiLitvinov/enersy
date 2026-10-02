"""
Assemble the same polar equations as the dense reference implementation,
visiting only stored network couplings. Diagonals are assembled separately:
P/Q terms also contribute when Yii is absent or cancels to zero.
No conversion of Y or J to a dense matrix is permitted in this path.
"""
function jacobian(Y::SparseMatrixCSC{ComplexF64}, v::Vector{Float64}, theta::Vector{Float64},
                  P::Vector{Float64}, Q::Vector{Float64}, setup::PowerFlowSetup)
    col_theta, col_v = unknown_columns(setup)
    row_p, row_q, row_v = zeros(Int, setup.nbus), zeros(Int, setup.nbus), zeros(Int, setup.nbus)
    r = 0
    for bus in vcat(setup.pv, setup.pq)
        row_p[bus] = (r += 1)
    end
    for bus in setup.pq
        row_q[bus] = (r += 1)
    end
    for bus in setup.pv
        row_v[bus] = (r += 1)
    end
    rows, cols, vals = Int[], Int[], Float64[]
    capacity = 4 * nnz(Y) + 5 * setup.nbus
    sizehint!(rows, capacity); sizehint!(cols, capacity); sizehint!(vals, capacity)
    function stamp(row, col, value)
        push!(rows, row); push!(cols, col); push!(vals, value)
    end
    rv, yv = rowvals(Y), nonzeros(Y)
    for k in axes(Y, 2)
        k == setup.slack && continue
        for index in nzrange(Y, k)
            i = rv[index]
            (i == k || i == setup.slack) && continue
            g, b = real(yv[index]), imag(yv[index])
            sn, cs = sincos(theta[i] - theta[k])
            stamp(row_p[i], col_theta[k], v[i] * v[k] * (g * sn - b * cs))
            stamp(row_p[i], col_v[k], v[i] * (g * cs + b * sn))
            if row_q[i] != 0
                stamp(row_q[i], col_theta[k], -v[i] * v[k] * (g * cs + b * sn))
                stamp(row_q[i], col_v[k], v[i] * (g * sn - b * cs))
            end
        end
    end
    for i in vcat(setup.pv, setup.pq)
        g, b = real(Y[i, i]), imag(Y[i, i])
        stamp(row_p[i], col_theta[i], -Q[i] - v[i]^2 * b)
        stamp(row_p[i], col_v[i], v[i] * g + P[i] / v[i])
        if row_q[i] != 0
            stamp(row_q[i], col_theta[i], P[i] - v[i]^2 * g)
            stamp(row_q[i], col_v[i], Q[i] / v[i] - v[i] * b)
        end
        row_v[i] == 0 || stamp(row_v[i], col_v[i], 2 * v[i])
    end
    neq = number_of_equations(setup)
    J = sparse(rows, cols, vals, neq, neq)
    dropzeros!(J)
    return J, col_theta, col_v
end
