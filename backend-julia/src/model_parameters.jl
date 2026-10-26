"""Parameter documentation for the current legacy AC implementations.
This contract describes inputs; numerical validation remains in the compiler/model.
No catalogue defaults are copied into equipment or treated as confirmed values.
"""
function model_parameters(code::AbstractString)
    parameter(key, name, unit, requirement, note; kind="number", default=nothing) = Dict(
        "key" => key, "name" => name, "unit" => unit, "kind" => kind,
        "requirement" => requirement, "default_value" => default, "note" => note)
    if code == "generator"
        return [
            parameter("p", "Активная мощность", "MW", "required", "Положительная мощность — выдача в сеть; балансирующий источник определяет P по балансу."),
            parameter("r", "Последовательное сопротивление", "Ohm", "optional", "На фазу; r ≥ 0; r и x не могут быть одновременно нулевыми."; default="0"),
            parameter("x", "Последовательная реактивность", "Ohm", "required", "На фазу; r и x не могут быть одновременно нулевыми."),
            parameter("e", "Модуль внутренней ЭДС", "kV", "conditional", "Линейное RMS > 0. При отсутствии используется voltage_nom с записью допущения."),
            parameter("voltage_nom", "Номинальное напряжение", "kV", "conditional", "Линейное RMS > 0. Нужно при отсутствии e; участвует в выборе базиса и проверке уровней напряжения."),
            parameter("angle", "Угол внутренней ЭДС", "deg", "optional", "Уставка угла опорного источника; у PV угол получается из решения."; default="0"),
            parameter("is_slack", "Запрос опорного источника", "1", "optional", "Без явного выбора единственный источник острова выбирается автоматически; несколько источников требуют явного выбора."; kind="boolean", default="false"),
            parameter("slack", "Legacy-алиас запроса опорного источника", "1", "optional", "Используется только при отсутствии ключа is_slack."; kind="boolean", default="false"),
            parameter("q_min_emf_mvar", "Минимум Q внутренней ЭДС", "Mvar", "conditional", "Задаётся вместе с q_max_emf_mvar, минимум ≤ максимум. Это граница внутреннего узла, не терминала машины."),
            parameter("q_max_emf_mvar", "Максимум Q внутренней ЭДС", "Mvar", "conditional", "Задаётся вместе с q_min_emf_mvar; ограничения могут переводить PV в PQ. Нарушенная граница slack даёт ошибку."),
        ]
    elseif code == "transformer"
        return [
            parameter("power_nom", "Номинальная мощность", "MVA", "required", "Полная трёхфазная > 0; собственный базис паспортных испытаний."),
            parameter("voltage_hv", "Напряжение обмотки ВН", "kV", "required", "Линейное RMS > 0; терминал T1 (top/left/a)."),
            parameter("voltage_lv", "Напряжение обмотки НН", "kV", "required", "Линейное RMS > 0; терминал T2 (bottom/right/b). Коэффициент k=Uнн/Uвн на общем базисе."),
            parameter("p_kz", "Потери короткого замыкания", "MW", "required", "Полная трёхфазная неотрицательная мощность; p_kz/power_nom ≤ u_kz/100. Ввод в МВт, не в кВт."),
            parameter("u_kz", "Напряжение короткого замыкания", "%", "required", "> 0; модуль последовательного импеданса на собственном базисе."),
            parameter("p_xx", "Потери холостого хода", "MW", "optional", "Полная трёхфазная неотрицательная мощность; p_xx/power_nom ≤ i_xx/100. Ввод в МВт, не в кВт. Ветвь отнесена к стороне ВН."; default="0"),
            parameter("i_xx", "Ток холостого хода", "%", "optional", "Неотрицательный модуль проводимости на собственном базисе. Ненулевой p_xx требует достаточного i_xx; при обоих нулях ветвь намагничивания не учитывается."; default="0"),
            parameter("phase_shift_deg", "Фазосдвиг НН относительно ВН", "deg", "optional", "[-180,180]; положительный угол означает опережение НН относительно ВН на холостом ходу. При отсутствии принят 0° с записью допущения. Не выводится из группы соединения; не задаёт нейтраль или нулевую последовательность."; default="0"),
        ]
    elseif code == "transmission_line"
        inputs = [
            parameter("length", "Длина", "km", "required", "Должна быть больше нуля."),
            parameter("r0", "Удельное активное сопротивление", "Ohm/km", "required", "На фазу, неотрицательное; r0 и x0 не могут быть одновременно нулевыми."),
            parameter("x0", "Удельная реактивность", "Ohm/km", "required", "На фазу; r0 и x0 не могут быть одновременно нулевыми."),
            parameter("g0", "Удельная активная проводимость", "S/km", "optional", "На фазу, неотрицательная; суммарная проводимость делится между концами."; default="0"),
            parameter("b0", "Удельная реактивная проводимость", "S/km", "optional", "На фазу; суммарная проводимость делится между концами."; default="0"),
            parameter("circuits", "Число параллельных цепей", "1", "optional", "Целое ≥ 1; сопротивление делится, проводимость наполнения умножается на число цепей."; kind="integer", default="1"),
            parameter("voltage_nom", "Номинальное напряжение", "kV", "optional", "Линейное RMS > 0; относится к уровню сети и базису, а не к Z линии."),
        ]
        for phase in ("aa", "bb", "cc"), prefix in ("r", "x")
            push!(inputs, parameter(prefix * "_" * phase, "Фазный параметр " * uppercase(prefix) * " " * uppercase(phase), "Ohm/km", "optional", "Конечное число; собственное R неотрицательно. Только сверка с r0/x0 с порогом 1%; при нулевом r0/x0 любое ненулевое отличие даёт предупреждение. В π-модели используются r0 и x0, не фазная матрица."))
        end
        for phase in ("ab", "ba", "ac", "ca", "bc", "cb"), prefix in ("r", "x")
            push!(inputs, parameter(prefix * "_" * phase, "Взаимный фазный параметр " * uppercase(prefix) * " " * uppercase(phase), "Ohm/km", "optional", "Конечное число. В этой π-модели не используется; ненулевое значение даёт явное предупреждение. r0/x0 не выводятся из этих полей; полнота, взаимность и пассивность фазной матрицы здесь не проверяются."))
        end
        return inputs
    elseif code in ("capacitor", "reactor")
        return [
            parameter("q_nom", "Номинальная реактивная мощность", "Mvar", "required", "Полная трёхфазная неотрицательная величина. Конденсатор выдаёт, реактор потребляет. Ноль явно отключает вклад шунта; это не постоянная Q при любом напряжении."),
            parameter("voltage_nom", "Номинальное напряжение шунта", "kV", "conditional", "Линейное RMS > 0; Q_nom относится к этому напряжению. При отсутствии и q_nom > 0 используется известный номинал узла с записью допущения. Проводимость Q_nom/U_nom² не меняется из-за номиналов других устройств узла. Не задаёт схему соединения фаз или нейтраль."),
        ]
    elseif code == "load"
        inputs = [
            parameter("p", "Активная мощность потребления", "MW", "required", "Полная трёхфазная; положительное потребление входит в узловой баланс с отрицательным знаком."),
            parameter("q", "Реактивная мощность потребления", "Mvar", "optional", "Полная трёхфазная; положительное потребление входит в узловой баланс с отрицательным знаком."; default="0"),
            parameter("voltage_nom", "Номинальное напряжение", "kV", "conditional", "Линейное RMS > 0; обязательно для ZIP, для PQ участвует только в выборе базиса/проверке уровня напряжения."),
            parameter("zip_enabled", "ZIP-профиль нагрузки", "1", "optional", "true — явные независимые доли Z/I/P для P и Q. false или отсутствие — прежняя постоянная мощность PQ."; kind="boolean", default="false"),
        ]
        for (part, unit) in (("p", "MW"), ("q", "Mvar")), (term, name) in (("z", "постоянное сопротивление"), ("i", "постоянный модуль тока"), ("p", "постоянная мощность"))
            push!(inputs, parameter("zip_$(part)_$(term)", "Доля $(uppercase(part)): $(name)", "1", "conditional",
                "Обязательна при zip_enabled=true; [0,1], тройка долей $(uppercase(part)) суммируется в 1 с допуском 1e-12. Номинальная мощность $(unit) задана при voltage_nom; коэффициенты не нормализуются автоматически."))
        end
        return inputs
    end
    return []
