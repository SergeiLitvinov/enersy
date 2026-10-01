"""
Физические модели элементов в безразмерных единицах (p.u. на явно переданном
базисе).

Модели симметричного AC-режима `three-phase`:

* **источник** — ЭДС `E∠δ` за последовательным сопротивлением `r + jx`. ЭДС
  образует внутренний узел: первый источник становится slack с заданными
  `|E|` и углом (его P определяется сетью), остальные — PV с заданными P и |E|.
  Прежняя реализация объявляла генератор PV-узлом с произвольным
  напряжением и не использовала `r`, `x` (A01);
* **линия** — π-модель с удельными `r0`, `x0` (Ом/км), `b0`, `g0` (См/км) и
  числом параллельных цепей; прежняя реализация подставляла произвольную
  диагональную проводимость `0.001 + 0.01im` (A04);
* **двухобмоточный трансформатор** — последовательное сопротивление из потерь
  короткого замыкания `p_kz`, `u_kz` на собственном базисе `(S_nom, U_hv)`,
  коэффициент stamp `U_lv/U_hv` на общем базисе напряжения и ветвь намагничивания `p_xx`, `i_xx`,
  отнесённая к обмотке ВН;
* **шунт** — постоянная проводимость, обеспечивающая `Q_nom` при номинальном
  напряжении узла. `q_nom` — неотрицательный паспортный модуль мощности;
  конденсатор выдаёт реактивную мощность, реактор потребляет;
* **идеальный аппарат** (замкнутый выключатель, разъединитель) —
  в Y-матрицу не вносится; разомкнутый аппарат, наоборот, не объединяет узлы
  (см. `topology.jl`).

Единицы: напряжения — кВ (линейные действующие), мощности — МВт/Мвар
(полные трёхфазные), сопротивления — Ом на фазу, проводимости — См на фазу.
Ни один физический параметр не подставляется молча: обязательный параметр
отсутствует — ошибка контракта; явно необязательный используется со значением
по умолчанию, и факт подстановки попадает в отчёт `assumptions`.

Не поддерживаются (отказ с кодом `unsupported_component`, а не пропуск):
трёхобмоточные трансформаторы, автотрансформаторы, заземление, несимметрия, ЛЭП с
проводимостью переноса — см. `capabilities.jl`.
"""

#: Допуск сверки номинального напряжения узла с номиналом элемента.
const VOLTAGE_LEVEL_TOLERANCE = 0.10

#: Допуск сверки симметрии фазных параметров ЛЭП с удельными `r0`, `x0`.
const LINE_SYMMETRY_TOLERANCE = 0.01

"""
    BranchModel

Модель двухполюсного элемента, готовая к внесению в Y-матрицу.

`y_series` задана на базисе `from_bus`, `ratio` — идеальный коэффициент
(`U_lv/U_hv` на общем базисе, 1 — без трансформации), `y_from` и `y_to` —
шунты своих сторон; деление на `ratio²` применяется к последовательной ветви.
"""
struct BranchModel
    component_id::Int
    code::String
    from_bus::Int
    to_bus::Int
    ratio::Float64
    y_series::ComplexF64
    y_from::ComplexF64
    y_to::ComplexF64
    owner::String
end

"""Модель шунта постоянной проводимости, приведённая к базису узла."""
struct ShuntModel
    component_id::Int
    code::String
    bus::Int
    y_pu::ComplexF64
    q_nom_mvar::Float64
    owner::String
end

"""
    stamp!(Y, m::BranchModel)

Внесение двухполюсного элемента в Y-матрицу:

    Y[i,i] += y + y_from;   Y[j,j] += y/ratio² + y_to
    Y[i,j] -= y/ratio;      Y[j,i] -= y/ratio
"""
function stamp!(Y::Matrix{ComplexF64}, m::BranchModel)
    i, j, t = m.from_bus, m.to_bus, m.ratio
    ys = m.y_series
    Y[i, i] += ys + m.y_from
    Y[j, j] += ys / (t * t) + m.y_to
    Y[i, j] -= ys / t
    Y[j, i] -= ys / t
    return Y
