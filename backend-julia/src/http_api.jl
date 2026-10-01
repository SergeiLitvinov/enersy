"""
    HTTP-контракт вычислительного ядра.

Маршруты:

| метод | путь           | назначение                                        |
|-------|----------------|---------------------------------------------------|
| GET   | `/health`      | процесс жив                                       |
| GET   | `/ready`       | модуль загружен и принимает расчёт                |
| GET   | `/version`     | версия ядра и политика реестра возможностей       |
| GET   | `/capabilities`| реестр `model_group × method` со статусами        |
| POST  | `/calculate`   | установившийся режим по схеме                    |
| POST  | `/solve`       | прямое решение квадратной системы (служебное)     |

Принципы контракта:

* HTTP-статус определяется категорией ошибки (`errors.jl`): нарушение контракта —
  400, неподдерживаемый режим и нерешаемая сеть — 422, отказ численного метода —
  500. Прежняя выдача «200 + success=false» для любой ошибки теряла различие
  между опечаткой в запросе и несходимостью (A12);
* тело ответа всегда валидный JSON; при ошибке содержит `success=false`,
  `error` (текст) и `error_detail` (стабильный `code`, категория, деталь);
* лимит тела задаётся явно: превышение — 413, а не молчаливое усечение;
* реестр возможностей отдаётся по HTTP, чтобы UI не сочинял собственный список
  режимов (A09).

Модуль не поднимает сервер при импорте: `serve`/`start_server` вызываются
только из `backend-julia/server/main.jl` и из тестов.
"""

#: Максимальный размер тела запроса, байт. Схемы больших энергорайонов
#: передаются постранично (CAT/RUN), поэтому молчаливое усечение недопустимо.
const MAX_BODY_BYTES = 8 * 1024 * 1024

const JSON_CONTENT_TYPE = "application/json; charset=utf-8"

#: Таймауты чтения запроса и записи ответа, мс.
const REQUEST_TIMEOUT_NS = 30 * 10^9

#: Базовая мощность по умолчанию, МВА. Переопределяется переменной окружения
#: `S_BASE_MVA`; значение всегда возвращается в ответе вместе с базисом.
const DEFAULT_S_BASE_MVA = 100.0

function default_s_base_mva()
    # ENV must be read at runtime, not captured in a precompiled package image.
    value = tryparse(Float64, get(ENV, "S_BASE_MVA", string(DEFAULT_S_BASE_MVA)))
    (value !== nothing && isfinite(value) && value > 0) || error("S_BASE_MVA must be a positive finite number")
    return value
end

#: Обработчики `POST`-маршрутов: путь → функция от разобранного тела.
#: Заполняется в конце файла, после определения обработчиков.
const POST_ROUTES = Dict{String,Function}()

#: Обработчики `GET`-маршрутов: путь → функция ответа.
const GET_ROUTES = Dict{String,Function}()

"""Нормализация пути: без query-строки и без хвостового слэша."""
function normalize_path(target::AbstractString)
    p = String(target)
    q = findfirst(==('?'), p)
    q === nothing || (p = p[1:prevind(p, q)])
    while length(p) > 1 && endswith(p, '/')
        p = p[1:prevind(p, lastindex(p))]
    end
    return isempty(p) ? "/" : p
end

function json_response(status::Int, payload)
    io = IOBuffer()
    try
        JSON3.write(io, payload)
    catch err
        # Ответ не должен превратиться в «500 без тела»: диагностика уходит в
        # лог сервера, клиент получает структурированную ошибку сериализации.
        @error "не удалось сериализовать ответ" exception = (err, catch_backtrace())
        return json_response(500, error_response(internal_error(
            "serialization_failure", "Ответ не удалось сериализовать в JSON")))
    end
    return HTTP.Response(status, ["Content-Type" => JSON_CONTENT_TYPE], take!(io))
end

"""Тело запроса → JSON3-объект; нарушения контракта — `EnersyError`."""
function read_json_body(req::HTTP.Request; max_body_bytes::Int=MAX_BODY_BYTES)
    body = req.body
    if length(body) > max_body_bytes
        throw(contract_error("body_too_large", "Request body exceeds the configured limit",
                             detail="bytes=$(length(body)) limit=$(max_body_bytes)"))
    end
    isempty(body) &&
        throw(contract_error("empty_body", "Request body is empty",
                             detail="expected a JSON object"))
    return try
        JSON3.read(String(body))
    catch err
        throw(contract_error("invalid_json", "Request body is not valid JSON",
                             detail=sprint(showerror, err)))
    end
end

# --- маршруты вычислений ---------------------------------------------------------

function handle_calculate(json)
    components, connections, model_group, method, base, options, default_s =
        parse_calculate_request(json; default_s_base_mva=default_s_base_mva())
    return calculate(components, connections; model_group=model_group, method=method,
                     base=base, options=options, default_s_base_mva=default_s)
