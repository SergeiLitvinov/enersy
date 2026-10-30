package main

import (
	"context"
	"encoding/json"
	"fmt"
	"math"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"
)

// Real Go -> PostgreSQL snapshot -> Julia HTTP. The opt-in worker has its own
// Compose service and the database helper creates a disposable test database.
func TestParameterUnitsWorkerPostgres(t *testing.T) {
	worker := os.Getenv("TEST_PARAMETER_UNIT_WORKER_URL")
	if worker == "" {
		t.Skip("Set TEST_PARAMETER_UNIT_WORKER_URL for the isolated real-worker unit acceptance")
	}
	database := migrationTestDatabase(t)
	if err := runMigrationsFromSource(database, migrationSourceURL(t)); err != nil {
		t.Fatal(err)
	}
	previous, previousURL := db, juliaBaseURL
	db, juliaBaseURL = database, worker
	defer func() { db, juliaBaseURL = previous, previousURL }()
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()
	var scheme, source, load int
	if err := database.QueryRowContext(ctx, `INSERT INTO circuit_schemes(name) VALUES('Disposable parameter unit acceptance') RETURNING id`).Scan(&scheme); err != nil {
		t.Fatal(err)
	}
	for code, id := range map[string]*int{"generator": &source, "load": &load} {
		if err := database.QueryRowContext(ctx, `INSERT INTO scheme_components(scheme_id,component_type_id,pos_x,pos_y,rotation) SELECT $1,id,0,0,0 FROM component_types WHERE code=$2 RETURNING id`, scheme, code).Scan(id); err != nil {
			t.Fatal(err)
		}
	}
	for id, params := range map[int]map[string]string{source: {"p": "0", "r": "0.1", "x": "0.5", "e": "10", "voltage_nom": "10"}, load: {"p": "10", "q": "3", "voltage_nom": "10"}} {
		for key, value := range params {
			if _, err := database.ExecContext(ctx, `INSERT INTO scheme_component_params(scheme_component_id,param_key,param_value) VALUES($1,$2,$3)`, id, key, value); err != nil {
				t.Fatal(err)
			}
		}
	}
	if _, err := database.ExecContext(ctx, `INSERT INTO scheme_connections(scheme_id,from_component_id,to_component_id,from_port,to_port) VALUES($1,$2,$3,'bottom','top')`, scheme, source, load); err != nil {
		t.Fatal(err)
	}
	var busbar int
	if err := database.QueryRowContext(ctx, `INSERT INTO scheme_components(scheme_id,component_type_id,pos_x,pos_y,rotation) SELECT $1,id,0,0,0 FROM component_types WHERE code='busbar' RETURNING id`, scheme).Scan(&busbar); err != nil {
		t.Fatal(err)
	}
	if _, err := database.ExecContext(ctx, `INSERT INTO scheme_connections(scheme_id,from_component_id,to_component_id,from_port,to_port) VALUES($1,$2,$3,'top','left')`, scheme, load, busbar); err != nil {
		t.Fatal(err)
	}
	calculateProfile := func(strict bool) *httptest.ResponseRecorder {
		response := httptest.NewRecorder()
		path := fmt.Sprintf("/api/ees/calculate/%d", scheme)
		if strict {
			path += "?unitContract=" + acInputUnitProfile
		}
		handleCalculate(response, httptest.NewRequest(http.MethodPost, path, nil).WithContext(ctx))
		return response
	}
	calculate := func() *httptest.ResponseRecorder { return calculateProfile(false) }
	checkPhysical := func(response *httptest.ResponseRecorder) {
		t.Helper()
		if response.Code != 200 {
			t.Fatalf("worker status %d: %s", response.Code, response.Body.String())
		}
		var body struct {
			Success bool `json:"success"`
			Nodes   []struct {
				Internal bool    `json:"is_internal_source_node"`
				Voltage  float64 `json:"voltage"`
				Angle    float64 `json:"angle_rad"`
			} `json:"nodes"`
		}
		if err := json.Unmarshal(response.Body.Bytes(), &body); err != nil || !body.Success {
			t.Fatalf("invalid result: %s", response.Body.String())
		}
		// Independent physical quadratic for E=10 kV, Z=.1+j.5 Ohm,
		// S=10+j3 MVA (three-phase totals and line-to-line RMS).
		re, im := (1+math.Sqrt(1-4*.025-4*.047*.047))/2, -.047
		found := 0
		for _, node := range body.Nodes {
			if !node.Internal {
				found++
				if math.Abs(node.Voltage-10*math.Hypot(re, im)) > 1e-8 || math.Abs(node.Angle-math.Atan2(im, re)) > 1e-9 {
					t.Fatalf("independent voltage mismatch: %+v", node)
				}
			}
		}
		if found != 1 {
			t.Fatalf("unexpected physical node count %d", found)
		}
	}
	checkPhysical(calculate())
	checkPhysical(calculateProfile(true))
	for _, unit := range []string{"Вт", "mW", "", "MW", "МВт"} {
		if _, err := database.ExecContext(ctx, `UPDATE component_params_template SET unit=$1 WHERE param_key='p' AND component_type_id=(SELECT id FROM component_types WHERE code='load')`, unit); err != nil {
			t.Fatal(err)
		}
		response := calculate()
		if unit == "MW" || unit == "МВт" {
			checkPhysical(response)
			checkPhysical(calculateProfile(true))
			continue
		}
		if strict := calculateProfile(true); strict.Code != 400 {
			t.Fatal("strict unit mismatch was not rejected", strict.Code, strict.Body.String())
		}
		var body struct {
			Detail struct {
				Code   string `json:"code"`
				Detail string `json:"detail"`
			} `json:"error_detail"`
		}
		if err := json.Unmarshal(response.Body.Bytes(), &body); err != nil || response.Code != 400 || body.Detail.Code != "parameter_unit_mismatch" || !strings.Contains(body.Detail.Detail, fmt.Sprintf("load#%d.parameterUnits.p", load)) {
			t.Fatalf("unit %q silently accepted: %d %s", unit, response.Code, response.Body.String())
		}
	}
	var value string
	if err := database.QueryRowContext(ctx, `SELECT param_value FROM scheme_component_params WHERE scheme_component_id=$1 AND param_key='p'`, load).Scan(&value); err != nil || value != "10" {
		t.Fatalf("calculation rewrote the stored number: %q %v", value, err)
	}
}
