#!/usr/bin/env julia
#
#    backend-julia/server/main.jl
#
# Единственная точка входа сервиса вычислений. Импорт модуля `EnersyCompute`
# не поднимает сервер (в отличие от прежнего `main.jl`, который начинал
# `HTTP.serve` в теле файла до определения парсеров — A08): весь контракт и
# модели описаны в пакете, этот файл только связывает их с процессом.
#
# Переменные окружения:
#   PORT       — порт прослушивания (по умолчанию 8001);
#   HOST       — адрес прослушивания (по умолчанию 0.0.0.0);
#   S_BASE_MVA — базовая мощность по умолчанию для /calculate, МВА (100).

module EnersyServer

using EnersyCompute

function port_from_env()
    raw = get(ENV, "PORT", "8001")
    value = tryparse(Int, strip(raw))
    value === nothing &&
        error("PORT must be an integer, got '$(raw)'")
    (1 <= value <= 65535) || error("PORT must be in 1..65535, got $(value)")
    return value
end

function main()
    host = get(ENV, "HOST", "0.0.0.0")
    port = port_from_env()
    println(stderr, "[enersy-julia] version=$(EnersyCompute.VERSION) " *
                    "host=$(host) port=$(port) s_base_mva=$(EnersyCompute.default_s_base_mva())")
    for entry in EnersyCompute.CAPABILITY_REGISTRY
        println(stderr, "[enersy-julia] capability $(entry.model_group)/$(entry.method): " *
                        "$(EnersyCompute.capability_status_string(entry.status))")
    end
    EnersyCompute.serve(; host=host, port=port)
end

end # module

if abspath(PROGRAM_FILE) == (@__FILE__)
    EnersyServer.main()
end