end

function stamp!(Y::Matrix{ComplexF64}, m::ShuntModel)
    Y[m.bus, m.bus] += m.y_pu
    return Y
end

"""
    AcSystem

Собранная система в терминах моделей: расширенный список узлов (внутренние
узлы источников включены), модели ветвей и шунтов, инъекции с источниками,
перенесёнными на внутренние узлы, и накопленные предупреждения/допущения.
"""
struct AcSystem
    buses::Vector{Bus}
    branch_models::Vector{BranchModel}
    shunts::Vector{ShuntModel}
    injections::Vector{Injection}
    sources::Vector{Injection}
    assumptions::Vector{String}
    warnings::Vector{String}
end

# --- модели элементов -----------------------------------------------------------

"""
    line_model(branch, buses, base, assumptions, warnings)

π-модель ЛЭП. Сопротивление цепи `z = (r0 + j·x0)·L / n_цепей` (Ом на фазу),
проводимость наполнения `(g0 + j·b0)·L·n_цепей`, половина — на каждый конец.
"""
function line_model(branch::Branch, buses::Dict{Int,Bus}, base::BaseSystem,
                    assumptions::Vector{String}, warnings::Vector{String})
    owner = "transmission_line#$(branch.component_id)"
    p = branch.params
    len_km = param_number(p, "length"; unit="km", owner=owner)
    r0 = param_number(p, "r0"; unit="Ohm/km", owner=owner)
    x0 = param_number(p, "x0"; unit="Ohm/km", owner=owner)
    b0 = param_number(p, "b0"; required=false, default=0.0, unit="S/km", owner=owner)
    g0 = param_number(p, "g0"; required=false, default=0.0, unit="S/km", owner=owner)
    circuits = param_number(p, "circuits"; required=false, default=1.0, unit="", owner=owner)
    (isfinite(circuits) && circuits >= 1 && isinteger(circuits)) ||
        throw(contract_error("invalid_parameter", "circuits must be an integer >= 1",
                             detail="$(owner).circuits=$(circuits)"))
    n = Int(circuits)
    len_km > 0 ||
        throw(contract_error("invalid_parameter", "length must be positive",
                             detail="$(owner).length=$(len_km)"))
    r = r0 * len_km / n
    x = x0 * len_km / n
    (r == 0.0 && x == 0.0) &&
        throw(contract_error("zero_impedance", "line series impedance is zero",
                             detail="$(owner) r0=$(r0) x0=$(x0) length=$(len_km)"))
    y_series = 1.0 / ohm_to_pu(complex(r, x), base)
    y_charging = siemens_to_pu(complex(g0, b0) * len_km * n, base) / 2.0

    _check_line_levels(branch, buses, warnings)
    _check_line_symmetry(p, r0, x0, owner, warnings)
    n > 1 && push!(assumptions,
        "линия $(branch.component_id): учтено $(n) параллельных цепей " *
        "(сопротивление делится, проводимость наполнения умножается)")
    return BranchModel(branch.component_id, branch.code, branch.from_bus, branch.to_bus,
                       1.0, y_series, y_charging, y_charging, owner)
end