end

function handle_solve(json)
    request = parse_linear_request(json)
    x = solve_linear(request.A, request.b)
    return Dict{String,Any}(
        "success" => true,
        "solution" => x,
        "size" => length(x),
        "method_used" => "lu",
        "note" => "Прямое линейное решение не является установившимся режимом сети",
    )
end

# --- диспетчеризация --------------------------------------------------------------

"""
    handle_request(req) -> HTTP.Response

Единая точка входа HTTP: маршрутизация, проверка метода, разбор тела,
структурированные ошибки. Не бросает исключений наружу — любой сбой
превращается в ответ с корректным статусом.
"""
function handle_request(req::HTTP.Request; max_body_bytes::Int=MAX_BODY_BYTES)
    path = normalize_path(req.target)
    method = uppercase(String(req.method))
    try
        if method == "GET" || method == "HEAD"
            handler = get(GET_ROUTES, path, nothing)
            handler === nothing && return method_or_not_found(path, method, false)
            result = json_response(200, handler())
            method == "HEAD" && (result.body = UInt8[])
            return result
        elseif method == "POST"
            handler = get(POST_ROUTES, path, nothing)
            handler === nothing && return method_or_not_found(path, method, true)
            return json_response(200, handler(read_json_body(req;
                                                             max_body_bytes=max_body_bytes)))
        else
            return method_or_not_found(path, method, true)
        end
    catch err
        if err isa EnersyError
            return json_response(http_status(err), error_response(err))
        end
        @error "необработанная ошибка вычислительного ядра" exception = (err, catch_backtrace())
        return json_response(500, error_response(internal_error(
            "internal_error", "Внутренняя ошибка вычислительного ядра",
            detail=string(typeof(err)))))
    end
end

"""405, если путь существует, но метод другой; иначе 404."""
function method_or_not_found(path::AbstractString, method::AbstractString,
                             posting::Bool)
    known = haskey(POST_ROUTES, path) || haskey(GET_ROUTES, path)
    if known
        allowed = haskey(GET_ROUTES, path) ? ["GET", "HEAD"] : ["POST"]
        result = json_response(405, error_response(contract_error(
            "method_not_allowed", "Метод $(method) не поддерживается для $(path)",
            detail="allowed: $(join(allowed, ", "))")))
        push!(result.headers, "Allow" => join(allowed, ", "))
        return result
    end
    return json_response(404, error_response(contract_error(
        "not_found", "Неизвестный маршрут $(method) $(path)",
        detail="known routes: $(join(sort!(vcat(collect(keys(GET_ROUTES)), collect(keys(POST_ROUTES)))), ", "))")))
end

# --- запуск сервера ---------------------------------------------------------------

"""
    start_server(; host, port, max_body_bytes) -> HTTP.Server

Поднимает сервер и возвращает объект сервера (для тестов и для остановки).
Порт `0` означает «выбрать свободный» — это позволяет тестам не занимать
фиксированный порт.
"""
function start_server(; host::AbstractString="0.0.0.0", port::Integer=8001,
                      max_body_bytes::Int=MAX_BODY_BYTES)
    handler = req -> handle_request(req; max_body_bytes=max_body_bytes)
    return HTTP.serve!(handler, host, port;
                       read_timeout_ns=REQUEST_TIMEOUT_NS,
                       write_timeout_ns=REQUEST_TIMEOUT_NS,
                       max_body_bytes=max_body_bytes, listenany=(port == 0))
end

"""Блокирующий запуск сервера (используется `server/main.jl`)."""
function serve(; host::AbstractString="0.0.0.0", port::Integer=8001,
               max_body_bytes::Int=MAX_BODY_BYTES)
    server = start_server(; host=host, port=port, max_body_bytes=max_body_bytes)
    try
        wait(server)
    finally
        HTTP.forceclose(server)
    end
end

# --- регистрация маршрутов --------------------------------------------------------
#
# Словари заполняются после определения обработчиков: это тот же приём, что и
# с парсерами в прежнем `main.jl` (A08), только теперь порядок объявлений
# гарантирован структурой файла, а не тем, что файл целиком прочитан до старта.

GET_ROUTES["/health"] =
    () -> Dict{String,Any}("status" => "ok", "service" => "enersy-julia",
                           "version" => VERSION)
GET_ROUTES["/ready"] =
    () -> Dict{String,Any}("status" => "ready", "service" => "enersy-julia",
                           "version" => VERSION,
                           "capabilities" => length(CAPABILITY_REGISTRY))
GET_ROUTES["/version"] =
    () -> Dict{String,Any}("service" => "enersy-julia", "version" => VERSION)
GET_ROUTES["/capabilities"] = capabilities_json

POST_ROUTES["/calculate"] = handle_calculate
POST_ROUTES["/solve"] = handle_solve
