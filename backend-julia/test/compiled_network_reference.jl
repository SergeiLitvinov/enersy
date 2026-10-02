@testset "Compiled multi-source physical networks against PYPOWER" begin
    references = JSON3.read(read(joinpath(@__DIR__, "reference", "ac-networks-v1.json"), String)).compiled_networks
    server = start_server(; host="127.0.0.1", port=0)
    try
        url = "http://127.0.0.1:$(HTTP.port(server))/calculate"
        for case in references
            @testset "$(case.name)" begin
                cs, es, group, method, base, options, _ = EC.parse_calculate_request(case.scheme)
                function compare_network(result; idmap=identity)
                    ordered = [only(filter(n -> idmap(Int(member.component_id)) in n["members"] &&
                               n["is_internal_source_node"] == member.internal, result["nodes"]))
                               for member in case.bus_equipment]
                    e = case.expected
                    errors = (v=maximum(abs, [n["voltage_pu"] for n in ordered] - e.v_pu),
                              angle=maximum(abs, [n["angle_rad"] for n in ordered] - e.theta_rad),
                              p=maximum(abs, [n["p_mw"]/100 for n in ordered] - e.p_pu),
                              q=maximum(abs, [n["q_mvar"]/100 for n in ordered] - e.q_pu))
                    @info "Compiled AC comparison" case=case.name errors iterations=result["iterations"]
                    @test errors.v < 1e-8
                    @test errors.angle < 1e-8
                    @test errors.p < 1e-8
                    @test errors.q < 1e-8
                    @test result["solver"]["slack_component"] == idmap(2000)
                    @test length(result["solver"]["pv_buses"]) == 2
                    @test abs(result["balance"]["residual_p_mw"]) < 1e-6
                    @test abs(result["balance"]["residual_q_mvar"]) < 1e-6
                    for (k, cid) in enumerate(case.branch_component_ids)
                        b = only(filter(b -> b["component_id"] == idmap(Int(cid)), result["branches"]))
                        flow = [b[key] for key in ["p_from_mw", "q_from_mvar", "p_to_mw", "q_to_mvar"]]
                        @test maximum(abs, flow - e.component_port_mw_mvar[k]) < 1e-6
                    end
                end
                result = calculate(cs, es; model_group=group, method, base, options)
                compare_network(result)
                # Bus, source and branch order change; physical identity remains explicit.
                remap(id) = 100000 - 7id
                moved = [RawComponent(remap(c.id), c.code, copy(c.params), 91.0*c.id,
                                      -37.0*c.id, 270) for c in reverse(cs)]
                rewired = [RawConnection(remap(e.from), remap(e.to), e.from_port, e.to_port)
                           for e in reverse(es)]
                compare_network(calculate(moved, rewired; base, options); idmap=remap)
                response = HTTP.post(url, ["Content-Type"=>"application/json"],
                                     JSON3.write(case.scheme); proxy=HTTP.ProxyConfig())
                @test response.status == 200
                compare_network(JSON3.read(response.body))
                # Multiple sources must never silently elect a slack by ID or input order.
                unspecified = [RawComponent(c.id, c.code,
                    Dict(k=>v for (k,v) in c.params if k != "is_slack"), c.x, c.y, c.rotation) for c in cs]
                error = try
                    calculate(unspecified, es; base, options)
                    nothing
                catch caught
                    caught
                end
                @test error isa EnersyError && error.code == "ambiguous_slack"
                if case.name == "enersy-compiled-9-v1"
                    for cid in [2000, 2001], value in ["0", "-1"]
                        invalid = [RawComponent(c.id, c.code, copy(c.params), c.x, c.y, c.rotation) for c in cs]
                        only(filter(c -> c.id == cid, invalid)).params["e"] = value
                        error = try
                            calculate(invalid, es; base, options)
                            nothing
                        catch caught
                            caught
                        end
                        @test error isa EnersyError
                        @test error isa EnersyError && error.kind == EC.CONTRACT && error.code == "invalid_parameter"
                        payload = Dict("components"=>[Dict("id"=>c.id,"type"=>c.code,"params"=>c.params) for c in invalid],
                                       "connections"=>case.scheme.connections, "base"=>case.scheme.base,
                                       "solverOptions"=>case.scheme.solverOptions)
                        rejected = HTTP.post(url, ["Content-Type"=>"application/json"], JSON3.write(payload);
                                             status_exception=false, proxy=HTTP.ProxyConfig())
                        @test rejected.status == 400
                        detail = JSON3.read(rejected.body).error_detail
                        @test detail.code == "invalid_parameter" && occursin("generator#$(cid).e", detail.detail)
                    end
                end
            end
        end
    finally
        HTTP.forceclose(server)
    end
end
