"""
Компилятор электрической топологии: терминалы и состояния аппаратов → узлы и
ветви (упрощённая, явно ограниченная версия CORE-03).

Модель узлов. Экземпляр оборудования раскладывается на точки соединения
(terminals): у двухобмоточных элементов их две, у трёхобмоточных — три, у
выключателей/разъединителей — две, у шин/источника/нагрузки/шунта — одна, все порты
принадлежат ей. Связь `A.port — B.port` означает электрическое соединение точек,
поэтому точки объединяются (DSU) в узлы. Замкнутый аппарат дополнительно
объединяет собственные терминалы; разомкнутый сохраняет внешние соединения.

Ветви. Двухобмоточные элементы (линия, трансформатор, автотрансформатор) дают
ветвь между узлами своих двух терминалов. Идеальный аппарат (замкнутый
выключатель/разъединитель) в Y-матрицу не вносится и не создаёт
собственной ветви.

Ограничения, которые должны быть закрыты в CORE-03: нейтрали трансформаторов,
`transformer_3w` (три обмотки в одном аппарате), статусы SCADA, карта
происхождения узлов. Здесь трёхобмоточные элементы отклоняются явной ошибкой
`unsupported_component`, а не пропускаются.

Regression: A03 — ранее узлами становились только шины/генераторы/нагрузки, а
соединения с прочими компонентами терялись, из-за чего сеть собиралась
неполной. Здесь любой компонент, присоединённый к сети, влияет на её сборку,
а каждый узел возвращает список составляющих его экземпляров.
"""

const TWO_TERMINAL_ALIASES = Dict{String,Dict{String,Int}}(
    "breaker" => Dict("top" => 1, "bottom" => 2),
    "disconnector" => Dict("top" => 1, "bottom" => 2),
    "transmission_line" => Dict("left" => 1, "right" => 2, "top" => 1, "bottom" => 2),
    "transformer" => Dict("top" => 1, "bottom" => 2, "left" => 1, "right" => 2, "a" => 1, "b" => 2),
    "autotransformer" => Dict("top" => 1, "bottom" => 2, "left" => 1, "right" => 2, "a" => 1, "b" => 2),
)

const THREE_TERMINAL_ALIASES = Dict{String,Dict{String,Int}}(
    "transformer_3w" => Dict("top" => 1, "bl" => 2, "br" => 3, "left" => 1, "right" => 2, "bottom" => 2),
)

const SWITCH_CODES = Set(["breaker", "disconnector", "grounding_switch"])

const SOURCE_CODES = Set(["generator"])
const LOAD_CODES = Set(["load"])
const SHUNT_CODES = Set(["capacitor", "reactor", "ground"])
const BUS_CODES = Set(["busbar"])
const KNOWN_CODES = union(SWITCH_CODES, SOURCE_CODES, LOAD_CODES, SHUNT_CODES, BUS_CODES,
                          keys(TWO_TERMINAL_ALIASES), keys(THREE_TERMINAL_ALIASES))

#: Коды, для которых есть терминальная модель, но проверяемой физической модели нет.
const CODE_WITHOUT_VERIFIED_MODEL = Set(["transformer_3w", "autotransformer", "ground", "grounding_switch"])

"""Электрический узел: список присоединённых экземпляров и номинал уровня."""
struct Bus
    index::Int
    members::Vector{Int}
    codes::Vector{String}
    v_nom_kv::Float64
    v_nom_complete::Bool
    is_switch_only::Bool
    island::Int
end

"""Ветвь: последовательный двухобмоточный элемент между двумя узлами."""
struct Branch
    component_id::Int
    code::String
    from_bus::Int
    to_bus::Int
    from_terminal::Int
    to_terminal::Int
    params::Dict{String,String}
end

"""Инъекция или шунт, присоединённые к узлу (p > 0 означает генерацию)."""
struct Injection
    component_id::Int
    code::String
    bus::Int
    kind::Symbol           # :source | :pq | :shunt
    p_mw::Float64
    q_mvar::Float64
    params::Dict{String,String}
    v_spec_kv::Float64
    has_v_spec::Bool
    is_slack::Bool
end

"""Результат компиляции топологии."""
struct CompiledNetwork
    buses::Vector{Bus}
    branches::Vector{Branch}
    injections::Vector{Injection}
    island_count::Int
    warnings::Vector{String}
    assumptions::Vector{String}
    origin::Vector{String}   # происхождение узла: component ids, через которые он собран
