package main

import (
	"context"
	"encoding/json"
	"math"
	"net/url"
	"os"
	"strconv"
	"testing"
)

func TestScaledStudyUnitContractWorkerPostgres(t *testing.T) {
	worker := os.Getenv("TEST_PARAMETER_UNIT_WORKER_URL")
	if worker == "" {
		t.Skip("requires isolated Julia worker")
	}
	f := newStudyFixture(t)
	f.doc.UnitContract = &inputUnitContract{1, scaledACInputUnitProfile}
	f.doc.Limits = []terminalVoltageLimit{}
	ctx := context.Background()
	// Independent circuit: E_LL=1000 V, Z_phase=1000 mOhm, P_3phase=200000 W.
	// The high-voltage solution is (1+sqrt(1-4*.2))/2 kV on a 1 kV base.
	if _, err := f.store.database.Exec(`UPDATE scheme_component_params SET
param_value=CASE param_key WHEN 'p' THEN '200000.0000' WHEN 'q' THEN '0' WHEN 'r' THEN '1000' WHEN 'x' THEN '0' ELSE '1000' END,
unit_format_version=1,declared_unit=CASE param_key WHEN 'p' THEN 'W' WHEN 'q' THEN 'var' WHEN 'r' THEN 'mOhm' WHEN 'x' THEN 'mOhm' ELSE 'V' END
WHERE scheme_component_id IN (SELECT id FROM scheme_components WHERE scheme_id=$1)`, f.scheme); err != nil {
		t.Fatal(err)
	}
	v, err := f.store.SaveStudy(ctx, f.tokens[0].Token, f.project, f.scheme, 0, 0, f.topology, studyCommand(8301), f.doc)
	if err != nil {
		t.Fatal(err)
	}
	id, err := strconv.ParseInt(v.ID, 10, 64)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = f.store.EnqueueStudyRun(ctx, f.tokens[0].Token, f.project, id, 1, studyCommand(8302)); err != nil {
		t.Fatal(err)
	}
	claim := runClaim(t, f, 8303)
	if _, err = f.store.database.Exec(`UPDATE scheme_component_params SET param_value='0.1',unit_format_version=NULL,declared_unit=NULL WHERE param_key='p'; UPDATE component_params_template SET unit='mW' WHERE param_key='p'`); err != nil {
		t.Fatal(err)
	}
	executeStudyRun(ctx, f.store, worker, claim)
	run, err := f.store.ReadStudyRun(ctx, f.tokens[0].Token, f.project, claim.ID)
	if err != nil || run.Status != "succeeded" || run.InputSHA256 != v.InputSHA256 {
		t.Fatal("scaled immutable Study failed", run, err)
	}
	archive, err := strconv.ParseInt(run.ArchiveID, 10, 64)
	if err != nil {
		t.Fatal(err)
	}
	_, input, body, err := f.store.CalculationArchive(ctx, f.tokens[0].Token, f.project, archive)
	if err != nil || archiveDigest(input) != v.InputSHA256 || !confirmsRequestedUnitContract(input, body) {
		t.Fatal("scaled archive lost its contract", err)
	}
	var captured struct{ Components []calculationComponent }
	if json.Unmarshal(input, &captured) != nil || len(captured.Components) != 2 {
		t.Fatal("invalid original capture")
	}
	for _, c := range captured.Components {
		if c.Params["p"] != "200000.0000" || c.ParameterUnits["p"] != "W" || c.DeclaredParameterUnits == nil || c.DeclaredParameterUnits.Units["p"] != "W" {
			t.Fatal("rewrote frozen values or guessed units", c)
		}
	}
	var result struct {
		Nodes []struct {
			Voltage  float64 `json:"voltage"`
			Internal bool    `json:"is_internal_source_node"`
		} `json:"nodes"`
	}
	if json.Unmarshal(body, &result) != nil {
		t.Fatal("invalid physical result")
	}
	count := 0
	for _, node := range result.Nodes {
		if !node.Internal {
			count++
			if math.Abs(node.Voltage-(1+math.Sqrt(.2))/2) > 1e-10 {
				t.Fatal("independent scaled voltage mismatch", node.Voltage)
			}
		}
	}
	if count != 1 {
		t.Fatal("wrong physical node count", count)
	}
}

func TestScaledUnitProfileNeverInfersCatalogUnits(t *testing.T) {
	contract, err := calculationUnitContractOption(url.Values{"unitContract": {scaledACInputUnitProfile}})
	if err != nil || contract.Profile != scaledACInputUnitProfile {
		t.Fatal("scaled profile not accepted", err)
	}
	component := calculationComponent{ID: 1, Type: "load", Params: map[string]string{"p": "10000000.0000", "q": "3"},
		ParameterUnits:         map[string]string{"p": "MW", "q": "Mvar"},
		DeclaredParameterUnits: &parameterUnitDeclaration{1, map[string]string{"p": "W"}}}
	payload := map[string]any{}
	applyInputUnitContract(payload, contract, []calculationComponent{component})
	wire, err := json.Marshal(payload)
	if err != nil {
		t.Fatal(err)
	}
	var captured struct{ Components []calculationComponent }
	if json.Unmarshal(wire, &captured) != nil || len(captured.Components) != 1 {
		t.Fatal("invalid capture")
	}
	if len(captured.Components[0].ParameterUnits) != 1 || captured.Components[0].ParameterUnits["p"] != "W" || captured.Components[0].Params["p"] != "10000000.0000" {
		t.Fatal("inferred catalog units or rewrote original value", string(wire))
	}
	confirmation := map[string]any{"formatVersion": 1, "profile": scaledACInputUnitProfile, "validation_scope": "request-declarations-with-scale-normalization", "component_count": 1, "parameter_count": 2}
	result := func() []byte {
		encoded, encodeErr := json.Marshal(map[string]any{"input_unit_contract": confirmation})
		if encodeErr != nil {
			t.Fatal(encodeErr)
		}
		return encoded
	}
	if !confirmsRequestedUnitContract(wire, result()) {
		t.Fatal("scaled acknowledgement rejected")
	}
	confirmation["validation_scope"] = "request-declarations-only"
	if confirmsRequestedUnitContract(wire, result()) {
		t.Fatal("declarations-only worker claimed normalization")
	}
	confirmation["validation_scope"] = "request-declarations-with-scale-normalization"
	confirmation["profile"] = acInputUnitProfile
	if confirmsRequestedUnitContract(wire, result()) {
		t.Fatal("wrong profile accepted")
	}
	if component.ParameterUnits["p"] != "MW" || component.ParameterUnits["q"] != "Mvar" {
		t.Fatal("capture mutated source metadata")
	}
}
