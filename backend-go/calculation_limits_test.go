package main

import (
	"encoding/json"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestCalculationOperatingLimitsContract(t *testing.T) {
	valid := `{"operatingLimits":[{"component_id":2,"terminal":1,"min_kv":9.5,"max_kv":10.5}]}`
	for _, body := range []string{"", `{"operatingLimits":[]}`, valid} {
		w := httptest.NewRecorder()
		limits, ok := readCalculationLimits(w, httptest.NewRequest("POST", "/", strings.NewReader(body)))
		if !ok || (body == "" && limits != nil) || (body != "" && limits == nil) {
			t.Fatalf("valid limits rejected: %q %s", body, w.Body.String())
		}
	}
	for _, body := range []string{`{}`, `null`, `{"components":[]}`, `{"operatingLimits":null}`, `{"operatingLimits":[],"extra":true}`,
		strings.Replace(valid, `"component_id":2`, `"component_id":"2"`, 1), strings.Replace(valid, `"terminal":1`, `"terminal":true`, 1),
		strings.Replace(valid, `"min_kv":9.5`, `"min_kv":null`, 1), strings.Replace(valid, `"max_kv":10.5`, `"max_kv":8`, 1),
		strings.Replace(valid, `"terminal":1`, `"terminal":1.5`, 1), strings.Replace(valid, `"min_kv":9.5`, `"min_kv":0`, 1),
		`{"operatingLimits":[]}{}`, strings.Repeat(" ", 128<<10) + valid} {
		w := httptest.NewRecorder()
		if _, ok := readCalculationLimits(w, httptest.NewRequest("POST", "/", strings.NewReader(body))); ok || (w.Code != 400 && w.Code != 413) {
			t.Fatalf("invalid accepted %q", body[:min(len(body), 150)])
		}
	}
	row := `{"component_id":2,"terminal":1,"min_kv":9.5,"max_kv":10.5}`
	for _, body := range []string{`{"operatingLimits":[` + row + `,` + row + `]}`, `{"operatingLimits":[` + strings.Repeat(row+",", 1000) + row + `]}`} {
		w := httptest.NewRecorder()
		if _, ok := readCalculationLimits(w, httptest.NewRequest("POST", "/", strings.NewReader(body))); ok {
			t.Fatal("duplicate/excessive limits accepted")
		}
	}
}

func TestCalculationOperatingLimitsConfirmation(t *testing.T) {
	limits := []terminalVoltageLimit{{2, 1, 9.5, 10.5}}
	const valid = `{"nodes":[{"node_id":1,"voltage":9}],"topology":{"terminals":[{"component_id":2,"terminal":1,"bus_id":1}]},"operating_assessment":{"schema_version":1,"policy":"explicit-terminal-voltage-v1","stability_assessed":false,"status":"violated","checks":[{"component_id":2,"terminal":1,"bus_id":1,"min":9.5,"max":10.5,"measured":9,"status":"below_min","unit":"kV","quantity":"line_to_line_rms_voltage"}]}}`
	if !confirmsCalculationLimits([]byte(valid), limits) {
		t.Fatal("valid result rejected")
	}
	for _, invalid := range []string{`{}`, strings.Replace(valid, `"violated"`, `"within_declared_bounds"`, 1),
		strings.Replace(valid, `"below_min"`, `"within_bounds"`, 1), strings.Replace(valid, `"min":9.5`, `"min":8`, 1),
		strings.Replace(valid, `"measured":9`, `"measured":10`, 1), strings.Replace(valid, `"bus_id":1`, `"bus_id":2`, 1),
		strings.Replace(valid, `"unit":"kV"`, `"unit":"V"`, 1)} {
		if confirmsCalculationLimits([]byte(invalid), limits) {
			t.Fatalf("unconfirmed result accepted %s", invalid)
		}
	}
	var empty map[string]any
	if err := json.Unmarshal([]byte(`{"operating_assessment":{"schema_version":1,"policy":"explicit-terminal-voltage-v1","stability_assessed":false,"status":"not_declared","checks":[]}}`), &empty); err != nil {
		t.Fatal(err)
	}
	body, _ := json.Marshal(empty)
	if !confirmsCalculationLimits(body, []terminalVoltageLimit{}) || !confirmsCalculationLimits([]byte(`{}`), nil) {
		t.Fatal("empty/historical contract rejected")
	}
}
