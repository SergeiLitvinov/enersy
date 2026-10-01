#=
Метод Ньютона–Рафсона для установившегося режима в полярных координатах
(безразмерные единицы, симметричный AC-режим).

Постановка. Для каждого узла `i` напряжение `V_i = |V_i|∠θ_i`; инъекции заданы в
p.u. от `S_base`, `V_base` (`units.jl`). Балансирующий узел (slack) задаёт `|V|`
и служит отсчётом угла; PV-узлы задают `P` и `|V|`; PQ-узлы задают `P` и `Q`.

Неизвестные — `θ` и `|V|` всех узлов, кроме балансирующего:

    neq = 2·(n_pv + n_pq)

Уравнения:

    ΔP_i  = P_spec_i − P_calc_i     для PV и PQ
    ΔQ_i  = Q_spec_i − Q_calc_i     для PQ
    Δ|V|² = |V_spec|² − |V_calc|²   для PV

Размерность невязок единая (A02): прежняя реализация объявляла
`neq = npq + npv + npq`, то есть лишние невязки `ΔV` для PV-узлов, и добавляла
лишние столбцы, из-за чего система не имела решения.

Инъекции вычисляются из Y-матрицы в p.u.: `S_i = V_i · conj(Σ_k Y_ik·V_k)`,
поэтому невязки и мощности в одних единицах, а невязка реактивной мощности
никогда не вычитается из тока (A06).

Диагностика, которая раньше отсутствовала: несходимость, вырожденный Якобиан,
нечисловой шаг, неположительное напряжение — все они дают `EnersyError` с
указанием стадии, а не «ответ» с произвольными числами.
=#

"""Типы узлов и заданные величины для итерационного метода (в p.u.).

Заданные мощности хранятся позиционно — в порядке `pv`, `pq`, — а не с
индексацией по номеру узла: это исключает обращение к чужому элементу при
изменении состава узлов и делает соответствие «невязка ↔ спецификация»
проверяемым (единая размерность, см. `mismatch_vector`).
"""
struct PowerFlowSetup
    nbus::Int
    slack::Int
    slack_v::Float64
    slack_theta::Float64
    pv::Vector{Int}
    pq::Vector{Int}
    pv_v::Vector{Float64}
    p_pv::Vector{Float64}
    p_pq::Vector{Float64}
    q_pq::Vector{Float64}
end

function PowerFlowSetup(nbus::Int, slack::Int, slack_v::Real, slack_theta::Real,
                         pv::Vector{Int}, pq::Vector{Int}, pv_v::Vector{Float64},
                         p_pv::Vector{Float64}, p_pq::Vector{Float64},
                         q_pq::Vector{Float64})
    length(pv) == length(pv_v) == length(p_pv) ||
        throw(contract_error("inconsistent_setup",
            "PV specification must provide one voltage and one active power per PV bus",
            detail="pv=$(length(pv)) pv_v=$(length(pv_v)) p_pv=$(length(p_pv))"))
    length(pq) == length(p_pq) == length(q_pq) ||
        throw(contract_error("inconsistent_setup",
            "PQ specification must provide one active and one reactive power per PQ bus",
            detail="pq=$(length(pq)) p_pq=$(length(p_pq)) q_pq=$(length(q_pq))"))
    return PowerFlowSetup(nbus, slack, Float64(slack_v), Float64(slack_theta),
                          pv, pq, pv_v, p_pv, p_pq, q_pq)
end

"""Результат расчёта режима: модули и углы узлов, вычисленные инъекции, статистика."""
struct PowerFlowResult
    v::Vector{Float64}
    theta::Vector{Float64}
    voltages::Vector{ComplexF64}
    p::Vector{Float64}
    q::Vector{Float64}
    iterations::Int
    max_mismatch::Float64
end

number_of_equations(setup::PowerFlowSetup) = 2 * (length(setup.pv) + length(setup.pq))

"""
    bus_powers(Y, v, theta)

Комплексные напряжения и мощности инъекций всех узлов в p.u. по
`S_i = V_i·conj(Σ_k Y_ik·V_k)`.
"""
function bus_powers(Y::AbstractMatrix{ComplexF64}, v::Vector{Float64}, theta::Vector{Float64})
    V = [cis(theta[i]) * v[i] for i in eachindex(v)]
    S = V .* conj.(Y * V)
    return (V = V, S = S, P = real.(S), Q = imag.(S))
end

