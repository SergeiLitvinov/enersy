# Scale mantissas before restoring the binary exponent. Direct v^2/s and
# s/(sqrt(3)*v) can overflow/underflow even when the final base is representable.
function _base_impedance(s::Float64, v::Float64)
    mv, ev = frexp(v)
    ms, es = frexp(s)
    return ldexp(mv * mv / ms, 2ev - es)
end

function _base_current(s::Float64, v::Float64)
    mv, ev = frexp(v)
    ms, es = frexp(s)
    return ldexp(ms / mv / sqrt(3.0), es - ev)
end

"""
    BaseSystem

Явный базис расчёта. Принятые соглашения (docs/CODING_RULES.md, раздел
«Параметры и единицы»):

* напряжения — линейные (line-to-line) действующие (RMS) значения, кВ;
* мощности — полные трёхфазные (three-phase total), МВт / Мвар;
* сопротивления — на фазу, Ом; проводимости — на фазу, См;
* внутренние вычисления ведутся в безразмерных единицах (p.u.) на этом базисе.

`source` фиксирует происхождение базиса: `request` — задан входным запросом,
`derived` — выведен из номинальных напряжений компонентов схемы. Значение
возвращается в ответе вместе с `z_base_ohm`, поэтому результат нельзя
интерпретировать без известного базиса.
"""
struct BaseSystem
    s_base_mva::Float64
    v_base_kv::Float64
    source::String
    z_scale_ohm::Float64
    i_scale_ka::Float64
function BaseSystem(s_base_mva::Real, v_base_kv::Real, source::AbstractString)
    (s_base_mva isa Bool || v_base_kv isa Bool) && throw(contract_error(
        "invalid_base", "physical base values cannot be boolean"))
    s = Float64(s_base_mva)
    v = Float64(v_base_kv)
    (isfinite(s) && s > 0) ||
        throw(contract_error("invalid_base", "s_base_mva must be a positive finite number",
                             detail="s_base_mva=$(s)"))
    (isfinite(v) && v > 0) ||
        throw(contract_error("invalid_base", "v_base_kv must be a positive finite number",
                             detail="v_base_kv=$(v)"))
    z, i = _base_impedance(s, v), _base_current(s, v)
    (isfinite(z) && z > 0) ||
        throw(contract_error("invalid_base", "z_base_ohm is not representable as a positive finite Float64",
                             detail="s_base_mva=$(s), v_base_kv=$(v)"))
    (isfinite(i) && i > 0) ||
        throw(contract_error("invalid_base", "i_base_ka is not representable as a positive finite Float64",
                             detail="s_base_mva=$(s), v_base_kv=$(v)"))
    return new(s, v, String(source), z, i)
end
end

z_base_ohm(b::BaseSystem) = b.z_scale_ohm
i_base_ka(b::BaseSystem) = b.i_scale_ka

# --- безразмерные величины ------------------------------------------------------

_unit_part_lost(before, after) = (real(before) != 0 && real(after) == 0) || (imag(before) != 0 && imag(after) == 0)

@inline function _checked_unit_value(value::Union{Real,Complex}, owner::AbstractString)
    (real(value) isa Bool || imag(value) isa Bool) && throw(contract_error(
        "invalid_parameter", "electrical quantities cannot be boolean", detail=owner))
    isfinite(value) || throw(contract_error("invalid_parameter", "electrical quantity must be finite", detail=owner))
    converted = try
        value isa Complex ? ComplexF64(value) : Float64(value)
    catch error
        error isa Union{InexactError,OverflowError} || rethrow()
        throw(contract_error("unrepresentable_parameter", "electrical quantity is outside Float64 range", detail=owner))
    end
    isfinite(converted) && !_unit_part_lost(value, converted) || throw(contract_error(
        "unrepresentable_parameter", "electrical quantity is outside nonzero Float64 range", detail=owner))
    return converted
end

@inline function _checked_unit_result(before, after, owner::AbstractString)
    isfinite(after) && !_unit_part_lost(before, after) || throw(contract_error(
        "unrepresentable_parameter", "unit conversion is outside nonzero Float64 range", detail=owner))
    return after
end

@inline function _unit_scale(value::Union{Real,Complex}, scale::Float64, divide::Bool, owner::AbstractString)
    coefficient = _checked_unit_value(value, owner)
    result = divide ? coefficient / scale : coefficient * scale
    return _checked_unit_result(coefficient, result, owner)
end

