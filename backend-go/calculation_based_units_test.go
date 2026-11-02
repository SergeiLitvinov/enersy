package main

import (
	"context"
	"encoding/json"
	"math"
	"os"
	"strconv"
	"testing"
)

func TestBasedUnitContractCaptureAndConfirmation(t *testing.T) {
	base := &parameterBase{parameterBaseProfile, 10, 35}
	component := calculationComponent{ID: 1, Type: "generator", Params: map[string]string{"x": ".1000", "r": "0"}, ParameterUnits: map[string]string{"x": "Ohm", "r": "Ohm"},
		DeclaredParameterUnits: &parameterUnitDeclaration{FormatVersion: 2, Units: map[string]string{"x": "p.u."}, Bases: map[string]*parameterBase{"x": base}}}
	payload := map[string]any{}
	applyInputUnitContract(payload, &inputUnitContract{1, basedACInputUnitProfile}, []calculationComponent{component})
	raw, err := json.Marshal(payload)
	if err != nil {
		t.Fatal(err)
	}
	var input struct{ Components []calculationComponent }
	if err := json.Unmarshal(raw, &input); err != nil {
		t.Fatal(err)
	}
	c := input.Components[0]
	if c.Params["x"] != ".1000" || len(c.ParameterUnits) != 1 || c.ParameterUnits["x"] != "p.u." || c.ParameterBases["x"] == nil || *c.ParameterBases["x"] != *base {
		t.Fatal("basis lost or template label inferred", string(raw))
	}
	confirmation := map[string]any{"formatVersion": 1, "profile": basedACInputUnitProfile, "validation_scope": "request-declarations-with-parameter-bases", "component_count": 1, "parameter_count": 2, "basis_count": 1}
	result := func() []byte {
		t.Helper()
		encoded, err := json.Marshal(map[string]any{"input_unit_contract": confirmation})
		if err != nil {
			t.Fatal(err)
		}
		return encoded
	}
	if !confirmsRequestedUnitContract(raw, result()) {
		t.Fatal("valid based acknowledgement rejected")
	}
	for _, bad := range []any{nil, 0, 2, "1", 1.5} {
		confirmation["basis_count"] = bad
		if confirmsRequestedUnitContract(raw, result()) {
			t.Fatal("accepted incorrect basis coverage", bad)
		}
	}
	delete(confirmation, "basis_count")
	if confirmsRequestedUnitContract(raw, result()) {
		t.Fatal("old worker claimed based normalization")
	}
	// An explicitly empty map must be sent for a component with no source bases.
	component.DeclaredParameterUnits = nil
	applyInputUnitContract(payload, &inputUnitContract{1, basedACInputUnitProfile}, []calculationComponent{component})
	raw, err = json.Marshal(payload)
	if err != nil {
		t.Fatal(err)
	}
	var empty struct{ Components []map[string]json.RawMessage }
	if err := json.Unmarshal(raw, &empty); err != nil || string(empty.Components[0]["parameterBases"]) != "{}" || string(empty.Components[0]["parameterUnits"]) != "{}" {
		t.Fatal("missing evidence was inferred", string(raw), err)
	}
}

func TestBasedStudyUnitContractWorkerPostgres(t *testing.T) {
	worker := os.Getenv("TEST_PARAMETER_UNIT_WORKER_URL")
	if worker == "" {
		t.Skip("requires isolated Julia worker")
	}
	f := newStudyFixture(t)
	f.doc.UnitContract = &inputUnitContract{1, basedACInputUnitProfile}
	f.doc.Limits = []terminalVoltageLimit{}
	f.doc.Base = studyBase{50, 20}
	ctx := context.Background()
	// Physical independent circuit: E_LL=1 kV, Z_phase=1 Ohm, P_3phase=.2 MW.
	// Source coefficient bases are 10 MVA / 10 kV, distinct from the Study's.
	if _, err := f.store.database.Exec(`UPDATE scheme_component_params SET
param_value=CASE param_key WHEN 'p' THEN '0.0200' WHEN 'q' THEN '0' WHEN 'r' THEN '0.1000' WHEN 'x' THEN '0' ELSE '0.1000' END,
unit_format_version=1,declared_unit='p.u.',per_unit_base_profile='ac-three-phase-rms-v1',per_unit_s_base_mva=10,per_unit_v_base_kv=10
WHERE scheme_component_id IN (SELECT id FROM scheme_components WHERE scheme_id=$1)`, f.scheme); err != nil {
		t.Fatal(err)
	}
	v, err := f.store.SaveStudy(ctx, f.tokens[0].Token, f.project, f.scheme, 0, 0, f.topology, studyCommand(8401), f.doc)
	if err != nil {
		t.Fatal(err)
	}
	id, err := strconv.ParseInt(v.ID, 10, 64)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := f.store.EnqueueStudyRun(ctx, f.tokens[0].Token, f.project, id, 1, studyCommand(8402)); err != nil {
		t.Fatal(err)
	}
	claim := runClaim(t, f, 8403)
	// The worker must not read today's coefficient, its basis, or catalog labels.
	if _, err := f.store.database.Exec(`UPDATE scheme_component_params SET param_value='999',per_unit_s_base_mva=100,per_unit_v_base_kv=35; UPDATE component_params_template SET unit='W' WHERE param_key='p'`); err != nil {
		t.Fatal(err)
	}
	executeStudyRun(ctx, f.store, worker, claim)
	run, err := f.store.ReadStudyRun(ctx, f.tokens[0].Token, f.project, claim.ID)
	if err != nil || run.Status != "succeeded" || run.InputSHA256 != v.InputSHA256 {
		t.Fatal("based frozen Study failed", run, err)
	}
	archive, err := strconv.ParseInt(run.ArchiveID, 10, 64)
	if err != nil {
		t.Fatal(err)
	}
	_, input, body, err := f.store.CalculationArchive(ctx, f.tokens[0].Token, f.project, archive)
	if err != nil || archiveDigest(input) != v.InputSHA256 || !confirmsRequestedUnitContract(input, body) {
		t.Fatal("based archive lost its contract", err)
	}
	var frozen struct{ Components []calculationComponent }
	if err := json.Unmarshal(input, &frozen); err != nil {
		t.Fatal(err)
	}
	for _, c := range frozen.Components {
		if c.Params["p"] != "0.0200" || c.ParameterBases["p"] == nil || c.ParameterBases["p"].SBaseMVA != 10 || c.ParameterBases["p"].VBaseKV != 10 {
			t.Fatal("rewrote source bases", c)
		}
	}
	var result struct {
		Nodes []struct {
			Voltage  float64 `json:"voltage"`
			Internal bool    `json:"is_internal_source_node"`
		} `json:"nodes"`
	}
	if err := json.Unmarshal(body, &result); err != nil {
		t.Fatal(err)
	}
	physical := 0
	for _, node := range result.Nodes {
		if !node.Internal {
			physical++
			if math.Abs(node.Voltage-(1+math.Sqrt(.2))/2) > 1e-9 {
				t.Fatal("independent based voltage mismatch", node.Voltage)
			}
		}
	}
	if physical != 1 {
		t.Fatal("wrong physical node count", physical)
	}
}
