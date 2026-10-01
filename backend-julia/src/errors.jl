"""
    ErrorKind

Категория ошибки ядра. Категория определяет HTTP-статус и формат ответа,
поэтому ошибки разных стадий не смешиваются.

* `CONTRACT` — нарушен входной контракт (тип, размерность, обязательное поле).
* `UNSUPPORTED` — запрошенный режим/модель не имеет проверяемой реализации.
* `NETWORK` — входные данные не образуют решаемую сеть (нет источника, разные
  уровни напряжения в одном узле, остров без балансирующего узла).
* `SOLVER` — численный метод не сошёлся или матрица вырождена.
* `INTERNAL` — неожиданная ошибка; в отчёт попадает только тип и текст.
"""
@enum ErrorKind CONTRACT UNSUPPORTED NETWORK SOLVER INTERNAL

const HTTP_STATUS_FOR_KIND = Dict{ErrorKind,Int}(
    CONTRACT => 400,
    UNSUPPORTED => 422,
    NETWORK => 422,
    SOLVER => 500,
    INTERNAL => 500,
)

"""
    EnersyError(kind, code, message; detail="")

Структурированная ошибка ядра. `code` — стабильный машинный идентификатор,
`message` — объяснение для пользователя, `detail` — дополнительные сведения
(путь в JSON, идентификаторы компонентов, ожидаемые/полученные размерности).
"""
struct EnersyError <: Exception
    kind::ErrorKind
    code::String
    message::String
    detail::String
end

function EnersyError(kind::ErrorKind, code::AbstractString, message::AbstractString;
                     detail::AbstractString="")
    return EnersyError(kind, String(code), String(message), String(detail))
end

Base.showerror(io::IO, e::EnersyError) = begin
    print(io, e.code, ": ", e.message)
    isempty(e.detail) || print(io, " [", e.detail, "]")
    nothing
end

"""
    enum_name(x)

Имя значения `@enum`-перечисления. `nameof` для значений перечислений
появился только в Julia 1.11, а проект собирается под 1.10, поэтому имя
извлекается из таблицы имён типа.
"""
enum_name(x::Base.Enums.Enum) = String(Symbol(Base.Enums.namemap(typeof(x))[Integer(x)]))

kind_string(k::ErrorKind) = enum_name(k)
kind_string(e::EnersyError) = kind_string(e.kind)

"""
    to_dict(e::EnersyError)

Представление ошибки в теле ответа `/calculate` и `/solve`.
"""
function to_dict(e::EnersyError)
    return Dict{String,Any}(
        "kind" => kind_string(e),
        "code" => e.code,
        "message" => e.message,
        "detail" => e.detail,
    )
end

"""
    error_response(e::EnersyError)

Тело ответа для ошибочного случая: `success=false` плюс объект `error_detail`.
Клиент обязан различать `error_detail.code`; текст `error` на верхнем уровне оставлен
для обратной совместимости с существующим UI.
"""
function error_response(e::EnersyError)
    return Dict{String,Any}(
        "success" => false,
        "error" => e.message,
        "error_detail" => to_dict(e),
    )
end

http_status(e::EnersyError) = e.code == "body_too_large" ? 413 : get(HTTP_STATUS_FOR_KIND, e.kind, 500)

# --- конструкторы категорий -----------------------------------------------------

contract_error(code, message; detail="") = EnersyError(CONTRACT, code, message; detail=detail)
unsupported_error(code, message; detail="") = EnersyError(UNSUPPORTED, code, message; detail=detail)
network_error(code, message; detail="") = EnersyError(NETWORK, code, message; detail=detail)
solver_error(code, message; detail="") = EnersyError(SOLVER, code, message; detail=detail)
internal_error(code, message; detail="") = EnersyError(INTERNAL, code, message; detail=detail)