"""Line-to-line RMS kV ↔ p.u.; complex input keeps the same phasor convention."""
kv_to_pu(value::Union{Real,Complex}, b::BaseSystem; owner::AbstractString="kv_to_pu") = _unit_scale(value, b.v_base_kv, true, owner)
pu_to_kv(value::Union{Real,Complex}, b::BaseSystem; owner::AbstractString="pu_to_kv") = _unit_scale(value, b.v_base_kv, false, owner)
"""Three-phase MVA ↔ p.u.; complex components are MW + j Mvar."""
mva_to_pu(value::Union{Real,Complex}, b::BaseSystem; owner::AbstractString="mva_to_pu") = _unit_scale(value, b.s_base_mva, true, owner)
pu_to_mva(value::Union{Real,Complex}, b::BaseSystem; owner::AbstractString="pu_to_mva") = _unit_scale(value, b.s_base_mva, false, owner)
"""Per-phase Ohm ↔ p.u. on the explicitly supplied electrical base."""
ohm_to_pu(value::Union{Real,Complex}, b::BaseSystem; owner::AbstractString="ohm_to_pu") = _unit_scale(value, z_base_ohm(b), true, owner)
pu_to_ohm(value::Union{Real,Complex}, b::BaseSystem; owner::AbstractString="pu_to_ohm") = _unit_scale(value, z_base_ohm(b), false, owner)
"""Per-phase Siemens ↔ p.u., reciprocal to impedance scaling."""
siemens_to_pu(value::Union{Real,Complex}, b::BaseSystem; owner::AbstractString="siemens_to_pu") = _unit_scale(value, z_base_ohm(b), false, owner)

function _scaled_own_part(value::Float64, mantissa::Float64, exponent::Int)
    value == 0.0 && return value
    mv, ev = frexp(value)
    return ldexp(mv * mantissa, ev + exponent)
end

function _own_base_conversion(value::Complex, s_nom_mva::Real, u_nom_kv::Real,
                              b::BaseSystem, admittance::Bool, owner::AbstractString)
    (s_nom_mva isa Bool || u_nom_kv isa Bool) && throw(contract_error(
        "invalid_parameter", "own-base power and voltage cannot be boolean", detail=owner))
    sn, un = Float64(s_nom_mva), Float64(u_nom_kv)
    isfinite(sn) && sn > 0 && isfinite(un) && un > 0 ||
        throw(contract_error("invalid_parameter", "own-base power and voltage must be positive finite numbers",
                             detail="$(owner): S_nom=$(sn) MVA, U_nom=$(un) kV"))
    coefficient = _checked_unit_value(value, owner)
    ms, es = frexp(b.s_base_mva)
    mn, en = frexp(sn)
    mu, eu = frexp(un)
    mv, ev = frexp(b.v_base_kv)
    # Z_sys = Z_own * (S_base/S_nom) * (U_nom/U_base)^2.
    # Keep the value's exponent until the end too: the scale itself need not
    # fit Float64 when its product with the coefficient is representable.
    mantissa = (ms / mn) * (mu / mv)^2
    exponent = es - en + 2 * (eu - ev)
    if admittance
        mantissa, exponent = inv(mantissa), -exponent
    end
    result = complex(_scaled_own_part(real(coefficient), mantissa, exponent),
                     _scaled_own_part(imag(coefficient), mantissa, exponent))
    isfinite(result) && !(real(coefficient) != 0 && real(result) == 0) &&
        !(imag(coefficient) != 0 && imag(result) == 0) ||
        throw(contract_error("unrepresentable_parameter", "own-base conversion is outside the nonzero Float64 range",
            detail="$(owner) $(admittance ? "admittance" : "impedance"): value=$(coefficient), S_nom=$(sn) MVA, U_nom=$(un) kV, " *
                   "S_base=$(b.s_base_mva) MVA, U_base=$(b.v_base_kv) kV"))
    return result
end

"""
    admittance_from_own_base(y_own, s_nom_mva, u_nom_kv, b::BaseSystem; owner="")

Перевод проводимости с собственного базиса элемента в базис системы:
`y_own · (S_nom/S_base) · (U_base/U_nom)²`. Мощность — трёхфазные МВА,
напряжение — линейные RMS кВ, проводимость на обоих базисах — p.u.

Масштаб и коэффициент объединяются по двоичным показателям без промежуточного
квадрата большого отношения. Реальная и мнимая части вычисляются отдельно в
Float64. Непредставимый конечный результат или потеря ненулевой части в ноль
отклоняется с `unrepresentable_parameter`; `owner` уточняет исходный элемент.
"""
function admittance_from_own_base(y_own::Complex, s_nom_mva::Real, u_nom_kv::Real,
                                  b::BaseSystem; owner::AbstractString="")
    return _own_base_conversion(y_own, s_nom_mva, u_nom_kv, b, true, owner)
end

