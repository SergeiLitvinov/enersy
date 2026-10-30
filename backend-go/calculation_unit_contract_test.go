package main

import (
	"context"
	"encoding/json"
	"errors"
	"math"
	"net/url"
	"os"
	"strconv"
	"testing"
)

func TestStudyUnitContractWorkerPostgres(t *testing.T) {
	worker := os.Getenv("TEST_PARAMETER_UNIT_WORKER_URL")
	if worker == "" {
		t.Skip("Set TEST_PARAMETER_UNIT_WORKER_URL for real strict-unit Study execution")
	}
	f := newStudyFixture(t)
	f.doc.UnitContract = &inputUnitContract{1, acInputUnitProfile}
	f.doc.Limits = []terminalVoltageLimit{}
	ctx := context.Background()
	var busbar int
	if err := f.store.database.QueryRow(`INSERT INTO scheme_components(scheme_id,component_type_id,pos_x,pos_y,rotation) SELECT $1,id,0,0,0 FROM component_types WHERE code='busbar' RETURNING id`, f.scheme).Scan(&busbar); err != nil {
		t.Fatal(err)
	}
	if _, err := f.store.database.Exec(`INSERT INTO scheme_connections(scheme_id,from_component_id,to_component_id,from_port,to_port) VALUES($1,$2,$3,'top','left')`, f.scheme, f.load, busbar); err != nil {
		t.Fatal(err)
	}
	if err := f.store.database.QueryRow(`SELECT topology_revision FROM circuit_schemes WHERE id=$1`, f.scheme).Scan(&f.topology); err != nil {
		t.Fatal(err)
	}
	if _, err := f.store.database.Exec(`UPDATE scheme_component_params SET unit_format_version=1,declared_unit='MW' WHERE scheme_component_id=$1 AND param_key='p';`, f.load); err != nil {
		t.Fatal(err)
	}
	if _, err := f.store.database.Exec(`UPDATE component_params_template SET unit='W' WHERE component_type_id=(SELECT component_type_id FROM scheme_components WHERE id=$1) AND param_key='p'`, f.load); err != nil {
		t.Fatal(err)
	}
	v, err := f.store.SaveStudy(ctx, f.tokens[0].Token, f.project, f.scheme, 0, 0, f.topology, studyCommand(8201), f.doc)
	if err != nil {
		t.Fatal(err)
	}
	id, _ := strconv.ParseInt(v.ID, 10, 64)
	if _, err = f.store.EnqueueStudyRun(ctx, f.tokens[0].Token, f.project, id, 1, studyCommand(8202)); err != nil {
		t.Fatal(err)
	}
	claim := runClaim(t, f, 8203)
	if _, err = f.store.database.Exec(`UPDATE component_params_template SET unit='W' WHERE param_key='p';
UPDATE scheme_component_params SET param_value='0.1' WHERE param_key='p'`); err != nil {
		t.Fatal(err)
	}
	executeStudyRun(ctx, f.store, worker, claim)
	run, err := f.store.ReadStudyRun(ctx, f.tokens[0].Token, f.project, claim.ID)
	if err != nil || run.Status != "succeeded" || run.InputSHA256 != v.InputSHA256 {
		t.Fatal(run, err)
	}
	archive, _ := strconv.ParseInt(run.ArchiveID, 10, 64)
	_, input, body, err := f.store.CalculationArchive(ctx, f.tokens[0].Token, f.project, archive)
	if err != nil || archiveDigest(input) != v.InputSHA256 || !confirmsRequestedUnitContract(input, body) {
		t.Fatal("strict immutable archive mismatch", err)
	}
	var result struct {
		Nodes []struct {
			Voltage  float64 `json:"voltage"`
			Internal bool    `json:"is_internal_source_node"`
		} `json:"nodes"`
	}
	if json.Unmarshal(body, &result) != nil {
		t.Fatal("invalid worker result")
	}
	physical := 0
	for _, node := range result.Nodes {
		if !node.Internal {
			physical++
			if math.Abs(node.Voltage-(1+math.Sqrt(.2))/2) > 1e-10 {
				t.Fatal("used current values instead of frozen strict input", node.Voltage)
			}
		}
	}
	if physical != 1 {
		t.Fatal("wrong physical bus count", physical)
	}
}