end

# These are spelling aliases at exactly the same scale, not dimensional or
# prefix conversions. Case matters: MW and mW must never be conflated.
const PARAMETER_UNIT_ALIASES = Dict(
    "MW" => ("MW", "МВт"), "Mvar" => ("Mvar", "Мвар"), "MVA" => ("MVA", "МВА"),
    "kV" => ("kV", "кВ"), "Ohm" => ("Ohm", "Ω", "Ом"), "km" => ("km", "км"),
    "Ohm/km" => ("Ohm/km", "Ω/km", "Ом/км"), "S/km" => ("S/km", "См/км"),
    "deg" => ("deg", "°", "град"), "%" => ("%",), "1" => ("1", ""))

# Read-only implementation metadata, constructed once rather than allocating
# complete parameter descriptions for every device in a large graph.
const AC_PARAMETER_UNIT_SPECS = let specifications = Dict{String,Dict{String,String}}()
    for code in ("generator", "transformer", "transmission_line", "load", "capacitor", "reactor")
        specifications[code] = Dict(spec["key"] => spec["unit"] for spec in model_parameters(code))
    end
    for code in ("busbar", "breaker", "disconnector", "ground", "grounding_switch")
        specifications[code] = Dict("voltage_nom" => "kV")
        code in ("breaker", "disconnector", "grounding_switch") && (specifications[code]["status"] = "1")
    end
    specifications
end

"""Check supplied catalogue labels against parameters consumed by this AC model.
Partial metadata is accepted for legacy inputs; absence is not a unit certificate.
Unknown/unconsumed parameters are not interpreted or certified here.
"""
function validate_parameter_units(code::AbstractString, params::Dict{String,String}, declared, path::AbstractString)
    require_object(declared, path)
    specs = get(AC_PARAMETER_UNIT_SPECS, code, nothing)
    for (key, value) in pairs(declared)
        value isa AbstractString || throw(contract_error("type_error", "parameter unit must be a string", detail="$(path).$(key)"))
        haskey(params, key) || throw(contract_error("unexpected_parameter_unit", "unit has no corresponding stored parameter", detail="$(code).$(path).$(key)"))
        expected = specs === nothing ? nothing : get(specs, key, nothing)
        expected === nothing && continue
        strip(value) in get(PARAMETER_UNIT_ALIASES, expected, (expected,)) || throw(contract_error(
            "parameter_unit_mismatch", "declared unit does not match the AC model; no automatic conversion is performed",
            detail="$(code).$(path).$(key): declared=$(repr(value)), expected=$(expected)"))
    end
    return nothing
end