"""
    unknown_columns(setup)

Соответствие «узел → номер неизвестного» для углов и модулей напряжения.
"""
function unknown_columns(setup::PowerFlowSetup)
    col_theta = Dict{Int,Int}()
    col_v = Dict{Int,Int}()
    c = 0
    for i in setup.pv
        c += 1
        col_theta[i] = c
    end
    for i in setup.pq
        c += 1
        col_theta[i] = c
    end
    for i in setup.pv
        c += 1
        col_v[i] = c
    end
    for i in setup.pq
        c += 1
        col_v[i] = c
    end
    return col_theta, col_v
end

"""
    mismatch_vector(powers, setup)

Вектор невязок в порядке `[ΔP_PV; ΔP_PQ; ΔQ_PQ; Δ|V|²_PV]`; размерность равна
`number_of_equations(setup)`. Спецификации берутся позиционно (см.
`PowerFlowSetup`), поэтому строка невязки и строка спецификации всегда
соответствуют одному и тому же узлу.
"""
function mismatch_vector(powers, setup::PowerFlowSetup)
    return vcat([setup.p_pv[k] - powers.P[i] for (k, i) in enumerate(setup.pv)],
                [setup.p_pq[k] - powers.P[i] for (k, i) in enumerate(setup.pq)],
                [setup.q_pq[k] - powers.Q[i] for (k, i) in enumerate(setup.pq)],
                [setup.pv_v[k]^2 - abs2(powers.V[i]) for (k, i) in enumerate(setup.pv)])
end

"""
    jacobian(Y, v, theta, P, Q, setup; col_theta, col_v)

Матрица Якобиана для порядка неизвестных `unknown_columns(setup)` и порядка
невязок `mismatch_vector`. Диагональные элементы берутся из частных производных
при `k = i`, поэтому не используется «усреднённая» формула: она даёт неверный
Якобиан (A06).
"""
function jacobian(Y::AbstractMatrix{ComplexF64}, v::Vector{Float64}, theta::Vector{Float64},
                  P::Vector{Float64}, Q::Vector{Float64}, setup::PowerFlowSetup)
    col_theta, col_v = unknown_columns(setup)
    row_p = Dict{Int,Int}()
    row_q = Dict{Int,Int}()
    row_v = Dict{Int,Int}()
    r = 0
    for i in setup.pv
        r += 1
        row_p[i] = r
    end
    for i in setup.pq
        r += 1
        row_p[i] = r
    end
    for i in setup.pq
        r += 1
        row_q[i] = r
    end
    for i in setup.pv
        r += 1
        row_v[i] = r
    end
    neq = number_of_equations(setup)
    J = zeros(Float64, neq, neq)
    G = real.(Y)
    B = imag.(Y)
    non_slack = vcat(setup.pv, setup.pq)
    for i in non_slack
        for k in non_slack
            dtheta = theta[i] - theta[k]
            c, s = cos(dtheta), sin(dtheta)
            if i == k
                dP_dtheta = -Q[i] - v[i]^2 * B[i, i]
                dP_dv = v[i] * G[i, i] + P[i] / v[i]
                dQ_dtheta = P[i] - v[i]^2 * G[i, i]
                dQ_dv = Q[i] / v[i] - v[i] * B[i, i]
            else
                dP_dtheta = v[i] * v[k] * (G[i, k] * s - B[i, k] * c)
                dP_dv = v[i] * (G[i, k] * c + B[i, k] * s)
                dQ_dtheta = -v[i] * v[k] * (G[i, k] * c + B[i, k] * s)
                dQ_dv = v[i] * (G[i, k] * s - B[i, k] * c)
            end
            J[row_p[i], col_theta[k]] = dP_dtheta
            J[row_p[i], col_v[k]] = dP_dv
            if haskey(row_q, i)
                J[row_q[i], col_theta[k]] = dQ_dtheta
                J[row_q[i], col_v[k]] = dQ_dv
            end
        end
        if haskey(row_v, i)
            J[row_v[i], col_v[i]] = 2.0 * v[i]
        end
    end
    return J, col_theta, col_v
end

"""Решение линейной системы шага Ньютона с диагностикой вырождения."""
function solve_jacobian(J::Matrix{Float64}, F::Vector{Float64}, iteration::Int)
    F_lu = lu(J; check=false)
    issuccess(F_lu) ||
        throw(solver_error("singular_jacobian",
            "Матрица Якобиана вырождена: система не имеет единственного решения",
            detail="iteration=$(iteration) size=$(size(J, 1)) " *
                   "cond=$(_cond_estimate(J))"))
    dx = F_lu \ F
    all(isfinite, dx) ||
        throw(solver_error("non_finite_correction",
            "Шаг метода Ньютона содержит нечисловые значения",
            detail="iteration=$(iteration)"))
    return dx