"""
    transformer_model(branch, buses, base, assumptions, warnings)

Двухобмоточный трансформатор. Последовательное сопротивление задаётся потерями
короткого замыкания на собственном базисе `S_nom`, `U_hv`:

    r_own = p_kz/S_nom
    x_own = sqrt((u_kz/100)^2 - r_own^2)
    z_own = r_own + j*x_own

и переносится в базис системы функцией `impedance_from_own_base`. Идеальный
коэффициент stamp `ratio = U_lv/U_hv` на общем базисе переносит уровень напряжения; ветвь
намагничивания `p_xx`, `i_xx` отнесена к обмотке ВН (упрощение, зафиксированное
в `assumptions`).
"""
function transformer_model(branch::Branch, buses::Dict{Int,Bus}, base::BaseSystem,
                           assumptions::Vector{String}, warnings::Vector{String})
    owner = "transformer#$(branch.component_id)"
    p = branch.params
    s_nom = param_number(p, "power_nom"; unit="MVA", owner=owner)
    u_hv = param_number(p, "voltage_hv"; unit="kV", owner=owner)
    u_lv = param_number(p, "voltage_lv"; unit="kV", owner=owner)
    p_kz = param_number(p, "p_kz"; unit="MW", owner=owner)
    u_kz = param_number(p, "u_kz"; unit="%", owner=owner)
    p_xx = param_number(p, "p_xx"; required=false, default=0.0, unit="MW", owner=owner)
    i_xx = param_number(p, "i_xx"; required=false, default=0.0, unit="%", owner=owner)
    s_nom > 0 || throw(contract_error("invalid_parameter", "power_nom must be positive",
                                      detail="$(owner).power_nom=$(s_nom)"))
    u_hv > 0 || throw(contract_error("invalid_parameter", "voltage_hv must be positive",
                                     detail="$(owner).voltage_hv=$(u_hv)"))
    u_lv > 0 || throw(contract_error("invalid_parameter", "voltage_lv must be positive",
                                     detail="$(owner).voltage_lv=$(u_lv)"))
    u_kz > 0 || throw(contract_error("invalid_parameter", "u_kz must be positive",
                                     detail="$(owner).u_kz=$(u_kz)"))
    r_own, z_abs = p_kz / s_nom, u_kz / 100.0
    (0 <= r_own <= z_abs) || throw(contract_error("invalid_parameter", "p_kz is inconsistent with u_kz", detail=owner))
    z_own = complex(r_own, sqrt(z_abs^2 - r_own^2))
    y_series = 1.0 / impedance_from_own_base(z_own, s_nom, u_hv, base)
    # One global voltage base: vi - vj / ratio = vi - (Uhv/Ulv)*vj.
    ratio = u_lv / u_hv
    y_from = 0.0 + 0.0im
    if p_xx == 0.0 && i_xx == 0.0
        push!(assumptions, "трансформатор $(branch.component_id): p_xx и i_xx не заданы, " *
                           "ветвь намагничивания не учитывается")
    else
        g_own, y_abs = p_xx / s_nom, i_xx / 100.0
        (0 <= g_own <= y_abs) || throw(contract_error("invalid_parameter", "p_xx is inconsistent with i_xx", detail=owner))
        y_from = admittance_from_own_base(complex(g_own, -sqrt(y_abs^2 - g_own^2)), s_nom, u_hv, base)
        push!(assumptions, "трансформатор $(branch.component_id): ветвь намагничивания " *
                           "(p_xx=$(p_xx) МВт, i_xx=$(i_xx) %) отнесена к обмотке ВН")
    end
    _check_transformer_levels(branch, buses, u_hv, u_lv, warnings)
    return BranchModel(branch.component_id, branch.code, branch.from_bus, branch.to_bus,
                       ratio, y_series, y_from, 0.0 + 0.0im, owner)
end