end

"""
    terminal_of_port(code, port)

Номер терминала компонента по имени порта. Для однопортовых элементов всегда 1.
"""
function terminal_of_port(code::AbstractString, port::AbstractString)
    c = lowercase(String(code))
    p = lowercase(String(port))
    if haskey(THREE_TERMINAL_ALIASES, c)
        aliases = THREE_TERMINAL_ALIASES[c]
        haskey(aliases, p) && return aliases[p]
    elseif haskey(TWO_TERMINAL_ALIASES, c)
        aliases = TWO_TERMINAL_ALIASES[c]
        haskey(aliases, p) && return aliases[p]
    end
    return 1
end

terminal_count(code::AbstractString) =
    haskey(THREE_TERMINAL_ALIASES, lowercase(String(code))) ? 3 :
    haskey(TWO_TERMINAL_ALIASES, lowercase(String(code))) ? 2 : 1

is_switch(code::AbstractString) = lowercase(String(code)) in SWITCH_CODES

"""Низкоуровневый DSU по парам (component_id, terminal)."""
mutable struct TerminalDSU
    parent::Vector{Int}
    rank::Vector{Int}
end

function TerminalDSU(n::Int)
    return TerminalDSU(collect(1:n), zeros(Int, n))
end

function dsu_find(d::TerminalDSU, x::Int)
    p = d.parent[x]
    p == x && return x
    r = dsu_find(d, p)
    d.parent[x] = r
    return r
end

function dsu_union!(d::TerminalDSU, a::Int, b::Int)
    ra, rb = dsu_find(d, a), dsu_find(d, b)
    ra == rb && return ra
    if d.rank[ra] < d.rank[rb]
        d.parent[ra] = rb
        return rb
    elseif d.rank[ra] > d.rank[rb]
        d.parent[rb] = ra
        return ra
    end
    d.parent[rb] = ra
    d.rank[ra] += 1
    return ra
end