end

function _cond_estimate(J::Matrix{Float64})
    n = size(J, 1)
    n == 0 && return NaN
    try
        return @sprintf("%.3e", cond(J))
    catch
        return NaN
    end
end

"""Проверка физической допустимости промежуточного приближения."""
function check_state(v::Vector{Float64}, theta::Vector{Float64}, iteration::Int)
    all(isfinite, v) && all(isfinite, theta) ||
        throw(solver_error("non_finite_state",
            "Итерация дала нечисловое напряжение или угол",
            detail="iteration=$(iteration)"))
    bad = findfirst(x -> x <= 0.0, v)
    bad === nothing || throw(solver_error("non_positive_voltage",
        "Итерация дала неположительный модуль напряжения",
        detail="iteration=$(iteration) node=$(bad) v_pu=$(v[bad])"))
    return nothing
end

"""
    newton_raphson(Y, setup, options)

Расчёт режима. Начальное приближение — плоское: `|V| = 1.0` (кроме slack и PV с
заданным `|V|`), `θ = θ_slack`; выбор плоского пуска фиксируется вызывающим
кодом в `assumptions`. Метод возвращает `PowerFlowResult` либо бросает
`solver_error` (`no_convergence`, `singular_jacobian`, `non_finite_correction`,
`non_positive_voltage`).
"""
function newton_raphson(Y::AbstractMatrix{ComplexF64}, setup::PowerFlowSetup,
                        options::SolverOptions; initial_v::Union{Nothing,Vector{Float64}}=nothing)
    n = setup.nbus
    size(Y) == (n, n) || throw(contract_error("dimension_mismatch", "Y and setup dimensions differ"))
    v = initial_v === nothing ? ones(Float64, n) : copy(initial_v)
    length(v) == n || throw(contract_error("dimension_mismatch", "initial voltage size differs"))
    theta = zeros(Float64, n)
    v[setup.slack] = setup.slack_v
    v[setup.slack] > 0 ||
        throw(contract_error("invalid_slack_voltage",
            "Заданное напряжение балансирующего узла должно быть положительным",
            detail="slack=$(setup.slack) v_pu=$(setup.slack_v)"))
    for (k, i) in enumerate(setup.pv)
        v[i] = setup.pv_v[k]
        v[i] > 0 ||
            throw(contract_error("invalid_pv_voltage",
                "Заданное напряжение PV-узла должно быть положительным",
                detail="node=$(i) v_pu=$(v[i])"))
    end
    theta[setup.slack] = setup.slack_theta
    for i in setup.pv
        theta[i] = setup.slack_theta
    end
    for i in setup.pq
        theta[i] = setup.slack_theta
    end
    check_state(v, theta, 0)

    if number_of_equations(setup) == 0
        powers = bus_powers(Y, v, theta)
        return PowerFlowResult(v, theta, powers.V, powers.P, powers.Q, 0, 0.0)
    end

    for iteration in 1:options.max_iterations
        powers = bus_powers(Y, v, theta)
        F = mismatch_vector(powers, setup)
        m = maximum(abs, F)
        if m < options.tolerance
            return PowerFlowResult(v, theta, powers.V, powers.P, powers.Q,
                                   iteration - 1, m)
        end
        J, col_theta, col_v = jacobian(Y, v, theta, powers.P, powers.Q, setup)
        dx = solve_jacobian(J, F, iteration)
        for (i, c) in col_theta
            theta[i] += dx[c]
        end
        for (i, c) in col_v
            v[i] += dx[c]
        end
        check_state(v, theta, iteration)
    end

    powers = bus_powers(Y, v, theta)
    m = maximum(abs, mismatch_vector(powers, setup))
    if m < options.tolerance
        return PowerFlowResult(v, theta, powers.V, powers.P, powers.Q, options.max_iterations, m)
    end
    throw(solver_error("no_convergence",
        "Метод Ньютона–Рафсона не сошёлся за $(options.max_iterations) итераций",
        detail="max_mismatch_pu=$(m) tolerance_pu=$(options.tolerance) " *
               "nodes=$(setup.nbus) equations=$(number_of_equations(setup))"))
end