"""
    generator_model(inj, terminal, base, assumptions, warnings)

Источник как ЭДС `internal → terminal` за сопротивлением `r + jx`. Внутренний
узел несёт заданные `|E|` и `P`; напряжение шины генератора — результат расчёта.
"""
function generator_model(inj::Injection, terminal::Bus, base::BaseSystem,
                         assumptions::Vector{String}, warnings::Vector{String})
    owner = "generator#$(inj.component_id)"
    p = inj.params
    r = param_number(p, "r"; required=false, default=0.0, unit="Ohm", owner=owner)
    x = param_number(p, "x"; unit="Ohm", owner=owner)
    (r^2 + x^2) > 0.0 ||
        throw(contract_error("zero_impedance",
                             "generator series impedance must not be zero",
                             detail="$(owner) r=$(r) x=$(x)"))
    v_nom = param_number(p, "voltage_nom"; required=false, default=0.0,
                         unit="kV", owner=owner)
    if v_nom > 0 && terminal.v_nom_kv > 0
        rel = abs(terminal.v_nom_kv - v_nom) / v_nom
        rel > VOLTAGE_LEVEL_TOLERANCE &&
            push!(warnings, "генератор $(inj.component_id): номинал шины " *
                            "$(terminal.index) ($(terminal.v_nom_kv) кВ) не совпадает с " *
                            "номиналом генератора ($(v_nom) кВ)")
    elseif v_nom <= 0
        push!(assumptions, "генератор $(inj.component_id): voltage_nom не задан")
    end
    y_series = 1.0 / ohm_to_pu(complex(r, x), base)
    return BranchModel(inj.component_id, "generator", inj.bus, terminal.index,
                       1.0, y_series, 0.0 + 0.0im, 0.0 + 0.0im, owner)
end

"""
    shunt_model(inj, bus, base, assumptions)

Проводимость шунта: `B = (Q_nom/S_base)·(V_base/V_nom)²`, что обеспечивает
реактивную выдачу `Q_nom` при номинальном напряжении узла. Знак `B` соответствует
физическому смыслу `q_nom`: конденсатор выдаёт, реактор потребляет.
"""
function shunt_model(inj::Injection, bus::Bus, base::BaseSystem, assumptions::Vector{String})
    owner = "$(inj.code)#$(inj.component_id)"
    q_nom = inj.q_mvar
    if q_nom == 0.0
        push!(assumptions, "шунт $(owner): q_nom не задан, в проводимость не вносится")
        return ShuntModel(inj.component_id, inj.code, inj.bus, 0.0 + 0.0im, 0.0, owner)
    end
    bus.v_nom_kv > 0 ||
        throw(contract_error("missing_parameter",
                             "shunt requires the bus nominal voltage 'voltage_nom'",
                             detail="$(owner): node $(inj.bus) has no nominal voltage"))
    b_pu = (q_nom / base.s_base_mva) * (base.v_base_kv / bus.v_nom_kv)^2
    y_pu = inj.code == "capacitor" ? complex(0.0, b_pu) : complex(0.0, -b_pu)
    return ShuntModel(inj.component_id, inj.code, inj.bus, y_pu, q_nom, owner)
end

# --- сборка системы --------------------------------------------------------------

"""
    assemble_system(net, base)

Расширяет топологию внутренними узлами источников и строит модели элементов.
Остров без источника не имеет решаемого режима и отклоняется
(`island_without_source`).
"""
function assemble_system(net::CompiledNetwork, base::BaseSystem)
    assumptions = copy(net.assumptions)
    warnings = copy(net.warnings)
    buses = Bus[Bus(b.index, b.members, b.codes, b.v_nom_kv, b.v_nom_complete,
                    b.is_switch_only, b.island) for b in net.buses]
    index = Dict{Int,Bus}(b.index => b for b in buses)

    injections = Injection[]
    sources = Injection[]
    generator_branches = BranchModel[]
    for inj in net.injections
        inj.kind === :source || (push!(injections, inj); continue)
        terminal = inj.bus
        internal_index = length(buses) + 1
        v_nom, complete = generator_nominal(inj)
        push!(buses, Bus(internal_index, [inj.component_id], ["generator"], v_nom,
                         complete, false, 0))
        index[internal_index] = buses[end]
        internal = Injection(inj.component_id, inj.code, internal_index, :source, inj.p_mw,
                             inj.q_mvar, inj.params, inj.v_spec_kv, inj.has_v_spec,
                             inj.is_slack)
        push!(injections, internal)
        push!(sources, internal)
        push!(generator_branches,
              generator_model(internal, index[terminal], base, assumptions, warnings))
    end

    branch_models = BranchModel[]
    for branch in net.branches
        if branch.code == "transmission_line"
            push!(branch_models, line_model(branch, index, base, assumptions, warnings))
        elseif branch.code == "transformer"
            push!(branch_models, transformer_model(branch, index, base, assumptions, warnings))
        else
            throw(unsupported_error("unsupported_component",
                "component $(branch.component_id) of type '$(branch.code)' has no verified model",
                detail="supported series elements: transmission_line, transformer"))
        end
    end
    append!(branch_models, generator_branches)

    shunts = ShuntModel[]
    for inj in injections
        inj.kind === :shunt || continue
        push!(shunts, shunt_model(inj, index[inj.bus], base, assumptions))
    end

    island_of = islands_of(length(buses), branch_models)
    buses = [Bus(b.index, b.members, b.codes, b.v_nom_kv, b.v_nom_complete,
                 b.is_switch_only, island_of[b.index]) for b in buses]
    _check_islands(buses, injections, warnings)

    return AcSystem(buses, branch_models, shunts, injections, sources, assumptions, warnings)