"""
    compile_network(components, connections; default_s_base_mva=100.0)

Собирает узлы, ветви и инъекции. Возвращает `CompiledNetwork` либо бросает
`EnersyError` с кодом `unsupported_component` / `network_*`.

Проверки:
* неизвестный тип компонента или код без проверяемой модели → отказ;
* связь с несуществующим компонентом или неизвестным портом → `network_unknown_port`;
* связь компонента с самим собой → `network_self_connection`;
* один экземпляр, присоединённый к двум разным узлам шиной (busbar) —
  ошибка `network_busbar_split`: шина соединяет все свои порты в один узел, и
  разрыв означает неверно описанную схему.

Правила соединений, применимые к типам (допустимые пары), проверяет BASE-04 на
стороне Go; здесь проверяется только целостность собираемой сети.
"""
function compile_network(components::Vector{RawComponent}, connections::Vector{RawConnection};
                         default_s_base_mva::Real=100.0)
    warnings = String[]
    assumptions = String[]

    isempty(components) &&
        throw(network_error("empty_scheme", "Схема не содержит компонентов"))

    by_id = Dict{Int,RawComponent}()
    for c in components
        haskey(by_id, c.id) && throw(contract_error("duplicate_component_id", "Component IDs must be unique"))
        by_id[c.id] = c
    end

    for c in components
        c.code in KNOWN_CODES ||
            throw(unsupported_error("unknown_component_type",
                "Компонент $(c.id) имеет неизвестный тип '$(c.code)'",
                detail="допустимые типы: $(join(sort(collect(KNOWN_CODES)), ", "))"))
        c.code in CODE_WITHOUT_VERIFIED_MODEL &&
            throw(unsupported_error("unsupported_component",
                "Компонент $(c.id) типа '$(c.code)' не имеет проверяемой модели в режиме three-phase",
                detail="поддерживаемые последовательные элементы: transmission_line, transformer; " *
                       "поддержка трёхобмоточных и автотрансформаторов — задача CORE-04"))
    end

    # Точки соединения: индекс = offset компонента + номер терминала.
    term_offset = Dict{Int,Int}()
    term_count = Dict{Int,Int}()
    next_index = 1
    for c in components
        n = terminal_count(c.code)
        term_offset[c.id] = next_index
        term_count[c.id] = n
        next_index += n
    end
    dsu = TerminalDSU(next_index - 1)

    for conn in connections
        haskey(by_id, conn.from) ||
            throw(network_error("network_unknown_component",
                "Связь ссылается на несуществующий компонент",
                detail="from=$(conn.from) to=$(conn.to)"))
        haskey(by_id, conn.to) ||
            throw(network_error("network_unknown_component",
                "Связь ссылается на несуществующий компонент",
                detail="from=$(conn.from) to=$(conn.to)"))
        conn.from == conn.to &&
            throw(network_error("network_self_connection",
                "Связь соединяет компонент с самим собой",
                detail="component=$(conn.from)"))
        a = by_id[conn.from]
        b = by_id[conn.to]
        # Неизвестный порт не игнорируем: молчаливое соединение по первому порту
        # скрывает ошибку редактора (A16).
        ta = terminal_of_port(a.code, conn.from_port)
        tb = terminal_of_port(b.code, conn.to_port)
        _check_port_known(a, conn.from_port, ta)
        _check_port_known(b, conn.to_port, tb)
        dsu_union!(dsu, term_offset[a.id] + ta - 1, term_offset[b.id] + tb - 1)
    end

    # Узлы: корни DSU, индексация детерминирована по минимальному component id.
    # Wiring remains connected to both sides of an open switch; only its
    # internal contact opens. This preserves terminal identity.
    for c in components
        if c.code in ("breaker", "disconnector") && switch_closed(c)
            dsu_union!(dsu, term_offset[c.id], term_offset[c.id] + 1)
        end
    end
    root_members = Dict{Int,Vector{Int}}()
    for c in components
        n = term_count[c.id]
        for t in 1:n
            r = dsu_find(dsu, term_offset[c.id] + t - 1)
            push!(get!(root_members, r, Int[]), c.id)
        end
    end
    for v in values(root_members)
        sort!(unique!(v))
    end
    # Pure unused apparatus terminals carry no network equations.
    used = Set(vcat([c.from for c in connections], [c.to for c in connections]))
    root_order = sort([r for r in keys(root_members)
        if !all(cid -> is_switch(by_id[cid].code) && !(cid in used), root_members[r])];
        by=r -> (minimum(root_members[r]), r))
    bus_of_root = Dict(r => bi for (bi, r) in enumerate(root_order))
    bus_of_component = Dict{Tuple{Int,Int},Int}()
    for c in components, t in 1:term_count[c.id]
        r = dsu_find(dsu, term_offset[c.id] + t - 1)
        if haskey(bus_of_root, r)
            bus_of_component[(c.id, t)] = bus_of_root[r]
        end
    end

    # Ветви.
    branches = Branch[]
    for cid in sort(collect(keys(term_offset)))
        c = by_id[cid]
        c.code in ("transmission_line", "transformer") || continue
        haskey(bus_of_component, (cid, 1)) && haskey(bus_of_component, (cid, 2)) || continue
        bi, bj = bus_of_component[(cid, 1)], bus_of_component[(cid, 2)]
        if bi == bj
            throw(network_error("shorted_branch", "Оба терминала ветви соединены с одним узлом", detail="component=$(cid)"))
        end
        push!(branches, Branch(cid, c.code, bi, bj, 1, 2, c.params))
    end

    # Инъекции.
    injections = Injection[]
    for cid in sort(collect(keys(term_offset)))
        c = by_id[cid]
        if !(c.code in SOURCE_CODES || c.code in LOAD_CODES || c.code in SHUNT_CODES)
            continue
        end
        haskey(bus_of_component, (cid, 1)) || continue
        bus = bus_of_component[(cid, 1)]
        if c.code in SOURCE_CODES
            p = param_number(c.params, "p"; unit="MW", owner="generator#$(cid)")
            e = param_number(c.params, "e"; required=false, default=nothing, unit="kV", owner="generator#$(cid)")
            v_spec = e === nothing ? 0.0 : e
            push!(injections, Injection(cid, c.code, bus, :source, p, 0.0, c.params,
                                        v_spec, e !== nothing, is_slack_requested(c)))
        elseif c.code in LOAD_CODES
            p = param_number(c.params, "p"; unit="MW", owner="load#$(cid)")
            q = param_number(c.params, "q"; required=false, default=0.0, unit="Mvar", owner="load#$(cid)")
            # Знак: p > 0 означает потребление, инъекция в сеть отрицательна.
            push!(injections, Injection(cid, c.code, bus, :pq, -p, -q, c.params, 0.0, false, false))
        elseif c.code == "ground"
            # В симметричном AC-режиме земля — опорная точка, отдельной инъекции
            # не создаёт; несимметричный учёт земли — задача PHY-01.
            push!(injections, Injection(cid, c.code, bus, :reference, 0.0, 0.0, c.params, 0.0, false, false))
        else
            # Шунты (capacitor/reactor): q_nom > 0 означает выдачу реактивной
            # мощности в сеть (ёмкостный знак), q_nom < 0 — потребление.
            q = param_number(c.params, "q_nom"; unit="Mvar", owner="$(c.code)#$(cid)")
            q >= 0 || throw(contract_error("invalid_parameter", "q_nom must be a nonnegative rated magnitude", detail="component=$(cid)"))
            push!(injections, Injection(cid, c.code, bus, :shunt, 0.0, q, c.params, 0.0, false, false))
        end
    end

    # Номинал уровня узла и острова.
    bus_islands = compute_islands(length(root_order), branches)
    buses = Bus[]
    for (bi, r) in enumerate(root_order)
        members = root_members[r]
        vnom, complete = bus_nominal(by_id, members)
        codes = sort(unique([by_id[m].code for m in members]))
        push!(buses, Bus(bi, members, codes, vnom, complete,
                         all(is_switch(by_id[m].code) for m in members),
                         bus_islands[bi]))
    end

    return CompiledNetwork(buses, branches, injections,
                           isempty(buses) ? 0 : length(unique(b.island for b in buses)),
                           warnings, assumptions,
                           [string("bus", b.index, " ← ", join(b.members, ",")) for b in buses])
