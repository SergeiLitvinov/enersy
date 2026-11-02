const STARTUP_PREPARATION_PROFILE = "ac-pq-zip-pv-v1"

"""Small, explicit, synthetic workloads; never stored as user engineering results.

Values use the existing AC contract: kV line-to-line RMS, three-phase MW/Mvar/MVA,
Ohm/phase, Ohm/km and km. Profiles exercise source, switch, line, transformer,
shunt, PQ and ZIP/PV paths. They are compilation preparation, not performance
or model-accuracy benchmarks; independent numerical references remain in tests.
"""
function startup_workloads()
    component(id, code, params) = Dict("id"=>id, "type"=>code, "params"=>params)
    wire(a, b, from, to) = Dict("from"=>a,"to"=>b,"fromPort"=>from,"toPort"=>to)
    components = [
        component(1,"generator",Dict("voltage_nom"=>"110","e"=>"113.3","p"=>"0","r"=>"0.1","x"=>"0.5","is_slack"=>"true")),
        component(2,"breaker",Dict("status"=>"true","voltage_nom"=>"110")),
        component(3,"busbar",Dict("voltage_nom"=>"110")),
        component(4,"transformer",Dict("power_nom"=>"100","voltage_hv"=>"110","voltage_lv"=>"10","p_kz"=>"1","u_kz"=>"10","p_xx"=>"0.1","i_xx"=>"1")),
        component(5,"transmission_line",Dict("voltage_nom"=>"10","length"=>"1","r0"=>"0.1","x0"=>"0.2")),
        component(6,"load",Dict("voltage_nom"=>"10","p"=>"10","q"=>"3")),
        component(7,"capacitor",Dict("voltage_nom"=>"10","q_nom"=>"0.1")),
        component(8,"reactor",Dict("voltage_nom"=>"10","q_nom"=>"0.1")),
    ]
    wires = [wire(1,2,"bottom","top"),wire(2,3,"bottom","left"),wire(3,4,"right","top"),
             wire(4,5,"bottom","left"),wire(5,6,"right","top"),wire(6,7,"top","top"),wire(6,8,"top","top")]
    pq = Dict{String,Any}("components"=>components,"connections"=>wires,
        "modelGroup"=>"three-phase","method"=>"newton-raphson",
        "base"=>Dict("s_base_mva"=>100,"v_base_kv"=>110),
        "operatingLimits"=>[Dict("component_id"=>6,"terminal"=>1,"min_kv"=>8,"max_kv"=>12)])
    zip = deepcopy(pq)
    merge!(zip["components"][6]["params"],Dict("zip_enabled"=>"true",
        "zip_p_z"=>"0.2","zip_p_i"=>"0.3","zip_p_p"=>"0.5",
        "zip_q_z"=>"0.3","zip_q_i"=>"0.2","zip_q_p"=>"0.5"))
    push!(zip["components"],component(9,"generator",Dict("voltage_nom"=>"10","e"=>"10.2","p"=>"1","r"=>"0.1","x"=>"0.5")))
    push!(zip["connections"],wire(9,6,"bottom","top"))
    return (pq, zip)
end

"""Prepare every configured backend before binding a listening socket.

Compilation belongs to process startup. The internal calculation has its own
fresh, unbounded cooperative control; no user token or deadline is reset. Then
the normal HTTP handler must succeed with the unchanged request budget. Failure
aborts startup; no backend is silently dropped and no ready response is served.
"""
function prepare_worker(backends)
    ids = [backend.id for backend in backends]
    isempty(ids) && error("Worker requires at least one compute backend")
    length(unique(ids)) == length(ids) || error("Worker backend IDs must be unique")
    started = time_ns()
    @info "Preparing calculation worker" profile=STARTUP_PREPARATION_PROFILE backends=ids
    for backend in backends, workload in startup_workloads()
        body = merge(workload, Dict("computeBackend"=>backend.id))
        request = HTTP.Request("POST","/calculate",[],JSON.json(body))
        json = read_json_body(request)
        components, connections, group, method, base, options, default_s =
            parse_calculate_request(json; default_s_base_mva=default_s_base_mva())
        result = calculate(components, connections; model_group=group, method,
            base, options, default_s_base_mva=default_s, backend,
            control=CalculationControl(), operating_limits=request_operating_limits(json))
        result["success"] === true || error("Worker preparation calculation failed")
        response = handle_request(HTTP.Request("POST","/calculate",[],JSON.json(body)); backends)
        response.status == 200 || error("Worker preparation HTTP check failed for backend $(backend.id), status $(response.status)")
        checked = JSON.parse(response.body)
        checked.success === true && checked.solver.execution.max_time_ms == HTTP_CALCULATION_BUDGET_MS ||
            error("Worker preparation changed the request budget or returned no result")
    end
    @info "Calculation worker prepared" profile=STARTUP_PREPARATION_PROFILE backends=ids elapsed_ms=Float64(time_ns()-started)/1e6
    nothing
end