end

"""Номинал уровня генератора для внутреннего узла ЭДС."""
function generator_nominal(inj::Injection)
    v = param_number(inj.params, "voltage_nom"; required=false, default=0.0,
                     unit="kV", owner="generator#$(inj.component_id)")
    return v, v > 0
end

"""
    source_spec(inj, base, assumptions)

Заданные модуль напряжения и угол узла источника: p.u. и радианы. Приоритет —
явная ЭДС `e`; при её отсутствии номинал `voltage_nom` с явной записью в
`assumptions`; при отсутствии обоих — ошибка контракта (напряжение PV-узла не
определено, подставлять его молча нельзя).
"""
function source_spec(inj::Injection, base::BaseSystem, assumptions::Vector{String})
    owner = "generator#$(inj.component_id)"
    v_kv = if inj.has_v_spec && inj.v_spec_kv > 0
        inj.v_spec_kv
    else
        v = param_number(inj.params, "voltage_nom"; required=false, default=nothing,
                         unit="kV", owner=owner)
        v === nothing &&
            throw(contract_error("missing_parameter",
                                 "PV/slack node voltage is not defined",
                                 detail="$(owner): set 'e' (EMF, kV) or 'voltage_nom'"))
        push!(assumptions, "генератор $(inj.component_id): напряжение узла принято равным " *
                           "номиналу voltage_nom ($(v) кВ), так как ЭДС 'e' не задана")
        v
    end
    angle_deg = param_number(inj.params, "angle"; required=false, default=0.0,
                             unit="deg", owner=owner)
    return kv_to_pu(v_kv, base), deg2rad(angle_deg)
end

"""Типы узлов: балансирующий, PV (заданные `P` и `|E|`), PQ (заданные `P`, `Q`)."""
struct BusClassification
    slack::Int
    slack_component::Int
    slack_v_pu::Float64
    slack_theta_rad::Float64
    pv::Vector{Int}
    pq::Vector{Int}
    pv_v_pu::Vector{Float64}
    pv_components::Vector{Int}
end

