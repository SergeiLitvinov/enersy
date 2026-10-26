@testset "Independent multi-bus ZIP references (pandapower 3.5.3)" begin
    reference = JSON.parse(read(joinpath(@__DIR__, "reference", "zip-networks-v1.json"), String))
    @test reference.schema_version == 1
    @test reference.provenance.packages.pandapower == "3.5.3"
    @test Set(String(case.name) for case in reference.cases) == Set([
        "enersy-zip-9-v1", "enersy-zip-14-v1", "enersy-zip-30-v1", "enersy-zip-9-v1-q-clamp"])
    for (file, key) in (("generate_zip.py", :generator_sha256), ("ac-networks-v1.json", :input_sha256), ("requirements-zip.txt", :requirements_sha256))
        canonical = replace(read(joinpath(@__DIR__, "reference", file), String), "\r\n" => "\n")
        @test bytes2hex(EC.sha256(canonical)) == reference.provenance[key]
    end
    for case in reference.cases
        @testset "$(case.name)" begin
            cs, es, _, _, base, options, _ = EC.parse_calculate_request(case.scheme)
            @test case.constant_pq_voltage_difference_pu > 1e-6
            @test maximum(abs, case.reference_balance_residual_mw_mvar) < 1e-6
            function compare(result; idmap=identity)
                expected = case.expected
                errors = zeros(4)
                for node in expected.nodes
                    actual = only(n for n in result["nodes"] if idmap(Int(node.component_id)) in n["members"] && n["is_internal_source_node"] == node.internal)
                    errors = max.(errors, abs.([actual["voltage"] / 110 - node.v_pu,
                        actual["angle_rad"] - node.theta_rad, actual["p_mw"] / 100 - node.p_pu, actual["q_mvar"] / 100 - node.q_pu]))
                end
                @info "Independent ZIP comparison" case=case.name errors=(voltage=errors[1], angle=errors[2], active=errors[3], reactive=errors[4]) iterations=result["iterations"]
                @test maximum(errors) < 1e-8
                @test result["success"] && result["solver"]["matrix_storage"] == "csc"
                @test result["node_count"] == length(expected.nodes)
                @test length(result["loads"]) == length(expected.loads)
                for load in expected.loads
                    actual = only(l for l in result["loads"] if l["component_id"] == idmap(Int(load.component_id)))
                    @test actual["profile"] == "zip"
                    @test actual["p_mw"] ≈ load.p_mw atol=1e-6 rtol=0
                    @test actual["q_mvar"] ≈ load.q_mvar atol=1e-6 rtol=0
                    @test actual["voltage_kv"] ≈ load.voltage_kv atol=1e-6 rtol=0
                    bus = only(n for n in result["nodes"] if actual["component_id"] in n["members"] && !n["is_internal_source_node"])
                    @test actual["bus"] == bus["node_id"]
                end
                @test length(result["branches"]) == length(expected.branches)
                for branch in expected.branches
                    actual = only(b for b in result["branches"] if b["component_id"] == idmap(Int(branch.component_id)))
                    for key in ("p_from_mw", "q_from_mvar", "p_to_mw", "q_to_mvar")
                        @test actual[key] ≈ branch[Symbol(key)] atol=1e-6 rtol=0
                    end
                    for key in ("i_from_ka", "i_to_ka")
                        @test actual[key] ≈ branch[Symbol(key)] atol=1e-8 rtol=0
                    end
                end
                for shunt in expected.shunts
                    actual = only(s for s in result["shunts"] if s["component_id"] == idmap(Int(shunt.component_id)))
                    @test actual["p_mw"] ≈ shunt.p_mw atol=1e-6 rtol=0
                    @test actual["q_mvar"] ≈ shunt.q_mvar atol=1e-6 rtol=0
                end
                for (key, external) in (
                        ("load_p_mw", -sum(l.p_mw for l in expected.loads)),
                        ("load_q_mvar", -sum(l.q_mvar for l in expected.loads)),
                        ("generation_p_mw", 100 * sum(n.p_pu for n in expected.nodes if n.internal)),
                        ("generation_q_mvar", 100 * sum(n.q_pu for n in expected.nodes if n.internal)),
                        ("branch_losses_p_mw", sum(b.p_from_mw + b.p_to_mw for b in expected.branches)),
                        ("branch_losses_q_mvar", sum(b.q_from_mvar + b.q_to_mvar for b in expected.branches)))
                    @test result["balance"][key] ≈ external atol=1e-6 rtol=0
                end
                @test abs(result["balance"]["residual_p_mw"]) < 1e-6
                @test abs(result["balance"]["residual_q_mvar"]) < 1e-6
                @test sort([s["component_id"] for s in result["sources"] if s["q_limit_status"] == "clamped"]) == sort(idmap.(Int.(case.q_clamped_components)))
            end
            compare(calculate(cs, es; base, options))
            # Same physical circuit after a common-base change, not only a reorder.
            compare(calculate(cs, es; base=BaseSystem(50, 220, "reference-invariance"), options))
            remap(id) = 100000 - 7id
            moved = [RawComponent(remap(c.id), c.code, copy(c.params), -73.0*c.id, 19.0*c.id, 270) for c in reverse(cs)]
            rewired = [RawConnection(remap(e.to), remap(e.from), e.to_port, e.from_port) for e in reverse(es)]
            compare(calculate(moved, rewired; base, options); idmap=remap)
            response = handle_request(HTTP.Request("POST", "/calculate", [], JSON.json(case.scheme)))
            @test response.status == 200
            compare(JSON.parse(response.body))
        end
    end
end
