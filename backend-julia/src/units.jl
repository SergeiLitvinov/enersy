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
function BaseSystem(s_base_mva::Real, v_base_kv::Real, source::AbstractString)
    s = Float64(s_base_mva)
    v = Float64(v_base_kv)
    (isfinite(s) && s > 0) ||
        throw(contract_error("invalid_base", "s_base_mva must be a positive finite number",
                             detail="s_base_mva=$(s)"))
    (isfinite(v) && v > 0) ||
        throw(contract_error("invalid_base", "v_base_kv must be a positive finite number",
                             detail="v_base_kv=$(v)"))
    return new(s, v, String(source))
end
end

z_base_ohm(b::BaseSystem) = b.v_base_kv^2 / b.s_base_mva
i_base_ka(b::BaseSystem) = b.s_base_mva / (sqrt(3.0) * b.v_base_kv)

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

"""
    admittance_from_own_base(y_own, s_nom_mva, u_nom_kv, b::BaseSystem)

Перевод проводимости, заданной на собственном базисе элемента
(`s_nom_mva`, `u_nom_kv`), в безразмерные единицы системы. Проводимость
пересчитывается как `y_own · (S_nom/S_base) · (U_base/U_nom)²`; обратный
перевод — делением на тот же множитель. Нужен для элементов, параметры которых
заданы в процентном/номинальном виде (`u_kz`, `i_xx`), а не в омах.
"""
function admittance_from_own_base(y_own::Complex, s_nom_mva::Real, u_nom_kv::Real,
                                  b::BaseSystem)
    return y_own * (Float64(s_nom_mva) / b.s_base_mva) * (b.v_base_kv / Float64(u_nom_kv))^2
end

function impedance_from_own_base(z_own::Complex, s_nom_mva::Real, u_nom_kv::Real,
                                 b::BaseSystem)
    return z_own * (b.s_base_mva / Float64(s_nom_mva)) * (Float64(u_nom_kv) / b.v_base_kv)^2
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
