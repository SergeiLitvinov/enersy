"""
    solve_linear(A, b)

Прямое решение квадратной системы `A·x = b` (LU с частичным выбором ведущего
элемента) с диагностикой вырождения.

Назначение — служебная проверка инструментария (например, сверка с
эталонным решением), а не расчёт режима сети: искусственное линейное решение
не является установившимся режимом, и режим `three-phase/direct` поэтому
находится в реестре возможностей как `UNSUPPORTED` (см. `capabilities.jl`).
"""
function solve_linear(A::AbstractMatrix{<:Real}, b::AbstractVector{<:Real})
    n, m = size(A)
    n == m ||
        throw(contract_error("non_square_matrix", "A must be square",
                             detail="rows=$(n) cols=$(m)"))
    length(b) == n ||
        throw(contract_error("dimension_mismatch", "A and b dimensions do not match",
                             detail="size(A)=$(n)×$(m) length(b)=$(length(b))"))
    n > 0 || throw(contract_error("empty_matrix", "A must contain at least one row"))
    all(isfinite, A) && all(isfinite, b) ||
        throw(contract_error("not_finite", "A and b must contain finite numbers"))
    F = lu(Matrix{Float64}(A); check=false)
    issuccess(F) ||
        throw(solver_error("singular_matrix",
            "Матрица вырождена: система не имеет единственного решения",
            detail="size=$(n)×$(m) cond=$(@sprintf("%.3e", _try_cond(Matrix{Float64}(A))))"))
    x = F \ Vector{Float64}(b)
    all(isfinite, x) ||
        throw(solver_error("non_finite_solution", "Решение содержит нечисловые значения",
                           detail="size=$(n)"))
    return x
end

function _try_cond(A::Matrix{Float64})
    try
        return cond(A)
    catch
        return NaN
    end
end