"""
    impedance_from_own_base(z_own, s_nom_mva, u_nom_kv, b::BaseSystem; owner="")

Перевод сопротивления p.u. с собственного базиса:
`z_own · (S_base/S_nom) · (U_nom/U_base)²`. Соглашения и проверки диапазона
такие же, как у `admittance_from_own_base`; проводимость имеет обратный масштаб.
"""
function impedance_from_own_base(z_own::Complex, s_nom_mva::Real, u_nom_kv::Real,
                                 b::BaseSystem; owner::AbstractString="")
    return _own_base_conversion(z_own, s_nom_mva, u_nom_kv, b, false, owner)
end
pu_to_siemens(value::Union{Real,Complex}, b::BaseSystem; owner::AbstractString="pu_to_siemens") = _unit_scale(value, z_base_ohm(b), true, owner)
"""Line RMS kA ↔ p.u. using S_3phase/(sqrt(3) V_LL); phasor angle is unchanged."""
ka_to_pu(value::Union{Real,Complex}, b::BaseSystem; owner::AbstractString="ka_to_pu") = _unit_scale(value, i_base_ka(b), true, owner)
pu_to_ka(value::Union{Real,Complex}, b::BaseSystem; owner::AbstractString="pu_to_ka") = _unit_scale(value, i_base_ka(b), false, owner)

function impedance_from_own_base(value::Real, sn::Real, un::Real, base::BaseSystem; owner::AbstractString="")
    coefficient = _checked_unit_value(value, owner)
    return real(_own_base_conversion(complex(coefficient), sn, un, base, false, owner))
end
function admittance_from_own_base(value::Real, sn::Real, un::Real, base::BaseSystem; owner::AbstractString="")
    coefficient = _checked_unit_value(value, owner)
    return real(_own_base_conversion(complex(coefficient), sn, un, base, true, owner))
end

function _unit_rebase(value::Union{Real,Complex}, from::Float64, to::Float64, owner::AbstractString)
    coefficient = _checked_unit_value(value, owner)
    mf, ef = frexp(from)
    mt, et = frexp(to)
    mantissa, exponent = mf / mt, ef - et
    result = coefficient isa Complex ? complex(_scaled_own_part(real(coefficient), mantissa, exponent),
        _scaled_own_part(imag(coefficient), mantissa, exponent)) : _scaled_own_part(coefficient, mantissa, exponent)
    return _checked_unit_result(coefficient, result, owner)
end

"""Change the voltage p.u. base with explicit old/new BaseSystem; keep the voltage frame."""
rebase_voltage(value::Union{Real,Complex}, from::BaseSystem, to::BaseSystem) = _unit_rebase(value, from.v_base_kv, to.v_base_kv, "rebase_voltage")
"""Change the three-phase complex power p.u. base; preserve MW+jMvar conventions."""
rebase_power(value::Union{Real,Complex}, from::BaseSystem, to::BaseSystem) = _unit_rebase(value, from.s_base_mva, to.s_base_mva, "rebase_power")
"""Change the RMS current p.u. base using the two explicitly declared electrical bases."""
rebase_current(value::Union{Real,Complex}, from::BaseSystem, to::BaseSystem) = _unit_rebase(value, i_base_ka(from), i_base_ka(to), "rebase_current")
"""Z_new = Z_old (S_new/S_old) (V_old/V_new)^2, without an overflowing intermediate ratio."""
rebase_impedance(value::Union{Real,Complex}, from::BaseSystem, to::BaseSystem) = impedance_from_own_base(value, from.s_base_mva, from.v_base_kv, to; owner="rebase_impedance")
"""Y_new = Y_old (S_old/S_new) (V_new/V_old)^2, reciprocal to impedance rebasing."""
rebase_admittance(value::Union{Real,Complex}, from::BaseSystem, to::BaseSystem) = admittance_from_own_base(value, from.s_base_mva, from.v_base_kv, to; owner="rebase_admittance")

function base_json(b::BaseSystem)
    return Dict{String,Any}(
        "s_base_mva" => b.s_base_mva,
        "v_base_kv" => b.v_base_kv,
        "z_base_ohm" => z_base_ohm(b),
        "i_base_ka" => i_base_ka(b),
        "source" => b.source,
        "convention" => "three-phase totals, line-to-line RMS voltages, per-phase impedances",
    )
end

const UNIT_CONVENTION = Dict{String,String}(
    "voltage" => "kV (line-to-line RMS)",
    "angle" => "deg",
    "active_power" => "MW",
    "reactive_power" => "Mvar",
    "current" => "kA",
    "impedance" => "Ohm (per phase)",
    "admittance" => "S (per phase)",
    "per_unit_base" => "p.u. on the returned base",
)