"""
    classify_buses(sys, base)

Балансирующий узел выбирается явно (`is_slack`/`slack`), иначе — единственным
источником с предупреждением; при нескольких источниках без явного указания
расчёт отклоняется (`ambiguous_slack`), поскольку распределение выдачи между ними
не определено. Остров без балансирующего узла отклоняется: абсолютный угол в
нём не задан, а результат зависит от выбора отсчёта.
"""
function classify_buses(sys::AcSystem, base::BaseSystem)
    isempty(sys.sources) &&
        throw(network_error("no_source",
            "Схема не содержит источника: установившийся режим не определён",
            detail="nodes=$(length(sys.buses))"))
    requested = [s for s in sys.sources if s.is_slack]
    if length(requested) > 1
        throw(network_error("multiple_slack",
            "Несколько генераторов помечены как балансирующие",
            detail="component_id=$(join([s.component_id for s in requested], ", "))"))
    elseif length(requested) == 1
        slack_source = requested[1]
    elseif length(sys.sources) == 1
        slack_source = sys.sources[1]
    else
        throw(network_error("ambiguous_slack",
            "В сети несколько источников, балансирующий узел не задан",
            detail="component_id=$(join([s.component_id for s in sys.sources], ", ")); " *
                   "укажите параметр is_slack у одного из генераторов"))
    end
    v_slack, theta_slack = source_spec(slack_source, base, sys.assumptions)
    pv = Int[]
    pv_v = Float64[]
    pv_components = Int[]
    for s in sys.sources
        s.bus == slack_source.bus && continue
        push!(pv, s.bus)
        push!(pv_components, s.component_id)
        v, _ = source_spec(s, base, sys.assumptions)
        push!(pv_v, v)
    end
    _check_islands_have_slack(sys, slack_source.bus)
    pv_set = Set(pv)
    pq = [b.index for b in sys.buses if b.index != slack_source.bus && !(b.index in pv_set)]
    return BusClassification(slack_source.bus, slack_source.component_id, v_slack,
                             theta_slack, pv, pq, pv_v, pv_components)
end

# --- острова и проверки геометрии схемы -----------------------------------------

"""Нумерация островов по ветвям: узлы без ветвей образуют остров из себя."""
function islands_of(nbus::Int, models::Vector{BranchModel})
    parent = collect(1:nbus)
    function find(x)
        parent[x] == x && return x
        return parent[x] = find(parent[x])
    end
    for m in models
        a, b = find(m.from_bus), find(m.to_bus)
        a == b || (parent[a] = b)
    end
    roots = sort(unique(find(i) for i in 1:nbus))
    rank = Dict(r => i for (i, r) in enumerate(roots))
    return Dict(i => rank[find(i)] for i in 1:nbus)
end

function _check_islands(buses::Vector{Bus}, injections::Vector{Injection},
                        warnings::Vector{String})
    with_source = Set{Int}()
    for inj in injections
        inj.kind === :source || continue
        push!(with_source, buses[inj.bus].island)
    end
    for (island, nodes) in sort(collect(_group_by_island(buses)); by=first)
        island in with_source && continue
        members = sort(unique([m for n in nodes for m in buses[n].members]))
        throw(network_error("island_without_source",
            "Остров $(island) не содержит источника: установившийся режим в нём не определён",
            detail="nodes=$(join(sort(nodes), ",")) component_id=$(join(members, ","))"))
    end
    return nothing
end

function _check_islands_have_slack(sys::AcSystem, slack::Int)
    slack_island = sys.buses[slack].island
    for (island, nodes) in sort(collect(_group_by_island(sys.buses)); by=first)
        island == slack_island && continue
        members = sort(unique([m for n in nodes for m in sys.buses[n].members]))
        throw(network_error("island_without_slack",
            "Остров $(island) не содержит балансирующего узла: отсчёт углов в нём не задан",
            detail="nodes=$(join(sort(nodes), ",")) component_id=$(join(members, ",")); " *
                   "раздельный расчёт островов — задача CORE-07/DYN"))
    end
    return nothing
end

function _group_by_island(buses::Vector{Bus})
    out = Dict{Int,Vector{Int}}()
    for b in buses
        push!(get!(out, b.island, Int[]), b.index)
    end
    return out
end

function _check_line_levels(branch::Branch, buses::Dict{Int,Bus}, warnings::Vector{String})
    from = buses[branch.from_bus]
    to = buses[branch.to_bus]
    (from.v_nom_kv > 0 && to.v_nom_kv > 0) || return nothing
    rel = abs(from.v_nom_kv - to.v_nom_kv) / max(from.v_nom_kv, to.v_nom_kv)
    rel > VOLTAGE_LEVEL_TOLERANCE &&
        throw(network_error("voltage_level_mismatch",
            "ЛЭП соединяет узлы разных уровней напряжения без согласующего элемента",
            detail="line=$(branch.component_id) node $(from.index)=$(from.v_nom_kv) kV " *
                   "node $(to.index)=$(to.v_nom_kv) kV " *
                   "tolerance=$(VOLTAGE_LEVEL_TOLERANCE)"))
    return nothing
