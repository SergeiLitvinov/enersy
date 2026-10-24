"""Request-owned cooperative control. A token is never reset or shared across
requests. Cancellation is atomic; checks yield only outside native calls.
`clock` is a trusted monotonic nanosecond source (injectable for deterministic
tests). Limits are checked at stage boundaries, not a hard process watchdog.
"""
struct CalculationControl{F}
    cancelled::Threads.Atomic{Bool}
    started_ns::UInt64
    budget_ns::Union{Nothing,UInt64}
    clock::F
end

function CalculationControl(; max_time_ms::Union{Nothing,Integer}=nothing, clock=time_ns)
    if max_time_ms !== nothing
        !(max_time_ms isa Bool) && 1 <= max_time_ms <= typemax(UInt64) ÷ 1_000_000 ||
            throw(contract_error("invalid_execution_budget", "Time budget must be a positive representable integer in milliseconds"))
    end
    budget = max_time_ms === nothing ? nothing : UInt64(max_time_ms) * UInt64(1_000_000)
    CalculationControl(Threads.Atomic{Bool}(false), UInt64(clock()), budget, clock)
end

cancel_calculation!(control::CalculationControl) = (control.cancelled[] = true; nothing)
@inline execution_checkpoint(::Nothing, stage::Symbol, iteration::Int=0) = nothing
function execution_checkpoint(control::CalculationControl, stage::Symbol, iteration::Int=0)
    yield()
    control.cancelled[] && throw(EnersyError(EXECUTION, "calculation_cancelled",
        "Расчёт остановлен по запросу вызывающей стороны"; detail="stage=$stage iteration=$iteration"))
    if control.budget_ns !== nothing && UInt64(control.clock()) - control.started_ns >= control.budget_ns
        throw(EnersyError(EXECUTION, "calculation_deadline_exceeded",
            "Превышен бюджет времени расчёта"; detail="stage=$stage iteration=$iteration"))
    end
    nothing
end

# Leave headroom before the Go proxy's 25-second timeout. A blocking native
# call may overshoot; hard deadlines still require process/job isolation.
const HTTP_CALCULATION_BUDGET_MS = 20_000
function request_execution_control(json)
    require_object(json, "\$")
    options = _json_hasfield(json, :executionOptions) ?
        require_object(_json_field(json, :executionOptions), "\$.executionOptions") : Dict()
    all(key -> String(key) == "max_time_ms", keys(options)) ||
        throw(contract_error("invalid_execution_option", "Unknown execution option"))
    budget = _json_hasfield(options, :max_time_ms) ? _json_field(options, :max_time_ms) : HTTP_CALCULATION_BUDGET_MS
    budget isa Integer && !(budget isa Bool) && 1 <= budget <= HTTP_CALCULATION_BUDGET_MS ||
        throw(contract_error("invalid_execution_budget", "max_time_ms must be an integer in 1..20000"))
    CalculationControl(; max_time_ms=budget)
end

execution_metadata(control::CalculationControl) = Dict(
    "policy"=>"cooperative-checkpoints-v1",
    "max_time_ms"=>(control.budget_ns === nothing ? nothing : control.budget_ns ÷ UInt64(1_000_000)),
    "native_calls_interruptible"=>false, "disconnect_cancels"=>false)
