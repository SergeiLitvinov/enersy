"""Study-owned limits of line-to-line RMS voltage, in kV. No nominal defaults.
Terminal numbers refer to the compiled equipment contract, never coordinates.
This assessment does not change equations, select a root or prove stability.
"""
struct TerminalVoltageLimit
    component_id::Int
    terminal::Int
    min_kv::Float64
    max_kv::Float64
    function TerminalVoltageLimit(component_id::Integer, terminal::Integer, min_kv::Real, max_kv::Real)
        !(component_id isa Bool) && !(terminal isa Bool) &&
            0 < component_id <= typemax(Int) && 0 < terminal <= typemax(Int) ||
            throw(contract_error("invalid_limit_target", "Limit target must contain positive integer component_id and terminal"))
        !(min_kv isa Bool) && !(max_kv isa Bool) &&
            isfinite(min_kv) && isfinite(max_kv) && 0 < min_kv <= max_kv <= floatmax(Float64) ||
            throw(contract_error("invalid_voltage_limits", "Voltage limits must be finite positive kV values with min_kv <= max_kv"))
        low, high = Float64(min_kv), Float64(max_kv)
        low > 0 || throw(contract_error("invalid_voltage_limits", "Voltage limit underflows Float64"))
        new(Int(component_id), Int(terminal), low, high)
    end
end

function request_operating_limits(json)
    _json_hasfield(json, :operatingLimits) || return TerminalVoltageLimit[]
    entries = require_array(_json_field(json, :operatingLimits), "\$.operatingLimits")
    limits = TerminalVoltageLimit[]
    for (index, entry) in enumerate(entries)
        path = "\$.operatingLimits[$index]"
        require_object(entry, path)
        all(k -> String(k) in ("component_id", "terminal", "min_kv", "max_kv"), keys(entry)) ||
            throw(contract_error("unknown_operating_limit_field", "Unknown terminal voltage limit field"; detail=path))
        values = [require_field(entry, key, path) for key in (:component_id, :terminal, :min_kv, :max_kv)]
        all(v -> v isa Integer && !(v isa Bool), values[1:2]) &&
            all(v -> v isa Real && !(v isa Bool), values[3:4]) ||
            throw(contract_error("invalid_voltage_limits", "Expected integer target and numeric kV bounds"; detail=path))
        push!(limits, TerminalVoltageLimit(values...))
    end
    limits
end

"""Bind before solving: unknown/omitted targets cannot become a silent pass."""
function bind_operating_limits(limits::AbstractVector{TerminalVoltageLimit}, net::CompiledNetwork)
    isempty(limits) && return Tuple{TerminalVoltageLimit,Int}[]
    terminals = Dict((t.component_id, t.terminal) => t for t in net.terminal_buses)
    seen = Set{Tuple{Int,Int}}()
    bound = Tuple{TerminalVoltageLimit,Int}[]
    for limit in limits
        target = (limit.component_id, limit.terminal)
        target in seen && throw(contract_error("duplicate_operating_limit", "Duplicate terminal voltage limit"; detail=string(target)))
        push!(seen, target)
        terminal = get(terminals, target, nothing)
        terminal === nothing && throw(contract_error("unknown_limit_terminal", "Voltage limit references an unknown equipment terminal"; detail=string(target)))
        terminal.bus === nothing && throw(unsupported_error("omitted_limit_terminal", "Voltage assessment is unavailable for this omitted terminal"; detail="target=$target reason=$(terminal.omitted_reason)"))
        push!(bound, (limit, terminal.bus))
    end
    bound
end

function assess_operating_limits(bound, response)
    nodes = isempty(bound) ? Dict() : Dict(node["node_id"] => node for node in response["nodes"])
    checks = Dict{String,Any}[]
    for (limit, bus) in bound
        node = get(nodes, bus, nothing)
        node === nothing && throw(internal_error("limit_node_missing", "Bound limit node is missing from result"; detail="bus=$bus"))
        measured = node["voltage"]
        isfinite(measured) || throw(internal_error("limit_voltage_not_finite", "Cannot assess a non-finite voltage"))
        status = measured < limit.min_kv ? "below_min" : measured > limit.max_kv ? "above_max" : "within_bounds"
        push!(checks, Dict("component_id"=>limit.component_id, "terminal"=>limit.terminal,
            "bus_id"=>bus, "quantity"=>"line_to_line_rms_voltage", "unit"=>"kV",
            "min"=>limit.min_kv, "max"=>limit.max_kv, "measured"=>measured, "status"=>status))
    end
    Dict("schema_version"=>1, "policy"=>"explicit-terminal-voltage-v1",
        "status"=>isempty(checks) ? "not_declared" : any(c -> c["status"] != "within_bounds", checks) ? "violated" : "within_declared_bounds",
        "checks"=>checks, "stability_assessed"=>false)
end
