"""
    RawComponent

Нормализованный экземпляр оборудования из схемы (DTO уровня транспорта).
`params` — строковые значения каталога: подстановка значений по умолчанию и
разбор единиц выполняются в `models.jl`, где для каждого ключа объявлены
единица и обязательность. Пустое значение параметра означает «параметр не
задан» и не заменяется молча.
"""
struct RawComponent
    id::Int
    code::String
    params::Dict{String,String}
    x::Float64
    y::Float64
    rotation::Int
end

"""Связь двух экземпляров: `from_port`/`to_port` — имена портов из редактора."""
struct RawConnection
    from::Int
    to::Int
    from_port::String
    to_port::String
end

"""Настройки итерационного метода. Допуски задаются явно, а не берутся из кода."""
struct SolverOptions
    tolerance::Float64
    max_iterations::Int
function SolverOptions(tolerance::Real, max_iterations::Integer)
    t = Float64(tolerance)
    (isfinite(t) && t > 0) ||
        throw(contract_error("invalid_tolerance", "solver tolerance must be a positive finite number",
                             detail="tolerance=$(t)"))
    m = try
        Int(max_iterations)
    catch
        throw(contract_error("invalid_max_iterations", "max_iterations is outside the supported integer range"))
    end
    m > 0 ||
        throw(contract_error("invalid_max_iterations", "max_iterations must be a positive integer",
                             detail="max_iterations=$(max_iterations)"))
    return new(t, m)
end
end

SolverOptions(; tolerance::Real=1e-8, max_iterations::Integer=50) = SolverOptions(tolerance, max_iterations)

"""Запрос `/calculate` после нормализации JSON3."""
struct CalculateRequest
    components::Vector{RawComponent}
    connections::Vector{RawConnection}
    model_group::String
    method::String
    base::BaseSystem
    options::SolverOptions
end

"""Запрос `/solve` после нормализации JSON3: квадратная матрица и вектор."""
struct LinearRequest
    A::Matrix{Float64}
    b::Vector{Float64}
end

# --- низкоуровневый доступ к JSON с путями --------------------------------------

_json_hasfield(obj, name::Symbol) = (haskey(obj, name) || haskey(obj, String(name)))

function _json_field(obj, name::Symbol)
    haskey(obj, name) && return obj[name]
    haskey(obj, String(name)) && return obj[String(name)]
    return nothing
end

_is_object(v) = v isa JSON3.Object || v isa AbstractDict
_is_array(v) = v isa JSON3.Array || v isa AbstractVector

function require_field(obj, name::Symbol, path::AbstractString)
    _json_hasfield(obj, name) ||
        throw(contract_error("missing_field", "required field '$(name)' is missing",
                             detail="$(path)"))
    return _json_field(obj, name)
end

function require_object(value, path::AbstractString)
    _is_object(value) ||
        throw(contract_error("type_error", "expected a JSON object",
                             detail="$(path): got $(typeof(value))"))
    return value
end

function require_array(value, path::AbstractString)
    _is_array(value) ||
        throw(contract_error("type_error", "expected a JSON array",
                             detail="$(path): got $(typeof(value))"))
    return value
end

function as_string(value, path::AbstractString; allow_empty::Bool=false)
    s = if value isa AbstractString
        String(value)
    elseif value isa Symbol
        String(value)
    elseif value isa Bool || value isa Integer || value isa AbstractFloat
        string(value)
    else
        throw(contract_error("type_error", "expected a string",
                             detail="$(path): got $(typeof(value))"))
    end
    if !allow_empty && isempty(strip(s))
        throw(contract_error("empty_value", "value must not be empty", detail="$(path)"))
    end
    return s
end

function as_number(value, path::AbstractString)
    (value isa Bool) &&
        throw(contract_error("type_error", "expected a number, got a boolean", detail="$(path)"))
    n = try
        Float64(value)
    catch
        throw(contract_error("type_error", "expected a number",
                             detail="$(path): got $(repr(value))"))
    end
    isfinite(n) ||
        throw(contract_error("not_finite", "expected a finite number",
                             detail="$(path): got $(n)"))
    return n
