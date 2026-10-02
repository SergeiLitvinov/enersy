module EnersyCompute

"""
    EnersyCompute

Вычислительное ядро Enersy: сборка электрической сети, проверяемые численные
методы установившегося режима и HTTP-контракт расчёта.

Правила оформления (docs/CODING_RULES.md):

* импорт модуля не запускает HTTP-сервер; старт только в `backend-julia/server/main.jl`;
* JSON3 нормализуется в DTO (`dto.jl`) до любых вычислений, все проверки контракта
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
using JSON3
using HTTP

include("errors.jl")
include("units.jl")
include("dto.jl")
include("capabilities.jl")
include("topology.jl")
include("models.jl")
include("solver/newton_raphson.jl")
include("solver/sparse_jacobian.jl")
include("solver/q_limits.jl")
include("calculate.jl")
include("island_calculation.jl")
include("linear_solve.jl")
include("http_api.jl")

export VERSION,
       BaseSystem, SolverOptions, CalculateRequest, LinearRequest,
       RawComponent, RawConnection,
       EnersyError, ErrorKind, CONTRACT, UNSUPPORTED, NETWORK, SOLVER, INTERNAL,
       capability, capability_status_string, capabilities_json, require_supported,
       solve_linear,
       calculate,
       handle_request, serve, start_server

end # module