func TestInputUnitContractAdmissionAndConfirmation(t *testing.T) {
	valid := `{"formatVersion":1,"profile":"legacy-ac-three-phase-rms-v1"}`
	var contract inputUnitContract
	if err := json.Unmarshal([]byte(valid), &contract); err != nil {
		t.Fatal(err)
	}
	for _, raw := range []string{`null`, `[]`, `{}`, `{"formatVersion":1}`, `{"formatVersion":true,"profile":"legacy-ac-three-phase-rms-v1"}`,
		`{"formatVersion":1.0,"profile":"legacy-ac-three-phase-rms-v1"}`, `{"formatVersion":2,"profile":"legacy-ac-three-phase-rms-v1"}`,
		`{"formatVersion":1,"profile":"unknown"}`, `{"formatVersion":1,"profile":"legacy-ac-three-phase-rms-v1","extra":1}`,
		`{"formatVersion":1,"formatVersion":1,"profile":"legacy-ac-three-phase-rms-v1"}`} {
		if json.Unmarshal([]byte(raw), &contract) == nil {
			t.Fatal("invalid unit contract accepted", raw)
		}
	}
	if value, err := calculationUnitContractOption(url.Values{}); err != nil || value != nil {
		t.Fatal(value, err)
	}
	if value, err := calculationUnitContractOption(url.Values{"unitContract": {acInputUnitProfile}}); err != nil || value.Profile != acInputUnitProfile {
		t.Fatal(value, err)
	}
	for _, values := range [][]string{{}, {""}, {"unknown"}, {acInputUnitProfile, acInputUnitProfile}} {
		if _, err := calculationUnitContractOption(url.Values{"unitContract": values}); err == nil {
			t.Fatal("invalid selection accepted", values)
		}
	}
	request := []byte(`{"unitContract":` + valid + `,"components":[{"params":{"p":"10","q":"3"}}]}`)
	confirmation := map[string]any{"formatVersion": 1, "profile": acInputUnitProfile, "validation_scope": "request-declarations-only", "component_count": 1, "parameter_count": 2}
	result := func(value any) []byte {
		body, err := json.Marshal(map[string]any{"input_unit_contract": value})
		if err != nil {
			t.Fatal(err)
		}
		return body
	}
	if !confirmsRequestedUnitContract(request, result(confirmation)) {
		t.Fatal("valid confirmation rejected")
	}
	for key, value := range map[string]any{"formatVersion": 2, "profile": "wrong", "validation_scope": "historically-certified", "component_count": 0, "parameter_count": 1} {
		changed := map[string]any{}
		for k, v := range confirmation {
			changed[k] = v
		}
		changed[key] = value
		if confirmsRequestedUnitContract(request, result(changed)) {
			t.Fatal("changed confirmation accepted", key)
		}
		delete(changed, key)
		if confirmsRequestedUnitContract(request, result(changed)) {
			t.Fatal("missing confirmation field accepted", key)
		}
	}
	if confirmsRequestedUnitContract(request, []byte(`{"success":true}`)) {
		t.Fatal("old worker silently downgraded strict units")
	}
	if !confirmsRequestedUnitContract([]byte(`{}`), []byte(`{"success":true}`)) {
		t.Fatal("legacy request changed")
	}
}

func TestCompleteUnitEncodingPreservesEmptyDeclarations(t *testing.T) {
	components := []calculationComponent{{ID: 1, Type: "busbar", Params: map[string]string{}}, {ID: 2, Type: "load", Params: map[string]string{"p": "1.2300"}, ParameterUnits: map[string]string{"p": "MW"}}}
	for _, contract := range []*inputUnitContract{nil, {1, acInputUnitProfile}} {
		payload := map[string]any{"components": components}
		applyInputUnitContract(payload, contract, components)
		body, err := json.Marshal(payload)
		if err != nil {
			t.Fatal(err)
		}
		var decoded struct {
			Components []map[string]json.RawMessage `json:"components"`
		}
		if err := json.Unmarshal(body, &decoded); err != nil {
			t.Fatal(err)
		}
		if contract == nil {
			if _, exists := decoded.Components[0]["parameterUnits"]; exists {
				t.Fatal("legacy encoding changed")
			}
		} else if string(decoded.Components[0]["parameterUnits"]) != "{}" || string(decoded.Components[1]["parameterUnits"]) != `{"p":"MW"}` {
			t.Fatal("complete encoding lost empty declaration or existing labels", string(body))
		}
	}
	if components[0].ParameterUnits != nil || components[1].Params["p"] != "1.2300" {
		t.Fatal("encoding changed source values")
	}
}