end

function as_int(value, path::AbstractString; positive::Bool=false)
    n = as_number(value, path)
    isinteger(n) ||
        throw(contract_error("type_error", "expected an integer",
                             detail="$(path): got $(n)"))
    i = try
        Int(n)
    catch
        throw(contract_error("out_of_range", "integer is outside the supported range", detail=String(path)))
    end
    if positive && i <= 0
        throw(contract_error("out_of_range", "expected a positive integer",
                             detail="$(path): got $(i)"))
    end
    return i
end

"""Плоский словарь «ключ → строковое значение»; вложенные значения отклоняются."""
function as_string_map(value, path::AbstractString)
    require_object(value, path)
    out = Dict{String,String}()
    for (k, v) in pairs(value)
        key = String(k)
        if !(v isa AbstractString || v isa Bool || v isa Real) ||
           (v isa Real && !isfinite(v))
            throw(contract_error("type_error", "parameter value must be a scalar",
                                 detail="$(path).$(key): got $(typeof(v))"))
        end
        out[key] = v isa AbstractString ? String(v) : string(v)
    end
    return out
end

# --- параметры оборудования -----------------------------------------------------

"""
    param_number(params, key; required, default, unit, owner)

Разбор числового параметра каталога. Отсутствующий обязательный параметр и
нечисловое значение — ошибки контракта с указанием владельца и ключа; молчаливая
подстановка значений по умолчанию выполняется только для явно необязательного
параметра, и использованное значение возвращается в отчёте `assumptions`.
"""
function param_number(params::Dict{String,String}, key::AbstractString;
                      required::Bool=true, default::Union{Nothing,Real}=nothing,
                      unit::AbstractString="", owner::AbstractString="")
    if !haskey(params, key) || isempty(strip(params[key]))
        if default === nothing
            required && return _missing_param(key, unit, owner)
            return nothing
        end
        raw = string(default)
    else
        raw = params[key]
    end
    n = try
        parse(Float64, strip(raw))
    catch
        throw(contract_error("param_not_numeric",
                             "parameter '$(key)' must be a number",
                             detail="$(isempty(owner) ? "" : owner * ".")key=$(key) value=$(repr(raw))"))
    end
    isfinite(n) ||
        throw(contract_error("param_not_finite", "parameter '$(key)' must be finite",
                             detail="$(isempty(owner) ? "" : owner * ".")key=$(key) value=$(n)"))
    return n
end

function param_bool(params::Dict{String,String}, key::AbstractString;
                    default::Bool=false, owner::AbstractString="")
    haskey(params, key) || return default
    raw = lowercase(strip(params[key]))
    raw in ("true", "1", "yes", "on", "замкнут", "вкл") && return true
    raw in ("false", "0", "no", "off", "разомкнут", "откл") && return false
    throw(contract_error("param_not_boolean", "parameter '$(key)' must be a boolean",
                         detail="$(isempty(owner) ? "" : owner * ".")key=$(key) value=$(repr(params[key]))"))
end

function _missing_param(key, unit, owner)
    throw(contract_error("missing_parameter",
                         "required parameter '$(key)' is not set",
                         detail="$(isempty(owner) ? "" : owner * ".")key=$(key) expected unit: $(unit)"))
end

# --- сборка DTO -----------------------------------------------------------------

function parse_component(raw, path::AbstractString)
    require_object(raw, path)
    id = as_int(require_field(raw, :id, path), "$(path).id"; positive=true)
    code = lowercase(as_string(require_field(raw, :type, path), "$(path).type"))
    params = if _json_hasfield(raw, :params)
        as_string_map(_json_field(raw, :params), "$(path).params")
    else
        Dict{String,String}()
    end
    x = _json_hasfield(raw, :x) ? as_number(_json_field(raw, :x), "$(path).x") : 0.0
    y = _json_hasfield(raw, :y) ? as_number(_json_field(raw, :y), "$(path).y") : 0.0
    rotation = _json_hasfield(raw, :rotation) ? as_int(_json_field(raw, :rotation), "$(path).rotation") : 0
    return RawComponent(id, code, params, x, y, rotation)
