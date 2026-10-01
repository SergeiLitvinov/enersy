"""
    calculate(components, connections; model_group, method, base, options, ...)

Точка входа расчёта установившегося режима. Возвращает словарь ответа,
совместимый с существующим UI, и дополнительные поля, без которых результат
нельзя интерпретировать (базис, единицы, реестровый статус режима, потоки
ветвей, выдача источников, баланс мощности).

Порядок стадий важен: контракт проверяется реестром возможностей и DTO до
сборки сети, топология — до моделей, модели — до численного метода. Поэтому
ошибка всегда указывает на конкретную стадию, а не на «расчёт не сошёлся».
"""
function calculate(components::Vector{RawComponent}, connections::Vector{RawConnection};
                   model_group::AbstractString="three-phase",
                   method::AbstractString="newton-raphson",
                   base::Union{Nothing,BaseSystem}=nothing,
                   options::SolverOptions=SolverOptions(),
                   default_s_base_mva::Real=100.0)
    started_ns = time_ns()

    # 1. Реестр возможностей: неподдерживаемый режим отклоняется до расчёта (A09).
    entry = require_supported(model_group, method)

    # 2. Базис: явный или выведенный из номинальных напряжений схемы.
    sys_base = base === nothing ? derive_base(components, default_s_base_mva) : base

    # 3. Топология → модели элементов → типы узлов.
    net = compile_network(components, connections; default_s_base_mva=default_s_base_mva)
    sys = assemble_system(net, sys_base)
    cls = classify_buses(sys, sys_base)
    setup = power_flow_setup(sys, cls, sys_base)

    # 4. Y-матрица и численный метод.
    Y = build_admittance(sys)
    push!(sys.assumptions,
        "начальное приближение метода Ньютона–Рафсона: |V| = voltage_nom / V_base для PQ-узлов (1 p.u. при отсутствии номинала), " *
        "θ = θ_балансирующего")
    initial_v = [b.v_nom_kv > 0 ? kv_to_pu(b.v_nom_kv, sys_base) : 1.0 for b in sys.buses]
    result = newton_raphson(Y, setup, options; initial_v=initial_v)

    elapsed_ms = (time_ns() - started_ns) / 1e6
    return result_dict(sys, cls, result, setup, options, entry, sys_base,
                       model_group, method, elapsed_ms)
end

"""
    power_flow_setup(sys, cls, base)

Спецификации режима в p.u. Заданные мощности берутся из инъекций: PV-узлы
получают `P` источника (внутренний узел ЭДС), PQ-узлы — сумму `P`/`Q` нагрузок и
прочих PQ-инъекций узла. Шунты в спецификацию не входят: они учтены в
Y-матрице и не являются неизвестными.
"""
function power_flow_setup(sys::AcSystem, cls::BusClassification, base::BaseSystem)
    source_at_bus = Dict{Int,Injection}(s.bus => s for s in sys.sources)
    p_pv = Float64[]
    pv_v = Float64[]
    for bus in cls.pv
        src = get(source_at_bus, bus, nothing)
        src === nothing &&
            throw(internal_error("inconsistent_setup",
                "PV bus has no source specification",
                detail="bus=$(bus)"))
        push!(p_pv, mva_to_pu(src.p_mw, base))
        push!(pv_v, source_spec(src, base, sys.assumptions)[1])
    end
    p_pq_by_bus = Dict{Int,Float64}()
    q_pq_by_bus = Dict{Int,Float64}()
    for inj in sys.injections
        inj.kind === :pq || continue
        p_pq_by_bus[inj.bus] = get(p_pq_by_bus, inj.bus, 0.0) + mva_to_pu(inj.p_mw, base)
        q_pq_by_bus[inj.bus] = get(q_pq_by_bus, inj.bus, 0.0) + mva_to_pu(inj.q_mvar, base)
    end
    p_pq = Float64[]
    q_pq = Float64[]
    for bus in cls.pq
        push!(p_pq, get(p_pq_by_bus, bus, 0.0))
        push!(q_pq, get(q_pq_by_bus, bus, 0.0))
    end
    return PowerFlowSetup(length(sys.buses), cls.slack, cls.slack_v_pu,
                          cls.slack_theta_rad, cls.pv, cls.pq, pv_v, p_pv, p_pq, q_pq)
