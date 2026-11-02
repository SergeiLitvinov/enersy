const AC_BASED_INPUT_UNIT_PROFILE = "based-ac-three-phase-rms-v3"
const AC_PARAMETER_BASE_PROFILE = "ac-three-phase-rms-v1"

function parse_parameter_source_base(raw, path::AbstractString)
    require_object(raw, path)
    Set(string(key) for key in keys(raw)) == Set(["profile", "s_base_mva", "v_base_kv"]) ||
        throw(contract_error("invalid_parameter_base", "source base requires exactly profile, s_base_mva and v_base_kv", detail=path))
    _json_field(raw, :profile) == AC_PARAMETER_BASE_PROFILE ||
        throw(contract_error("invalid_parameter_base", "unsupported source base convention", detail=path))
    s = as_number(_json_field(raw, :s_base_mva), "$(path).s_base_mva")
    v = as_number(_json_field(raw, :v_base_kv), "$(path).v_base_kv")
    s > 0 && v > 0 || throw(contract_error("invalid_parameter_base", "source bases must be positive", detail=path))
    return s, v
end

# Keep coefficient and scale exponents together. A derived Zbase need not itself
# fit Float64 when the resulting physical impedance can be represented.
function parameter_pu_to_physical(value::Float64, unit::AbstractString, s::Float64, v::Float64, path::AbstractString)
    ms, es = frexp(s)
    mv, ev = frexp(v)
    mantissa, exponent = if unit in ("MW", "Mvar", "MVA")
        ms, es
    elseif unit == "kV"
        mv, ev
    elseif unit == "Ohm"
        mv * mv / ms, 2ev - es
    else
        throw(contract_error("unsupported_parameter_base", "p.u. is not supported for this model quantity", detail="$(path): $(unit)"))
    end
    result = _scaled_own_part(value, mantissa, exponent)
    return _checked_unit_result(value, result, path)
end

function normalize_based_parameter_units(code::AbstractString, params::Dict{String,String}, declared, bases, path::AbstractString)
    require_object(declared, "$(path).parameterUnits")
    require_object(bases, "$(path).parameterBases")
    specs = get(AC_PARAMETER_UNIT_SPECS, code, nothing)
    specs === nothing && throw(contract_error("unsupported_unit_contract_component", "component has no parameter schema for this unit profile", detail=path))
    for (key, raw) in pairs(bases)
        haskey(params, key) && haskey(declared, key) && declared[key] == "p.u." ||
            throw(contract_error("unexpected_parameter_base", "source base requires an explicitly declared p.u. parameter", detail="$(path).parameterBases.$(key)"))
        parse_parameter_source_base(raw, "$(path).parameterBases.$(key)")
    end
    normalized = copy(params)
    units = Dict{String,String}()
    for (key, unit) in pairs(declared)
        unit isa AbstractString || throw(contract_error("type_error", "parameter unit must be a string", detail="$(path).parameterUnits.$(key)"))
        units[key] = unit
        unit == "p.u." || continue
        haskey(params, key) && haskey(specs, key) || throw(contract_error("unsupported_unit_contract_parameter", "unknown p.u. parameter", detail="$(path).$(key)"))
        haskey(bases, key) || throw(contract_error("missing_parameter_base", "p.u. requires an explicit original source base", detail="$(path).parameterBases.$(key)"))
        s, v = parse_parameter_source_base(bases[key], "$(path).parameterBases.$(key)")
        value = normalization_number(params[key], "$(path).$(key)")
        normalized[key] = repr(parameter_pu_to_physical(value, specs[key], s, v, "$(path).$(key)"))
        units[key] = specs[key]
    end
    return normalize_parameter_units(code, normalized, units, "$(path).parameterUnits")
end