end

function parse_connection(raw, path::AbstractString)
    require_object(raw, path)
    from = as_int(require_field(raw, :from, path), "$(path).from"; positive=true)
    to = as_int(require_field(raw, :to, path), "$(path).to"; positive=true)
    # Контракт Go использует camelCase; snake_case принимается для совместимости.
    from_port = if _json_hasfield(raw, :fromPort)
        as_string(_json_field(raw, :fromPort), "$(path).fromPort"; allow_empty=true)
    elseif _json_hasfield(raw, :from_port)
        as_string(_json_field(raw, :from_port), "$(path).from_port"; allow_empty=true)
    else
        ""
    end
    to_port = if _json_hasfield(raw, :toPort)
        as_string(_json_field(raw, :toPort), "$(path).toPort"; allow_empty=true)
    elseif _json_hasfield(raw, :to_port)
        as_string(_json_field(raw, :to_port), "$(path).to_port"; allow_empty=true)
    else
        ""
    end
    return RawConnection(from, to, from_port, to_port)
end

"""
    parse_calculate_request(json; default_s_base_mva=100.0)

Нормализация тела `/calculate` в DTO. Базис по умолчанию не выдумывается: если
`base` не передан, он выводится из номинальных напряжений компонентов
(`derive_base`) и помечается как `derived`.
"""
function parse_calculate_request(json; default_s_base_mva::Real=100.0)
    require_object(json,     "\$")
    comps_raw = require_array(require_field(json, :components,     "\$"), "\$.components")
    components = [parse_component(c, "\$.components[$(i)]") for (i, c) in enumerate(comps_raw)]
    ids = Set{Int}()
    for c in components
        c.id in ids &&
            throw(contract_error("duplicate_component_id", "component ids must be unique",
                                 detail="id=$(c.id)"))
        push!(ids, c.id)
    end

    connections = if _json_hasfield(json, :connections)
        [parse_connection(c, "\$.connections[$(i)]") for (i, c) in
         enumerate(require_array(_json_field(json, :connections), "\$.connections"))]
    else
        RawConnection[]
    end

    model_group = _json_hasfield(json, :modelGroup) ?
        as_string(_json_field(json, :modelGroup), "\$.modelGroup") :
        (_json_hasfield(json, :model_group) ?
            as_string(_json_field(json, :model_group), "\$.model_group") : "three-phase")

    method = _json_hasfield(json, :method) ?
        as_string(_json_field(json, :method), "\$.method") : "newton-raphson"

    options = if _json_hasfield(json, :solverOptions)
        o = require_object(_json_field(json, :solverOptions), "\$.solverOptions")
        SolverOptions(
            tolerance=_json_hasfield(o, :tolerance) ? as_number(_json_field(o, :tolerance), "\$.solverOptions.tolerance") : 1e-8,
            max_iterations=_json_hasfield(o, :max_iterations) ? as_int(_json_field(o, :max_iterations), "\$.solverOptions.max_iterations") : 50,
        )
    else
        SolverOptions()
    end

    base = _json_hasfield(json, :base) ? parse_base(_json_field(json, :base), "\$.base") : nothing

    return components, connections, model_group, method, base, options, Float64(default_s_base_mva)
end

function parse_base(value, path::AbstractString)
    require_object(value, path)
    s = _json_hasfield(value, :s_base_mva) ? as_number(_json_field(value, :s_base_mva), "$(path).s_base_mva") :
        throw(contract_error("missing_field", "base.s_base_mva is required", detail=path))
    v = _json_hasfield(value, :v_base_kv) ? as_number(_json_field(value, :v_base_kv), "$(path).v_base_kv") :
        throw(contract_error("missing_field", "base.v_base_kv is required", detail=path))
    return BaseSystem(s, v, "request")
