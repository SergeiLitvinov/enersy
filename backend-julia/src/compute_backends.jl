"""Operator-supplied numerical implementation. Requests select a fixed ID;
they never supply a library path, module, function or executable source.
The solver owns all per-request native resources, including error cleanup.
"""
struct ComputeBackend{F,M}
    id::String
    solve::F
    metadata::M
end

julia_backend() = ComputeBackend("julia", solve_with_q_limits,
    (id="julia", version=VERSION, julia_version=string(Base.VERSION),
     jacobian="julia", linear_solver="umfpack"))

function select_backend(json, backends)
    raw = _json_hasfield(json, :computeBackend) ? _json_field(json, :computeBackend) : "julia"
    raw isa AbstractString || throw(contract_error("invalid_type",
        "computeBackend must be a string"; detail="\$.computeBackend"))
    requested = as_string(raw, "\$.computeBackend")
    index = findfirst(backend -> backend.id == requested, backends)
    index === nothing && throw(unsupported_error("compute_backend_unavailable",
        "Requested compute backend is unavailable"; detail="backend=$requested"))
    backends[index]
end