end

function _check_transformer_levels(branch::Branch, buses::Dict{Int,Bus}, u_hv::Float64,
                                   u_lv::Float64, warnings::Vector{String})
    _check_level(buses[branch.from_bus], u_hv, "ВН", branch.component_id, warnings)
    _check_level(buses[branch.to_bus], u_lv, "НН", branch.component_id, warnings)
    return nothing
end

function _check_level(bus::Bus, u_nom::Float64, side::AbstractString, cid::Int,
                      warnings::Vector{String})
    bus.v_nom_kv <= 0 && return nothing
    abs(bus.v_nom_kv - u_nom) / u_nom > VOLTAGE_LEVEL_TOLERANCE || return nothing
    push!(warnings, "трансформатор $(cid): номинал узла $(bus.index) ($(bus.v_nom_kv) кВ) " *
                    "не совпадает с номиналом обмотки $(side) ($(u_nom) кВ)")
    return nothing
end

"""Сверка симметрии фазных параметров ЛЭП с удельными `r0`, `x0`."""
function _check_line_symmetry(p::Dict{String,String}, r0::Float64, x0::Float64,
                              owner::AbstractString, warnings::Vector{String})
    for (key, ref) in (("r_aa", r0), ("x_aa", x0), ("r_bb", r0), ("x_bb", x0),
                       ("r_cc", r0), ("x_cc", x0))
        haskey(p, key) || continue
        v = tryparse(Float64, strip(p[key]))
        (v === nothing || ref == 0.0) && continue
        abs(v - ref) / abs(ref) > LINE_SYMMETRY_TOLERANCE || continue
        push!(warnings, "$(owner): параметр $(key)=$(v) отличается от симметричного " *
                        "r0=$(r0)/x0=$(x0); симметричный AC-режим использует r0/x0, " *
                        "несимметричные фазы не учитываются")
        return nothing
    end
    return nothing
end

# --- потоки ветвей --------------------------------------------------------------

"""
    branch_flow(m::BranchModel, v, theta, base)

Потоки двухполюсного элемента в МВт/Мвар/кА: токи и мощности на обоих концах и
потери в последовательном сопротивлении. Считается независимо от Y-матрицы и
используется как сверка (см. регрессионные тесты).
"""
function branch_flow(m::BranchModel, v::Vector{Float64}, theta::Vector{Float64},
                     base::BaseSystem)
    i, j, t = m.from_bus, m.to_bus, m.ratio
    vi = complex(v[i], 0.0) * cis(theta[i])
    vj = complex(v[j], 0.0) * cis(theta[j])
    i_series_from = m.y_series * (vi - vj / t)
    i_series_to = (m.y_series / (t * t)) * vj - (m.y_series / t) * vi
    i_from = i_series_from + m.y_from * vi
    i_to = i_series_to + m.y_to * vj
    s_from = vi * conj(i_from)
    s_to = vj * conj(i_to)
    s_loss = s_from + s_to
    return (p_from_mw = pu_to_mva(real(s_from), base),
            q_from_mvar = pu_to_mva(imag(s_from), base),
            p_to_mw = pu_to_mva(real(s_to), base),
            q_to_mvar = pu_to_mva(imag(s_to), base),
            losses_p_mw = pu_to_mva(real(s_loss), base),
            losses_q_mvar = pu_to_mva(imag(s_loss), base),
            i_from_ka = pu_to_ka(abs(i_from), base),
            i_to_ka = pu_to_ka(abs(i_to), base))
end