end

"""
    derive_base(components, s_base_mva)

Базовые значения при отсутствии явного `base`. `v_base_kv` — наибольшее
номинальное напряжение среди компонентов, `s_base_mva` — объявленное значение
по умолчанию. Оба значения возвращаются в ответе с `source="derived"`, поэтому
результат не предъявляется без базиса. Если номинальных напряжений нет, расчёт
не запускается: подставлять напряжение по умолчанию — неявный физический
параметр.
"""
function derive_base(components::Vector{RawComponent}, s_base_mva::Real)
    vmax = 0.0
    for c in components
        if haskey(c.params, "voltage_nom")
            v = tryparse(Float64, strip(c.params["voltage_nom"]))
            v === nothing && continue
            vmax = max(vmax, v)
        end
    end
    vmax > 0 ||
        throw(contract_error("base_not_determinable",
                             "cannot determine voltage base: no component provides 'voltage_nom'; pass base.v_base_kv explicitly",
                             detail="components=$(length(components))"))
    return BaseSystem(s_base_mva, vmax, "derived")
end

# --- линейная система ------------------------------------------------------------

"""
    parse_linear_request(json)

Нормализация тела `/solve`. Диагностируются: не-массив, нечисловые элементы,
прямоугольность `A`, квадратность, соответствие размерностей `A` и `b`,
непустота.
"""
function parse_linear_request(json)
    require_object(json,     "\$")
    a_raw = require_field(json, :A,     "\$")
    b_raw = require_field(json, :b,     "\$")
    A = parse_matrix(a_raw, "\$.A")
    b = parse_vector(b_raw, "\$.b")
    if size(A, 1) != size(A, 2)
        throw(contract_error("non_square_matrix",
                             "A must be square for a direct linear solve",
                             detail="rows=$(size(A, 1)) cols=$(size(A, 2))"))
    end
    if isempty(b)
        throw(contract_error("empty_vector", "b must contain at least one element", detail="\$.b"))
    end
    if size(A, 2) != length(b)
        throw(contract_error("dimension_mismatch",
                             "A and b dimensions do not match",
                             detail="A cols=$(size(A, 2)) length(b)=$(length(b))"))
    end
    return LinearRequest(A, b)
end

function parse_matrix(data, path::AbstractString)
    require_array(data, path)
    rows_raw = collect(data)
    isempty(rows_raw) &&
        throw(contract_error("empty_matrix", "A must contain at least one row", detail=path))
    ncols = nothing
    rows = Vector{Vector{Float64}}(undef, length(rows_raw))
    for (i, row_raw) in enumerate(rows_raw)
        rpath = "$(path)[$(i)]"
        require_array(row_raw, rpath)
        vals = collect(row_raw)
        isempty(vals) &&
            throw(contract_error("empty_row", "row must contain at least one element", detail=rpath))
        if ncols === nothing
            ncols = length(vals)
        elseif length(vals) != ncols
            throw(contract_error("ragged_matrix", "all rows of A must have the same length",
                                 detail="$(rpath): length=$(length(vals)) expected=$(ncols)"))
        end
        row = Vector{Float64}(undef, length(vals))
        for (j, v) in enumerate(vals)
            row[j] = as_number(v, "$(rpath)[$(j)]")
        end
        rows[i] = row
    end
    A = Matrix{Float64}(undef, length(rows), ncols)
    for i in eachindex(rows)
        A[i, :] = rows[i]
    end
    return A
end

function parse_vector(data, path::AbstractString)
    require_array(data, path)
    vals = collect(data)
    out = Vector{Float64}(undef, length(vals))
    for (i, v) in enumerate(vals)
        out[i] = as_number(v, "$(path)[$(i)]")
    end
    return out
end