end

"""Y-матрица в p.u.: ветви (включая ветви источников) и шунты."""
function build_admittance(sys::AcSystem)
    n = length(sys.buses)
    Y = zeros(ComplexF64, n, n)
    for m in sys.branch_models
        stamp!(Y, m)
    end
    for s in sys.shunts
        stamp!(Y, s)
    end
    return Y
end

# --- формирование ответа ---------------------------------------------------------

function node_type_of(bus_index::Int, cls::BusClassification)
    bus_index == cls.slack && return "slack"
    bus_index in cls.pv && return "pv"
    return "pq"
end

"""
    node_dict(bus, cls, result, base, source_buses)

Узел в ответе. `voltage` — линейное действующее напряжение в кВ, `angle` — в
градусах; `phase`/`quadrature` — прямоугольные составляющие того же напряжения
в кВ (модуль вектора `phase + j·quadrature` равен `voltage`), а не фаза и
отдача, как подразумевают прежние названия полей.
"""
function node_dict(bus::Bus, cls::BusClassification, result::PowerFlowResult,
                   base::BaseSystem, source_buses::Set{Int})
    i = bus.index
    v_kv = pu_to_kv(result.v[i], base)
    theta_deg = rad2deg(result.theta[i])
    v_complex = result.voltages[i] * base.v_base_kv
    return Dict{String,Any}(
        "node_id" => i,
        "node_type" => node_type_of(i, cls),
        "voltage" => v_kv,
        "angle" => theta_deg,
        "phase" => real(v_complex),
        "quadrature" => imag(v_complex),
        "voltage_pu" => result.v[i],
        "angle_rad" => result.theta[i],
        "p_mw" => pu_to_mva(result.p[i], base),
        "q_mvar" => pu_to_mva(result.q[i], base),
        "v_nom_kv" => bus.v_nom_kv,
        "v_nom_complete" => bus.v_nom_complete,
        "is_internal_source_node" => i in source_buses,
        "is_switch_only" => bus.is_switch_only,
        "island" => bus.island,
        "members" => bus.members,
        "codes" => bus.codes,
    )
end

function branch_dict(m::BranchModel, result::PowerFlowResult, base::BaseSystem)
    f = branch_flow(m, result.v, result.theta, base)
    return Dict{String,Any}(
        "component_id" => m.component_id,
        "code" => m.code,
        "from_bus" => m.from_bus,
        "to_bus" => m.to_bus,
        "ratio" => m.ratio,
        "p_from_mw" => f.p_from_mw,
        "q_from_mvar" => f.q_from_mvar,
        "p_to_mw" => f.p_to_mw,
        "q_to_mvar" => f.q_to_mvar,
        "losses_p_mw" => f.losses_p_mw,
        "losses_q_mvar" => f.losses_q_mvar,
        "i_from_ka" => f.i_from_ka,
        "i_to_ka" => f.i_to_ka,
    )
end

function source_dict(s::Injection, terminal::Int, result::PowerFlowResult,
                     base::BaseSystem, is_slack::Bool)
    return Dict{String,Any}(
        "component_id" => s.component_id,
        "code" => s.code,
        "type" => is_slack ? "slack" : "pv",
        "internal_bus" => s.bus,
        "terminal_bus" => terminal,
        "p_mw" => pu_to_mva(result.p[s.bus], base),
        "q_mvar" => pu_to_mva(result.q[s.bus], base),
        "terminal_voltage_kv" => pu_to_kv(result.v[terminal], base),
        "terminal_angle_deg" => rad2deg(result.theta[terminal]),
        "q_limits_applied" => false,
    )
end

"""Мощность, потребляемая шунтом при расчётном напряжении (МВт/Мвар)."""
function shunt_dict(s::ShuntModel, result::PowerFlowResult, base::BaseSystem)
    v_pu = result.v[s.bus]
    p_mw = pu_to_mva(v_pu^2 * real(s.y_pu), base)
    q_mvar = -pu_to_mva(v_pu^2 * imag(s.y_pu), base)
    return Dict{String,Any}(
        "component_id" => s.component_id,
        "code" => s.code,
        "bus" => s.bus,
        "q_nom_mvar" => s.q_nom_mvar,
        "p_mw" => p_mw,
        "q_mvar" => q_mvar,
    )
end

