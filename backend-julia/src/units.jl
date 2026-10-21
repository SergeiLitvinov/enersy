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

kv_to_pu(v_kv::Real, b::BaseSystem) = Float64(v_kv) / b.v_base_kv
pu_to_kv(v_pu::Real, b::BaseSystem) = Float64(v_pu) * b.v_base_kv
mva_to_pu(s_mva::Real, b::BaseSystem) = Float64(s_mva) / b.s_base_mva
pu_to_mva(s_pu::Real, b::BaseSystem) = Float64(s_pu) * b.s_base_mva
ohm_to_pu(z_ohm::Real, b::BaseSystem) = Float64(z_ohm) / z_base_ohm(b)
ohm_to_pu(z_ohm::Complex, b::BaseSystem) = z_ohm / z_base_ohm(b)
pu_to_ohm(z_pu::Real, b::BaseSystem) = Float64(z_pu) * z_base_ohm(b)
siemens_to_pu(y_s::Real, b::BaseSystem) = Float64(y_s) * z_base_ohm(b)
siemens_to_pu(y_s::Complex, b::BaseSystem) = y_s * z_base_ohm(b)

function _scaled_own_part(value::Float64, mantissa::Float64, exponent::Int)
    value == 0.0 && return value
    mv, ev = frexp(value)
    return ldexp(mv * mantissa, ev + exponent)
end

function _own_base_conversion(value::Complex, s_nom_mva::Real, u_nom_kv::Real,
                              b::BaseSystem, admittance::Bool, owner::AbstractString)
    sn, un = Float64(s_nom_mva), Float64(u_nom_kv)
    isfinite(sn) && sn > 0 && isfinite(un) && un > 0 ||
        throw(contract_error("invalid_parameter", "own-base power and voltage must be positive finite numbers",
                             detail="$(owner): S_nom=$(sn) MVA, U_nom=$(un) kV"))
    coefficient = ComplexF64(value)
    isfinite(coefficient) && !(real(value) != 0 && real(coefficient) == 0) &&
        !(imag(value) != 0 && imag(coefficient) == 0) ||
        throw(contract_error("invalid_parameter", "own-base coefficient is not representable as finite Float64",
                             detail="$(owner): value=$(value)"))
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
pu_to_siemens(y_pu::Real, b::BaseSystem) = Float64(y_pu) / z_base_ohm(b)
ka_to_pu(i_ka::Real, b::BaseSystem) = Float64(i_ka) / i_base_ka(b)
pu_to_ka(i_pu::Real, b::BaseSystem) = Float64(i_pu) * i_base_ka(b)

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
