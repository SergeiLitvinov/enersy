@testset "Model definitions describe symbolic structure without inventing a study" begin
    payload = EC.model_definitions_json()
    @test payload["schema_version"] == 3
    @test payload["status"] == EC.capability_status_string(EC.capability("three-phase", "newton-raphson").status)
    @test occursin(r"^[a-f0-9]{64}$", payload["source_revision"])
    @test EC.model_definitions_json()["source_revision"] == payload["source_revision"]
    definitions = payload["definitions"]
    @test length(unique(d["id"] for d in definitions)) == 6
    for d in definitions
        ids = Set(n["id"] for n in d["nodes"])
        @test length(ids) == length(d["nodes"])
        @test all(e["from"] in ids && e["to"] in ids for e in d["edges"])
        @test !isempty(d["limitations"])
        @test !isempty(d["parameters"] )
        @test length(unique(p["key"] for p in d["parameters"] )) == length(d["parameters"] )
        terminals = sort([n["terminal"] for n in d["nodes"] if n["terminal"] > 0])
        @test terminals == collect(1:EC.terminal_count(d["equipment_type"]))
    end
    source = only(filter(d -> d["equipment_type"] == "generator", definitions))
    @test count(n -> n["terminal"] > 0, source["nodes"]) == 1
    @test Set(e["kind"] for e in source["edges"]) == Set(["impedance", "source"])
    load = only(filter(d -> d["equipment_type"] == "load", definitions))
    @test only(load["edges"])["kind"] == "pq"
    line = only(filter(d -> d["equipment_type"] == "transmission_line", definitions))
    @test count(e -> e["kind"] == "admittance", line["edges"]) == 2
    transformer = only(filter(d -> d["equipment_type"] == "transformer", definitions))
    @test Set(e["kind"] for e in transformer["edges"]) == Set(["impedance", "admittance", "transformer"])
    @test only(filter(e -> e["kind"] == "admittance", transformer["edges"]))["from"] == "hv"
    @test only(filter(e -> e["kind"] == "transformer", transformer["edges"]))["to"] == "lv"
    @test any(occursin("фазосдвиг", text) && occursin("нейтраль", text) for text in transformer["limitations"])
    for code in ("capacitor", "reactor")
        shunt = only(filter(d -> d["equipment_type"] == code, definitions))
        @test only(shunt["edges"])["kind"] == (code == "reactor" ? "impedance" : "admittance")
        @test only(shunt["edges"])["symbol"] == (code == "reactor" ? "inductor" : "capacitor")
        @test count(n -> n["terminal"] == 1, shunt["nodes"]) == 1
        @test any(occursin("нулевой последовательности", text) for text in shunt["limitations"])
    end
    response = EC.handle_request(HTTP.Request("GET", "/model-definitions"))
    @test response.status == 200
    @test JSON.parse(String(response.body)).source_revision == payload["source_revision"]
    @test EC.handle_request(HTTP.Request("POST", "/model-definitions", [], "{}")).status == 405
end
