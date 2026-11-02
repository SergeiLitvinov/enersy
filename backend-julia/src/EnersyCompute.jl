module EnersyCompute

"""
    EnersyCompute

Вычислительное ядро Enersy: сборка электрической сети, проверяемые численные
методы установившегося режима и HTTP-контракт расчёта.

Правила оформления (docs/CODING_RULES.md):

* импорт модуля не запускает HTTP-сервер; старт только в `backend-julia/server/main.jl`;
* JSON нормализуется в DTO (`dto.jl`) до любых вычислений, все проверки контракта
  выполняются до сборки сети;
* неподдерживаемые режимы не имитируются результатом: они отклоняются реестром
  возможностей (`capabilities.jl`) с указанием причины;
* единицы и базисы объявлены явно (`units.jl`), в ответе возвращаются вместе с
  результатом; молчаливые подстановки физических параметров запрещены.
"""

const VERSION = "0.1.0"

using LinearAlgebra
using SparseArrays
using Printf
using Sockets
using JSON
using HTTP
using SHA

include("errors.jl")
include("units.jl")
include("dto.jl")
include("execution_control.jl")
include("capabilities.jl")
include("topology.jl")
include("operating_limits.jl")
include("load_profiles.jl")
include("models.jl")
include("solver/newton_raphson.jl")
include("solver/sparse_jacobian.jl")
include("solver/q_limits.jl")
include("compute_backends.jl")
include("calculate.jl")
include("island_calculation.jl")
include("linear_solve.jl")
include("model_parameters.jl")
include("unit_normalization.jl")
include("model_definitions.jl")
include("http_api.jl")
include("startup_preparation.jl")

export VERSION,
       CalculationControl, cancel_calculation!, EXECUTION,
       TerminalVoltageLimit,
       BaseSystem, SolverOptions, CalculateRequest, LinearRequest,
       kv_to_pu, pu_to_kv, mva_to_pu, pu_to_mva, ohm_to_pu, pu_to_ohm,
       siemens_to_pu, pu_to_siemens, ka_to_pu, pu_to_ka,
       rebase_voltage, rebase_power, rebase_current, rebase_impedance, rebase_admittance,
       RawComponent, RawConnection,
       EnersyError, ErrorKind, CONTRACT, UNSUPPORTED, NETWORK, SOLVER, INTERNAL,
       capability, capability_status_string, capabilities_json, require_supported,
       solve_linear,
       calculate,
       handle_request, serve, start_server

end # module