func TestStrictStudyCapturesIncompleteUnitsForInspectionPostgres(t *testing.T) {
	f := newStudyFixture(t)
	f.doc.UnitContract = &inputUnitContract{1, acInputUnitProfile}
	if _, err := f.store.database.Exec(`INSERT INTO scheme_component_params(scheme_component_id,param_key,param_value) VALUES($1,'draft_parameter','1.2300')`, f.load); err != nil {
		t.Fatal(err)
	}
	v, err := f.store.SaveStudy(context.Background(), f.tokens[0].Token, f.project, f.scheme, 0, 0, f.topology, studyCommand(8301), f.doc)
	if err != nil {
		t.Fatal(err)
	}
	id, _ := strconv.ParseInt(v.ID, 10, 64)
	_, frozen, err := f.store.ReadStudy(context.Background(), f.tokens[0].Token, f.project, id, 1, "input")
	if err != nil {
		t.Fatal(err)
	}
	var input struct {
		Components []calculationComponent `json:"components"`
	}
	if err := json.Unmarshal(frozen, &input); err != nil {
		t.Fatal(err)
	}
	found := false
	for _, component := range input.Components {
		if component.ID == f.load {
			found = component.Params["draft_parameter"] == "1.2300"
			if _, invented := component.ParameterUnits["draft_parameter"]; invented {
				t.Fatal("capture invented a unit for an unsupported draft parameter")
			}
		}
	}
	if !found {
		t.Fatal("incomplete draft could not be inspected in its frozen input")
	}
}

func TestStudyUnitContractFrozenAndRunConfirmationPostgres(t *testing.T) {
	f := newStudyFixture(t)
	f.doc.UnitContract = &inputUnitContract{1, acInputUnitProfile}
	f.doc.Limits = []terminalVoltageLimit{}
	ctx := context.Background()
	v, err := f.store.SaveStudy(ctx, f.tokens[0].Token, f.project, f.scheme, 0, 0, f.topology, studyCommand(8101), f.doc)
	if err != nil {
		t.Fatal(err)
	}
	id, _ := strconv.ParseInt(v.ID, 10, 64)
	_, frozen, err := f.store.ReadStudy(ctx, f.tokens[0].Token, f.project, id, 1, "input")
	if err != nil {
		t.Fatal(err)
	}
	var input struct {
		UnitContract *inputUnitContract     `json:"unitContract"`
		Components   []calculationComponent `json:"components"`
	}
	if json.Unmarshal(frozen, &input) != nil || input.UnitContract == nil || v.Document.UnitContract == nil {
		t.Fatal("contract lost from frozen Study")
	}
	if _, err = f.store.database.Exec(`UPDATE component_params_template SET unit='W' WHERE param_key='p'`); err != nil {
		t.Fatal(err)
	}
	replay, err := f.store.SaveStudy(ctx, f.tokens[0].Token, f.project, f.scheme, 0, 0, f.topology, studyCommand(8101), f.doc)
	if err != nil || replay.InputSHA256 != v.InputSHA256 {
		t.Fatal("replay recaptured current units", replay, err)
	}
	_, again, err := f.store.ReadStudy(ctx, f.tokens[0].Token, f.project, id, 1, "input")
	if err != nil || string(again) != string(frozen) {
		t.Fatal("frozen unit declarations changed", err)
	}
	changed := f.doc
	changed.UnitContract = nil
	if _, err = f.store.SaveStudy(ctx, f.tokens[0].Token, f.project, f.scheme, 0, 0, f.topology, studyCommand(8101), changed); !errors.Is(err, errStudyCommand) {
		t.Fatal("same command downgraded unit policy", err)
	}
	if _, err = f.store.EnqueueStudyRun(ctx, f.tokens[0].Token, f.project, id, 1, studyCommand(8102)); err != nil {
		t.Fatal(err)
	}
	claim := runClaim(t, f, 8103)
	if string(claim.Input) != string(frozen) {
		t.Fatal("queue changed frozen input")
	}
	startRun(t, f, claim)
	if _, err = f.store.CompleteStudyRun(ctx, claim, []byte(runTransportResult)); !errors.Is(err, errArchiveResult) {
		t.Fatal("unconfirmed strict result archived", err)
	}
	var result map[string]any
	if json.Unmarshal([]byte(runTransportResult), &result) != nil {
		t.Fatal("invalid transport fixture")
	}
	parameters := 0
	for _, c := range input.Components {
		parameters += len(c.Params)
	}
	result["input_unit_contract"] = map[string]any{"formatVersion": 1, "profile": acInputUnitProfile, "validation_scope": "request-declarations-only", "component_count": len(input.Components), "parameter_count": parameters}
	body, _ := json.Marshal(result)
	if _, err = f.store.CompleteStudyRun(ctx, claim, body); err != nil {
		t.Fatal("confirmed strict result rejected", err)
	}
}
