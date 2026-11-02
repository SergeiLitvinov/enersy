"""Scales into the existing balanced-AC model units, never a phase/RMS conversion.
The profile, original request and worker identity determine each normalization.
Unknown dimensions and p.u. without an explicitly supported base stay rejected.
"""
const AC_SCALED_INPUT_UNIT_PROFILE = "scaled-ac-three-phase-rms-v2"
const AC_INPUT_UNIT_SCALES = Dict(
    "MW" => Dict("W"=>1e-6, "Вт"=>1e-6, "kW"=>1e-3, "кВт"=>1e-3, "mW"=>1e-9, "мВт"=>1e-9),
    "Mvar" => Dict("var"=>1e-6, "вар"=>1e-6, "kvar"=>1e-3, "квар"=>1e-3),
    "MVA" => Dict("VA"=>1e-6, "ВА"=>1e-6, "kVA"=>1e-3, "кВА"=>1e-3),
    "kV" => Dict("V"=>1e-3, "В"=>1e-3, "mV"=>1e-6, "мВ"=>1e-6),
    "Ohm" => Dict("mOhm"=>1e-3, "мОм"=>1e-3, "mΩ"=>1e-3, "kOhm"=>1e3, "кОм"=>1e3, "kΩ"=>1e3),
    "km" => Dict("m"=>1e-3, "м"=>1e-3),
    "Ohm/km" => Dict("Ohm/m"=>1e3, "Ω/m"=>1e3, "Ом/м"=>1e3, "mOhm/km"=>1e-3, "мОм/км"=>1e-3),
    "S/km" => Dict("S/m"=>1e3, "См/м"=>1e3, "mS/km"=>1e-3, "мСм/км"=>1e-3,
        "uS/km"=>1e-6, "µS/km"=>1e-6, "μS/km"=>1e-6, "мкСм/км"=>1e-6, "mS/m"=>1.0),
    "deg" => Dict("rad"=>180/pi, "рад"=>180/pi),
    "%" => Dict("1"=>100.0),
)
const AC_PARAMETER_KIND_SPECS = let kinds = Dict{String,Dict{String,String}}()
    for code in keys(AC_PARAMETER_UNIT_SPECS)
        kinds[code] = Dict(spec["key"] => spec["kind"] for spec in model_parameters(code))
        haskey(AC_PARAMETER_UNIT_SPECS[code], "status") && (kinds[code]["status"] = "boolean")
    end
    kinds
end

function parameter_unit_scale(expected::AbstractString, label::AbstractString, path::AbstractString)
    label in get(PARAMETER_UNIT_ALIASES, expected, (expected,)) && label != "" && return 1.0
    scales = get(AC_INPUT_UNIT_SCALES, expected, nothing)
    scale = scales === nothing ? nothing : get(scales, label, nothing)
    scale === nothing && throw(contract_error("parameter_unit_mismatch",
        "unit is not supported for this quantity in the scaled AC profile", detail="$(path): declared=$(repr(label)), model_unit=$(expected)"))
    return scale
end

function normalize_parameter_units(code::AbstractString, params::Dict{String,String}, declared, path::AbstractString)
    validate_parameter_units(code, params, declared, path; complete=true, scaling=true)
    result = copy(params)
    specs = AC_PARAMETER_UNIT_SPECS[code]
    for (key, unit) in pairs(declared)
        scale = parameter_unit_scale(specs[key], unit, "$(path).$(key)")
        # Boolean strings and unset optional values are not fabricated numbers.
        get(AC_PARAMETER_KIND_SPECS[code], key, "number") == "boolean" && continue
        text = strip(params[key])
        isempty(text) && continue
        occursin(r"^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$", text) || throw(contract_error("invalid_parameter",
            "unit normalization requires a decimal number", detail="$(path).$(key)"))
        value = tryparse(Float64, text)
        (value !== nothing && isfinite(value)) || throw(contract_error("invalid_parameter",
            "unit normalization requires a finite number", detail="$(path).$(key)"))
        mantissa = first(split(text, ['e', 'E']; limit=2))
        value == 0 && any(char -> '1' <= char <= '9', mantissa) && throw(contract_error("unrepresentable_parameter",
            "nonzero input is outside the Float64 range", detail="$(path).$(key)"))
        # Canonical numeric strings remain intact after validation.
        scale == 1.0 && continue
        normalized = value * scale
        (isfinite(normalized) && !(value != 0 && normalized == 0)) || throw(contract_error("unrepresentable_parameter",
            "normalized parameter is outside the nonzero Float64 range", detail="$(path).$(key)"))
        result[key] = repr(normalized)
    end
    return result
end
