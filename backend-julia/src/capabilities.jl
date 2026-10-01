"""
Состояния возможностей расчёта. Заготовка не может быть выдана за результат:
для `UNSUPPORTED` и `EXPERIMENTAL` обязательно указана причина.

* `UNSUPPORTED` — реализации с достоверной постановкой нет; запрос отклоняется.
* `EXPERIMENTAL` — расчёт выполняется, но не подтверждён независимым эталоном;
  результат помечается и не выдаётся как проверенный.
* `VALIDATED` — подтверждён эталоном с опубликованными допусками (BASE/CORE).
* `DEPRECATED` — поддерживается, но заменяется.

Значения перечисления имеют префикс `STATUS_`, чтобы не совпадать с
одноимёнными категориями ошибок ядра (`UNSUPPORTED` в `errors.jl`).
В JSON и в текстах префикс не показывается.
"""
@enum CapabilityStatus STATUS_UNSUPPORTED STATUS_EXPERIMENTAL STATUS_VALIDATED STATUS_DEPRECATED

capability_status_string(s::CapabilityStatus) =
    lowercase(replace(enum_name(s), "STATUS_" => ""))
capability_status_string(s::AbstractString) = String(s)

struct CapabilityEntry
    model_group::String
    method::String
    status::CapabilityStatus
    summary::String
    reasons::Vector{String}
end

function entry_json(e::CapabilityEntry)
    return Dict{String,Any}(
        "model_group" => e.model_group,
        "method" => e.method,
        "status" => capability_status_string(e.status),
        "summary" => e.summary,
        "reasons" => e.reasons,
    )
end

"""
Реестр `model_group × method`. Это единственный источник правды о том, что
сервис умеет считать; UI и HTTP-слой обязаны опираться на него, а не на
собственные списки (см. BASE-02, A09).

Текущее состояние (сентябрь 2026):

* `three-phase/newton-raphson` — симметричный AC Newton–Raphson в полярных
  координатах в p.u.; собран из моделей (внешний источник, PQ,
  π-линия, двухобмоточный трансформатор, шунт, идеальный аппарат), но ещё не
  сверен с независимым эталоном — состояние `EXPERIMENTAL` до CORE-05.
* `three-phase/direct` — `UNSUPPORTED`: прежняя реализация сводила сеть к
  произвольной диагональной матрице и выдавала её решение как режим сети
  (A04). Искусственный прямой расчёт режимом не является.
* `phase-coordinates/*`, `symmetrical-components/*` — `STATUS_UNSUPPORTED`: прежние
  функции имели неверную размерность невязок и индексацию Y (A02, A06) и
  подменяли результат; переход к фазным координатам — PHY-01.
"""
const CAPABILITY_REGISTRY = CapabilityEntry[
    CapabilityEntry("three-phase", "newton-raphson", STATUS_EXPERIMENTAL,
        "Симметричный установившийся режим, AC Newton–Raphson, полярные координаты, p.u.",
        ["Аналитические тесты пройдены; независимые IEEE-сети ещё не сверены (CORE-05)",
         "Ограничения реактивной мощности PV-узлов не применяются, Q выдаётся как результат без проверки",
         "Трёхобмоточные трансформаторы, автотрансформаторы и несимметрия не поддержаны"]),
    CapabilityEntry("three-phase", "direct", STATUS_UNSUPPORTED,
        "Прямое линейное решение как режим сети",
        ["Прежняя реализация не использовала соединения схемы и подставляла произвольную диагональ Y (A04)",
         "Результат не является установившимся режимом и не выдаётся"]),
    CapabilityEntry("phase-coordinates", "newton-raphson", STATUS_UNSUPPORTED,
        "Фазные координаты, несимметричный установившийся режим",
        ["Прежняя реализация вычитала мощность из тока в невязке и индексировала Y локальными номерами (A06)",
         "Нет подтверждённой размерности фазных инъекций; задача PHY-01"]),
    CapabilityEntry("phase-coordinates", "direct", STATUS_UNSUPPORTED,
        "Фазные координаты, прямое решение",
        ["Не реализовано"]),
    CapabilityEntry("symmetrical-components", "newton-raphson", STATUS_UNSUPPORTED,
        "Расчёт по симметричным составляющим",
        ["Не реализовано; ранее возвращалась заглушка"]),
    CapabilityEntry("symmetrical-components", "direct", STATUS_UNSUPPORTED,
        "Расчёт по симметричным составляющим, прямое решение",
        ["Не реализовано; ранее возвращалась заглушка"]),
]

const KNOWN_MODEL_GROUPS = ["three-phase", "phase-coordinates", "symmetrical-components"]
const KNOWN_METHODS = ["newton-raphson", "direct"]

"""
    capability(model_group, method)

Запись реестра. Неизвестная комбинация возвращается как `STATUS_UNSUPPORTED` с
указанием допустимых значений — это позволяет отклонить запрос опечаткой и не
молчать о нём.
"""
function capability(model_group::AbstractString, method::AbstractString)
    mg = lowercase(String(model_group))
    m = lowercase(String(method))
    for e in CAPABILITY_REGISTRY
        if e.model_group == mg && e.method == m
            return e
        end
    end
    known = [string(e.model_group, "/", e.method) for e in CAPABILITY_REGISTRY]
    if !(mg in KNOWN_MODEL_GROUPS)
        return CapabilityEntry(mg, m, STATUS_UNSUPPORTED, "Неизвестная группа моделей",
            ["model_group='$(mg)' не поддерживается",
             "допустимые model_group: $(join(KNOWN_MODEL_GROUPS, ", "))"])
    end
    if !(m in KNOWN_METHODS)
        return CapabilityEntry(mg, m, STATUS_UNSUPPORTED, "Неизвестный численный метод",
            ["method='$(m)' не поддерживается",
             "допустимые method: $(join(KNOWN_METHODS, ", "))"])
    end
    return CapabilityEntry(mg, m, STATUS_UNSUPPORTED, "Комбинация группы и метода отсутствует в реестре",
        ["допустимые комбинации: $(join(known, ", "))"])
end

"""
    require_supported(model_group, method)

Проверка реестра перед расчётом. `STATUS_UNSUPPORTED` отклоняется с перечнем причин;
`EXPERIMENTAL` пропускается и его статус возвращается вместе с результатом,
чтобы пометить расчёт как непроверенный.
"""
function require_supported(model_group::AbstractString, method::AbstractString)
    e = capability(model_group, method)
    if e.status == STATUS_UNSUPPORTED
        throw(unsupported_error("unsupported_method",
            "Метод расчёта $(e.model_group)/$(e.method) не поддерживается",
            detail=join(e.reasons, "; ")))
    end
    return e
end

function capabilities_json()
    return Dict{String,Any}(
        "capabilities" => [entry_json(e) for e in CAPABILITY_REGISTRY],
        "model_groups" => KNOWN_MODEL_GROUPS,
        "methods" => KNOWN_METHODS,
        "policy" => "UNSUPPORTED отклоняется до расчёта; EXPERIMENTAL выполняется с пометкой в результате",
    )
end
