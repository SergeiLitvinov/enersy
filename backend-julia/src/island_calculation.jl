"""Partition once in O(buses + branches + injections), retaining provenance.

Each local system has contiguous solver indices; map[local] is the original
compiled bus index. Physical parameters and base are unchanged. No new
conductance, source or cross-island reference is introduced.
"""
function split_ac_islands(sys::AcSystem)
    groups = sort!(collect(_group_by_island(sys.buses)); by=first)
    local_index = zeros(Int, length(sys.buses))
    for (_, indices) in groups
        sort!(indices)
        for (local_id, global_id) in enumerate(indices)
            local_index[global_id] = local_id
        end
    end
    branches = Dict(id => BranchModel[] for (id, _) in groups)
    shunts = Dict(id => ShuntModel[] for (id, _) in groups)
    injections = Dict(id => Injection[] for (id, _) in groups)
    for m in sys.branch_models
        id = sys.buses[m.from_bus].island
        id == sys.buses[m.to_bus].island || throw(internal_error("inconsistent_island", "Branch crosses compiled islands"))
        push!(branches[id], BranchModel(m.component_id, m.code, local_index[m.from_bus],
            local_index[m.to_bus], m.ratio, m.y_series, m.y_from, m.y_to, m.owner))
    end
    for s in sys.shunts
        id = sys.buses[s.bus].island
        push!(shunts[id], ShuntModel(s.component_id, s.code, local_index[s.bus],
                                    s.y_pu, s.q_nom_mvar, s.owner))
    end
    for s in sys.injections
        id = sys.buses[s.bus].island
        push!(injections[id], Injection(s.component_id, s.code, local_index[s.bus], s.kind,
            s.p_mw, s.q_mvar, s.params, s.v_spec_kv, s.has_v_spec, s.is_slack))
    end
    return [(id, indices, AcSystem(
        [Bus(local_index[i], b.members, b.codes, b.v_nom_kv, b.v_nom_complete,
             b.is_switch_only, b.island) for i in indices for b in (sys.buses[i],)],
        branches[id], shunts[id], injections[id],
        [s for s in injections[id] if s.kind === :source], String[], String[]))
        for (id, indices) in groups]
end

"""Restore global compiled bus IDs in all structured result references."""
function restore_bus_ids!(response, map, island)
    for node in response["nodes"]; node["node_id"] = map[node["node_id"]]; end
    for branch in response["branches"]
        for key in ("from_bus", "to_bus"); branch[key] = map[branch[key]]; end
    end
    for source in response["sources"]
        for key in ("internal_bus", "terminal_bus"); source[key] = map[source[key]]; end
    end
    for shunt in response["shunts"]; shunt["bus"] = map[shunt["bus"]]; end
    for event in response["q_limit_events"]
        event["bus"] = map[event["bus"]]
        event["island_id"] = island
    end
    solver = response["solver"]
    solver["slack_bus"] = map[solver["slack_bus"]]
    for key in ("pv_buses", "pq_buses"); solver[key] = map[solver[key]]; end
    return response
end

"""Solve powered islands independently, sharing the total Newton budget.

All-or-nothing publication: one invalid/failed island fails the request.
Unpowered islands are rejected during assembly, never assigned artificial V.
Singleton slack fields remain only for a single island; the general contract
uses slack_buses/slack_components and island_results.
"""
function calculate_islands(sys::AcSystem, base::BaseSystem, options::SolverOptions,
                          entry::CapabilityEntry, model_group, method, started_ns)
    parts = split_ac_islands(sys)
    responses = Dict{String,Any}[]
    summaries = Dict{String,Any}[]
    total = 0
    for (id, map, local_sys) in parts
        remaining = options.max_iterations - total
        remaining > 0 || throw(solver_error("island_iteration_budget",
            "Общий бюджет итераций исчерпан до расчёта следующего острова", detail="island=$id"))
        response = try
            calculate_connected(local_sys, base, SolverOptions(options.tolerance, remaining), entry, model_group, method)
        catch err
            err isa EnersyError || rethrow()
            throw(EnersyError(err.kind, err.code, err.message;
                detail="island=$id global_nodes=$(join(map, ',')); " * err.detail))
        end
        restore_bus_ids!(response, map, id)
        total += response["iterations"]
        solver = response["solver"]
        push!(summaries, Dict("island_id"=>id, "bus_ids"=>map,
            "slack_bus"=>solver["slack_bus"], "slack_component"=>solver["slack_component"],
            "pv_buses"=>solver["pv_buses"], "pq_buses"=>solver["pq_buses"],
            "equations"=>solver["equations"], "unknowns"=>solver["unknowns"],
            "iterations"=>response["iterations"], "max_mismatch_pu"=>response["max_mismatch_pu"],
            "q_limit_passes"=>solver["q_limit_passes"], "balance"=>response["balance"],
            "computation_time_ms"=>response["computation_time_ms"]))
        push!(responses, response)
    end
    output = copy(first(responses))
    for key in ("nodes", "branches", "sources", "shunts", "q_limit_events")
        output[key] = vcat([r[key] for r in responses]...)
    end
    sort!(output["nodes"]; by=n -> n["node_id"])
    output["node_count"] = length(output["nodes"])
    output["iterations"] = total
    output["max_mismatch_pu"] = maximum(r["max_mismatch_pu"] for r in responses)
    output["computation_time_ms"] = (time_ns() - started_ns) / 1e6
    output["balance"] = Dict(key => sum(r["balance"][key] for r in responses)
                             for key in keys(first(responses)["balance"]))
    output["warnings"] = unique(vcat(sys.warnings, [r["warnings"] for r in responses]...))
    output["assumptions"] = unique(vcat(sys.assumptions, [r["assumptions"] for r in responses]...))
    length(parts) == 1 || push!(output["assumptions"],
        "каждый питаемый остров имеет собственный опорный угол; углы разных островов не задают физического фазового отношения")
    output["island_results"] = summaries
    solver = copy(output["solver"])
    for key in ("equations", "unknowns", "buses", "branches", "shunts", "q_limit_passes")
        solver[key] = sum(r["solver"][key] for r in responses)
    end
    for key in ("pv_buses", "pq_buses"); solver[key] = vcat([r["solver"][key] for r in responses]...); end
    solver["slack_buses"] = [r["solver"]["slack_bus"] for r in responses]
    solver["slack_components"] = [r["solver"]["slack_component"] for r in responses]
    solver["islands"] = length(parts)
    solver["max_iterations"] = options.max_iterations
    solver["iteration_budget_scope"] = "all-islands-and-q-passes"
    if length(parts) > 1
        delete!(solver, "slack_bus"); delete!(solver, "slack_component")
    end
    output["solver"] = solver
    return output
end
