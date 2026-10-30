package main

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
)

func TestParameterUnitDeclarationAdmission(t *testing.T) {
	for _, raw := range []string{`null`, `{}`, `{"formatVersion":true,"units":{"p":"MW"}}`, `{"formatVersion":1,"units":{}}`,
		`{"formatVersion":2,"units":{"p":"MW"}}`, `{"formatVersion":1,"units":{"p":null}}`, `{"formatVersion":1,"units":{"p":""}}`,
		`{"formatVersion":1,"units":{"p":" MW"}}`, `{"formatVersion":1,"units":{"p":"MW\n"}}`, `{"formatVersion":1,"units":{"p":"MW\uFEFF"}}`, `{"formatVersion":1,"units":{"q":"Mvar"}}`,
		`{"formatVersion":1,"units":{"p":"MW","p":"W"}}`, `{"formatVersion":1,"units":{"p":"MW"},"extra":1}`} {
		if _, err := parseParameterUnitDeclaration([]byte(raw), map[string]string{"p": "10"}); err == nil {
			t.Fatal("invalid declaration accepted", raw)
		}
	}
	if _, err := parseParameterUnitDeclaration([]byte(`{"formatVersion":1,"units":{"p":"МВт"}}`), map[string]string{"p": "1.2300"}); err != nil {
		t.Fatal(err)
	}
	var request componentPatchRequest
	if err := json.Unmarshal([]byte(`{"parameterUnitDeclaration":{"formatVersion":1,"units":{"p":"MW"}}}`), &request); err != nil {
		t.Fatal(err)
	}
	if _, err := parseComponentPatch(request); err == nil {
		t.Fatal("unit-only write silently adopted an old numeric value")
	}
}

