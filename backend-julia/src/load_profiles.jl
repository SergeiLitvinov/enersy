"""Static balanced load: independent Z/I/P fractions at an explicit RMS kV rating.
No cut-off, frequency response, motor dynamics or low-voltage regularization.
"""
struct LoadProfile
    zip::Bool
    voltage_kv::Union{Nothing,Float64}
    p::NTuple{3,Float64} # Z, I, P fractions
    q::NTuple{3,Float64}
end

const ZIP_KEYS = ("zip_p_z", "zip_p_i", "zip_p_p", "zip_q_z", "zip_q_i", "zip_q_p")

function load_profile(params::Dict{String,String}, owner::AbstractString)
    enabled = param_bool(params, "zip_enabled"; owner)
    if !enabled
        any(k -> haskey(params, k) && !isempty(strip(params[k])), ZIP_KEYS) &&
            throw(contract_error("invalid_load_profile", "ZIP coefficients require zip_enabled=true", detail=owner))
        return LoadProfile(false, nothing, (0.0, 0.0, 1.0), (0.0, 0.0, 1.0))
    end
    voltage = param_number(params, "voltage_nom"; unit="kV", owner)
    voltage > 0 || throw(contract_error("invalid_load_profile", "ZIP rated voltage must be positive", detail=owner))
    values = [param_number(params, key; unit="1", owner) for key in ZIP_KEYS]
    all(x -> 0 <= x <= 1, values) ||
        throw(contract_error("invalid_load_profile", "ZIP fractions must lie between zero and one", detail=owner))
    p, q = Tuple(values[1:3]), Tuple(values[4:6])
    all(c -> abs(sum(c) - 1.0) <= 1e-12, (p, q)) ||
        throw(contract_error("invalid_load_profile", "Each ZIP fraction triple must sum to one (absolute tolerance 1e-12)", detail=owner))
    return LoadProfile(true, voltage, p, q)
end

load_factor(c::NTuple{3,Float64}, ratio::Float64) = c[1] * ratio^2 + c[2] * ratio + c[3]

"""Actual signed injection in MW/Mvar; nominal input powers are never mutated."""
function load_injection(inj::Injection, voltage_kv::Float64)
    profile = load_profile(inj.params, "load#$(inj.component_id)")
    profile.zip || return inj.p_mw, inj.q_mvar
    ratio = voltage_kv / profile.voltage_kv
    return inj.p_mw * load_factor(profile.p, ratio), inj.q_mvar * load_factor(profile.q, ratio)
end

"""Voltage-dependent positive consumption in p.u.; constant terms live in setup.
Coefficients multiply bus voltage in the returned system base, not device U_nom.
"""
struct VoltageDemand
    bus::Int
    p_i::Float64
    p_z::Float64
    q_i::Float64
    q_z::Float64
end