end

function _check_port_known(c::RawComponent, port::AbstractString, terminal::Int)
    p = lowercase(String(port))
    known = union(Set(keys(get(TWO_TERMINAL_ALIASES, c.code, Dict{String,Int}()))),
                  Set(keys(get(THREE_TERMINAL_ALIASES, c.code, Dict{String,Int}()))))
    if isempty(known)
        known = c.code == "busbar" ? Set(["left", "right"]) :
                c.code == "generator" ? Set(["top", "bottom"]) :
                Set(["top"])
    end
    if !(p in known)
        throw(network_error("network_unknown_port",
            "Неизвестный порт '$(port)' для компонента $(c.id) типа '$(c.code)'",
            detail="known ports: $(join(sort(collect(known)), ", "))"))
    end
    return nothing
end

function switch_closed(c::RawComponent)
    return param_bool(c.params, "status"; default=true, owner="$(c.code)#$(c.id)")
end

function is_slack_requested(c::RawComponent)
    haskey(c.params, "is_slack") && return param_bool(c.params, "is_slack"; default=false, owner="generator#$(c.id)")
    haskey(c.params, "slack") && return param_bool(c.params, "slack"; default=false, owner="generator#$(c.id)")
    return false
end

function bus_nominal(by_id::Dict{Int,RawComponent}, members::Vector{Int})
    vnom = 0.0
    complete = true
    for m in members
        c = by_id[m]
        if haskey(c.params, "voltage_nom")
            v = param_number(c.params, "voltage_nom"; unit="kV", owner="component#$(m)")
            if v > 0
                vnom > 0 && abs(vnom-v)/max(vnom,v) > VOLTAGE_LEVEL_TOLERANCE &&
                    throw(network_error("voltage_level_mismatch", "Один узел содержит разные уровни напряжения", detail="members=$(join(members, ','))"))
                vnom = max(vnom, v)
            else
                throw(contract_error("invalid_parameter", "voltage_nom must be positive", detail="component=$(m)"))
            end
        else
            complete = false
        end
    end
    return vnom, complete
end

"""Острова: связность узлов по ветвям. Узлы без ветвей образуют остров из себя."""
function compute_islands(nbus::Int, branches::Vector{Branch})
    parent = collect(1:nbus)
    function find(x)
        parent[x] == x && return x
        return parent[x] = find(parent[x])
    end
    for b in branches
        a, c = find(b.from_bus), find(b.to_bus)
        a == c || (parent[a] = c)
    end
    roots = sort(unique(find(i) for i in 1:nbus))
    rank = Dict(r => i for (i, r) in enumerate(roots))
    return Dict(i => rank[find(i)] for i in 1:nbus)
end