func TestInstanceUnitDeclarationLifecyclePostgres(t *testing.T) {
	f := newStudyFixture(t)
	ctx := context.Background()
	current := func() (int64, string, sql.NullString) {
		t.Helper()
		var revision int64
		var value string
		var unit sql.NullString
		if err := f.store.database.QueryRow(`SELECT c.revision,p.param_value,p.declared_unit FROM scheme_components c JOIN scheme_component_params p ON p.scheme_component_id=c.id WHERE c.id=$1 AND p.param_key='p'`, f.load).Scan(&revision, &value, &unit); err != nil {
			t.Fatal(err)
		}
		return revision, value, unit
	}
	before, _, unit := current()
	if unit.Valid {
		t.Fatal("migration invented historical units")
	}
	parse := func(body string) componentPatch {
		t.Helper()
		var request componentPatchRequest
		if err := json.Unmarshal([]byte(body), &request); err != nil {
			t.Fatal(err)
		}
		patch, err := parseComponentPatch(request)
		if err != nil {
			t.Fatal(err)
		}
		return patch
	}
	patch := parse(`{"params":{"p":"0.2000"},"parameterUnitDeclaration":{"formatVersion":1,"units":{"p":"MW"}}}`)
	write := func(token string, expected int64, patch componentPatch) (int64, error) {
		return f.store.MutateComponent(ctx, token, f.project, f.scheme, f.load, expected, func(tx *sql.Tx) error { return applyComponentPatch(ctx, tx, f.load, patch) }, false)
	}
	auth := newAuthHTTP(f.store.database, "https://frontend.example", true)
	request := httptest.NewRequest(http.MethodPatch, fmt.Sprintf("/api/projects/%d/schemes/%d/components/%d", f.project, f.scheme, f.load), strings.NewReader(`{"params":{"p":"0.2000"},"parameterUnitDeclaration":{"formatVersion":1,"units":{"p":"MW"}}}`))
	request.Header.Set("Origin", auth.origin)
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("If-Match", fmt.Sprintf(`"%d"`, before))
	request.AddCookie(&http.Cookie{Name: auth.cookieName(), Value: f.tokens[0].Token})
	response := httptest.NewRecorder()
	projectsHTTP{auth: auth}.ServeHTTP(response, request)
	after, _, _ := current()
	if response.Code != 200 || after <= before || response.Header().Get("ETag") != fmt.Sprintf(`"%d"`, after) {
		t.Fatal(response.Code, response.Body.String(), after)
	}
	if _, err := write(f.tokens[0].Token, before, patch); !errors.Is(err, errComponentConflict) {
		t.Fatal("stale declaration accepted", err)
	}
	if _, err := write(f.tokens[2].Token, after, patch); !errors.Is(err, sql.ErrNoRows) {
		t.Fatal("viewer changed declaration", err)
	}
	if _, err := f.store.database.Exec(`UPDATE component_params_template SET unit='W' WHERE param_key='p'`); err != nil {
		t.Fatal(err)
	}
	input, err := readCalculationInputScope(ctx, f.store.database, f.scheme, f.project, f.tokens[0].Token, false)
	if err != nil {
		t.Fatal(err)
	}
	found := false
	for _, component := range input.Components {
		if component.ID == f.load {
			found = component.Params["p"] == "0.2000" && component.ParameterUnits["p"] == "MW" && component.DeclaredParameterUnits != nil && component.DeclaredParameterUnits.FormatVersion == 1
		}
	}
	if !found {
		t.Fatal("current template replaced explicit instance unit", input.Components)
	}
	graphResponse := httptest.NewRecorder()
	serveSchemeSnapshot(graphResponse, httptest.NewRequest(http.MethodGet, "/fixture", nil), f.store.database, f.scheme, f.project, f.tokens[0].Token)
	var graph struct {
		Components []struct {
			Declaration *parameterUnitDeclaration `json:"declaredParameterUnits"`
		} `json:"components"`
	}
	if graphResponse.Code != 200 || json.Unmarshal(graphResponse.Body.Bytes(), &graph) != nil {
		t.Fatal("graph lost unit metadata", graphResponse.Body.String())
	}
	exposed := false
	for _, component := range graph.Components {
		if component.Declaration != nil && component.Declaration.Units["p"] == "MW" {
			exposed = true
		}
	}
	if !exposed {
		t.Fatal("graph omitted explicit instance units")
	}
	f.doc.UnitContract = &inputUnitContract{1, acInputUnitProfile}
	v, err := f.store.SaveStudy(ctx, f.tokens[0].Token, f.project, f.scheme, 0, 0, f.topology, studyCommand(8401), f.doc)
	if err != nil {
		t.Fatal(err)
	}
	id, _ := strconv.ParseInt(v.ID, 10, 64)
	_, frozen, err := f.store.ReadStudy(ctx, f.tokens[0].Token, f.project, id, 1, "input")
	if err != nil {
		t.Fatal(err)
	}
	// Ordinary value edits retain the explicitly declared unit.
	after, err = write(f.tokens[0].Token, after, parse(`{"params":{"p":"0.3000"}}`))
	if err != nil {
		t.Fatal(err)
	}
	_, value, unit := current()
	if value != "0.3000" || !unit.Valid || unit.String != "MW" {
		t.Fatal(value, unit)
	}
	if _, err := f.store.database.Exec(`ALTER TABLE scheme_component_params ADD CONSTRAINT reject_unit_fixture CHECK(declared_unit<>'reject')`); err != nil {
		t.Fatal(err)
	}
	if _, err := write(f.tokens[0].Token, after, parse(`{"params":{"p":"9"},"parameterUnitDeclaration":{"formatVersion":1,"units":{"p":"reject"}}}`)); err == nil {
		t.Fatal("failing unit update committed")
	}
	revision, value, unit := current()
	if revision != after || value != "0.3000" || unit.String != "MW" {
		t.Fatal("unit failure partly changed values or revision", revision, value, unit)
	}
	_, again, err := f.store.ReadStudy(ctx, f.tokens[0].Token, f.project, id, 1, "input")
	if err != nil || string(again) != string(frozen) {
		t.Fatal("later unit/value edits changed frozen Study", err)
	}
	down, err := os.ReadFile(filepath.Join("..", "database", "migrations", "20261030001_instance_parameter_units.down.sql"))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := f.store.database.Exec(string(down)); err == nil {
		t.Fatal("downgrade discarded explicit declarations")
	}
	_, _, unit = current()
	if unit.String != "MW" {
		t.Fatal("failed downgrade lost declaration")
	}
}