"""
    balance_report(sys, result, base, base_tolerance)

Баланс активной и реактивной мощности: выдача источников минус потребление
нагрузок, минус потери в ветвях, минус потребление шунтами. Остаток должен быть
близок к нулю; его величина возвращается в ответе как независимая проверка
сборки Y-матрицы и невязок.
"""
function balance_report(sys::AcSystem, result::PowerFlowResult, base::BaseSystem)
    gen_p = 0.0
    gen_q = 0.0
    for s in sys.sources
        gen_p += pu_to_mva(result.p[s.bus], base)
        gen_q += pu_to_mva(result.q[s.bus], base)
    end
    load_p = 0.0
    load_q = 0.0
    for inj in sys.injections
        inj.kind === :pq || continue
        load_p += inj.p_mw
        load_q += inj.q_mvar
    end
    losses_p = 0.0
    losses_q = 0.0
    for m in sys.branch_models
        f = branch_flow(m, result.v, result.theta, base)
        losses_p += f.losses_p_mw
        losses_q += f.losses_q_mvar
    end
    shunt_p = 0.0
    shunt_q = 0.0
    for s in sys.shunts
        v_pu = result.v[s.bus]
        shunt_p += pu_to_mva(v_pu^2 * real(s.y_pu), base)
        shunt_q -= pu_to_mva(v_pu^2 * imag(s.y_pu), base)
    end
    residual_p = gen_p + load_p - losses_p - shunt_p
    residual_q = gen_q + load_q - losses_q - shunt_q
    return Dict{String,Any}(
        "generation_p_mw" => gen_p,
        "generation_q_mvar" => gen_q,
        "load_p_mw" => load_p,
        "load_q_mvar" => load_q,
        "branch_losses_p_mw" => losses_p,
        "branch_losses_q_mvar" => losses_q,
        "shunt_p_mw" => shunt_p,
        "shunt_q_mvar" => shunt_q,
        "residual_p_mw" => residual_p,
        "residual_q_mvar" => residual_q,
    )
end

function result_dict(sys::AcSystem, cls::BusClassification,
                     result::PowerFlowResult, setup::PowerFlowSetup,
                     options::SolverOptions, entry::CapabilityEntry,
                     base::BaseSystem, model_group::AbstractString,
                     method::AbstractString, elapsed_ms::Float64)
    source_buses = Set{Int}(s.bus for s in sys.sources)
    terminal_of_source = Dict{Int,Int}(m.from_bus => m.to_bus for m in sys.branch_models
                                      if m.code == "generator")
    nodes = [node_dict(b, cls, result, base, source_buses)
             for b in sort(sys.buses; by=x -> x.index)]
    sources = [source_dict(s, get(terminal_of_source, s.bus, s.bus), result, base,
                           s.bus == cls.slack) for s in sys.sources]
    return Dict{String,Any}(
        "success" => true,
        "method_used" => string(entry.model_group, "/", entry.method),
        "method_group" => model_group,
        "method" => method,
        "capability" => entry_json(entry),
        "base" => base_json(base),
        "units" => UNIT_CONVENTION,
        "node_count" => length(nodes),
        "nodes" => nodes,
        "iterations" => result.iterations,
        "max_mismatch_pu" => result.max_mismatch,
        "computation_time_ms" => elapsed_ms,
        "solver" => Dict{String,Any}(
            "method" => "newton-raphson",
            "coordinates" => "polar",
            "equations" => number_of_equations(setup),
            "unknowns" => number_of_equations(setup),
            "tolerance_pu" => options.tolerance,
            "max_iterations" => options.max_iterations,
            "buses" => length(sys.buses),
            "branches" => length(sys.branch_models),
            "shunts" => length(sys.shunts),
            "slack_bus" => cls.slack,
            "slack_component" => cls.slack_component,
            "pv_buses" => cls.pv,
            "pq_buses" => cls.pq,
            "islands" => length(unique(b.island for b in sys.buses)),
        ),
        "branches" => [branch_dict(m, result, base) for m in sys.branch_models],
        "sources" => sources,
        "shunts" => [shunt_dict(s, result, base) for s in sys.shunts],
        "balance" => balance_report(sys, result, base),
        "warnings" => sys.warnings,
        "assumptions" => sys.assumptions,
        "version" => VERSION,
    )
end
