"""Declared internal-EMF Q bounds in p.u.; no implicit machine capability curve."""
function source_q_limits(sys::AcSystem, base::BaseSystem)
    limits = Dict{Int,Tuple{Float64,Float64}}()
    for source in sys.sources
        keys = ("q_min_emf_mvar", "q_max_emf_mvar")
        present = [haskey(source.params, key) for key in keys]
        any(present) || continue
        all(present) || throw(contract_error("missing_parameter", "both internal EMF Q bounds are required",
                                            detail="generator#$(source.component_id): $(join(keys, ", "))"))
        low, high = [param_number(source.params, key; unit="Mvar", owner="generator#$(source.component_id)") for key in keys]
        low <= high || throw(contract_error("invalid_parameter", "minimum Q must not exceed maximum Q",
                                           detail="generator#$(source.component_id)"))
        converted = (mva_to_pu(low, base), mva_to_pu(high, base))
        all(isfinite, converted) || throw(contract_error("invalid_parameter", "Q bounds overflow the per-unit base",
                                                        detail="generator#$(source.component_id)"))
        limits[source.bus] = converted
    end
    return limits
end

"""
PV↔PQ active set, checked after each converged power flow.
Q belongs to the internal source node; no local loads share these nodes.
Slack remains fixed. A violated declared slack Q bound is an explicit failure.
At Qmax voltage must be <= the original setpoint; at Qmin it must be >=.
Violation releases the source back to PV. Equal bounds specify fixed Q.
The same numerical tolerance is used for Q (p.u.) and voltage (p.u.).
Newton steps and active-set passes have bounded budgets; repeated active
sets fail explicitly. No machine capability curve is claimed.
"""
function solve_with_q_limits(Y, setup::PowerFlowSetup, options::SolverOptions, limits;
                             initial_v=nothing)
    current = setup
    fixed = Dict{Int,Float64}()
    events = Dict{String,Any}[]
    total = 0
    visited = Set{Tuple}()
    v, theta = initial_v, nothing
    for pass in 1:options.max_iterations
        state = Tuple(sort!(collect(fixed); by=first))
        state in visited && throw(solver_error("q_limit_active_set_cycle", "Q-limit active set repeated; voltage regulation did not stabilize"))
        push!(visited, state)
        remaining = options.max_iterations - total
        remaining > 0 || throw(solver_error("q_limit_iteration_budget", "Newton iteration budget exhausted during Q enforcement"))
        result = newton_raphson(Y, current, SolverOptions(options.tolerance, remaining);
                               initial_v=v, initial_theta=theta)
        total += result.iterations
        changed = false
        # Check already constrained sources before adding new constraints.
        # Only original PV sources can be released, never user-declared PQ.
        for (k, bus) in enumerate(setup.pv)
            haskey(fixed, bus) || continue
            low, high = limits[bus]
            low == high && continue
            target = setup.pv_v[k]
            upper = fixed[bus] == high
            release = upper ? result.v[bus] > target + options.tolerance :
                              result.v[bus] < target - options.tolerance
            if release
                delete!(fixed, bus)
                changed = true
                push!(events, Dict("bus"=>bus, "from"=>"pq", "to"=>"pv",
                    "q_before_pu"=>result.q[bus], "v_before_pu"=>result.v[bus],
                    "v_target_pu"=>target, "pass"=>pass))
            end
        end
        for bus in current.pv
            haskey(limits, bus) || continue
            low, high = limits[bus]
            q = result.q[bus]
            if q < low - options.tolerance || q > high + options.tolerance
                fixed[bus] = clamp(q, low, high)
                changed = true
                push!(events, Dict("bus"=>bus, "from"=>"pv", "to"=>"pq",
                                   "q_before_pu"=>q, "q_fixed_pu"=>fixed[bus], "pass"=>pass))
            end
        end
        if !changed
            if haskey(limits, setup.slack)
                low, high = limits[setup.slack]
                low - options.tolerance <= result.q[setup.slack] <= high + options.tolerance ||
                    throw(solver_error("slack_q_limit", "Declared slack internal EMF Q limit violated; slack reassignment is unsupported",
                                       detail="bus=$(setup.slack) q_pu=$(result.q[setup.slack]) bounds_pu=[$low,$high]"))
            end
            final = PowerFlowResult(result.v, result.theta, result.voltages, result.p, result.q,
                                    total, result.max_mismatch)
            return final, current, fixed, events, pass
        end
        keep = findall(bus -> !haskey(fixed, bus), setup.pv)
        removed = findall(bus -> haskey(fixed, bus), setup.pv)
        current = PowerFlowSetup(setup.nbus, setup.slack, setup.slack_v, setup.slack_theta,
            setup.pv[keep], vcat(setup.pq, setup.pv[removed]), setup.pv_v[keep],
            setup.p_pv[keep], vcat(setup.p_pq, setup.p_pv[removed]),
            vcat(setup.q_pq, [fixed[bus] for bus in setup.pv[removed]]))
        v, theta = result.v, result.theta
    end
    throw(solver_error("q_limit_active_set_budget", "Q-limit active-set pass budget exhausted"))
end
