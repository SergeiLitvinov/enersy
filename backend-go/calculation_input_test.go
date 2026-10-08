package main

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
	"time"
)

func TestCalculationInputConcurrentCommitPostgres(t *testing.T) {
	database := migrationTestDatabase(t)
	if err := runMigrationsFromSource(database, migrationSourceURL(t)); err != nil {
		t.Fatal(err)
	}
	previous, previousURL := db, juliaBaseURL
	db = database
	defer func() { db, juliaBaseURL = previous, previousURL }()
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	var scheme, first, second int
	if err := database.QueryRowContext(ctx, `INSERT INTO circuit_schemes(name) VALUES('Calculation fixture') RETURNING id`).Scan(&scheme); err != nil {
		t.Fatal(err)
	}
	for _, id := range []*int{&first, &second} {
		if err := database.QueryRowContext(ctx, `INSERT INTO scheme_components(scheme_id,component_type_id,pos_x,pos_y,rotation)
		 SELECT $1,id,0,0,0 FROM component_types WHERE code='busbar' RETURNING id`, scheme).Scan(id); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := database.ExecContext(ctx, `INSERT INTO scheme_component_params(scheme_component_id,param_key,param_value) VALUES($1,'voltage_nom','110')`, first); err != nil {
		t.Fatal(err)
	}
	if _, err := database.ExecContext(ctx, `INSERT INTO scheme_connections(scheme_id,from_component_id,to_component_id,from_port,to_port)
	 VALUES($1,$2,$3,'right','left')`, scheme, first, second); err != nil {
		t.Fatal(err)
	}
	key := time.Now().UnixNano()
	if _, err := database.ExecContext(ctx, fmt.Sprintf(`ALTER TABLE component_types RENAME TO snapshot_component_types;
	 CREATE FUNCTION snapshot_read_gate() RETURNS boolean LANGUAGE plpgsql AS $$
	 BEGIN PERFORM pg_advisory_xact_lock(%d); RETURN true; END; $$;
	 CREATE VIEW component_types AS SELECT * FROM snapshot_component_types WHERE snapshot_read_gate();`, key)); err != nil {
		t.Fatal(err)
	}
	blocker, err := database.BeginTx(ctx, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer blocker.Rollback()
	if _, err := blocker.ExecContext(ctx, `SELECT pg_advisory_xact_lock($1)`, key); err != nil {
		t.Fatal(err)
	}
	type workerRequest struct {
		Components  []calculationComponent  `json:"components"`
		Connections []calculationConnection `json:"connections"`
		ModelGroup  string                  `json:"modelGroup"`
		Method      string                  `json:"method"`
	}
	inputs := make(chan workerRequest, 2)
	worker := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var input workerRequest
		if r.URL.Path != "/calculate" || json.NewDecoder(r.Body).Decode(&input) != nil {
			w.WriteHeader(400)
			return
		}
		inputs <- input
		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte(`{"captured":true}`)) // Transport fixture, not a numerical result.
	}))
	defer worker.Close()
	juliaBaseURL = worker.URL
	completed := make(chan struct{})
	response := httptest.NewRecorder()
	path := fmt.Sprintf("/api/ees/calculate/%d?method=newton-raphson&modelGroup=three-phase", scheme)
	go func() {
		defer close(completed)
		handleCalculate(response, httptest.NewRequest(http.MethodPost, path, nil).WithContext(ctx))
	}()
	defer func() { blocker.Rollback(); cancel(); <-completed }()
	deadline := time.Now().Add(5 * time.Second)
	for {
		var waiting bool
		if err := database.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM pg_locks WHERE locktype='advisory'
		 AND NOT granted AND classid=$1 AND objid=$2)`, key>>32, key&0xffffffff).Scan(&waiting); err != nil {
			t.Fatal(err)
		}
		if waiting {
			break
		}
		select {
		case <-completed:
			t.Fatalf("Reader ended before gate: %d %s", response.Code, response.Body.String())
		default:
		}
		if time.Now().After(deadline) {
			t.Fatal("Reader did not reach SQL barrier")
		}
		time.Sleep(10 * time.Millisecond)
	}
	writer, err := database.BeginTx(ctx, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer writer.Rollback()
	if _, err := writer.ExecContext(ctx, `UPDATE scheme_components SET pos_x=100 WHERE id=$1`, first); err != nil {
		t.Fatal(err)
	}
	if _, err := writer.ExecContext(ctx, `UPDATE scheme_component_params SET param_value='220' WHERE scheme_component_id=$1`, first); err != nil {
		t.Fatal(err)
	}
	if _, err := writer.ExecContext(ctx, `DELETE FROM scheme_connections WHERE scheme_id=$1`, scheme); err != nil {
		t.Fatal(err)
	}
	if err := writer.Commit(); err != nil {
		t.Fatal(err)
	}
	if err := blocker.Rollback(); err != nil {
		t.Fatal(err)
	}
	<-completed
	check := func(response *httptest.ResponseRecorder, voltage string, x float64, connections int) {
		t.Helper()
		if response.Code != 200 {
			t.Fatalf("Worker not reached: %d %s", response.Code, response.Body.String())
		}
		input := <-inputs
		if len(input.Components) != 2 || len(input.Connections) != connections || input.Method != "newton-raphson" || input.ModelGroup != "three-phase" {
			t.Fatalf("Mixed topology or changed worker contract: %+v", input)
		}
		found := false
		for _, component := range input.Components {
			if component.ID == first {
				found = true
				if component.Type != "busbar" || component.X != x || component.Params["voltage_nom"] != voltage {
					t.Fatalf("Mixed component/parameter input: %+v", input)
				}
			}
		}
		if !found {
			t.Fatal("Missing original equipment")
		}
	}
	check(response, "110", 0, 1)
	fresh := httptest.NewRecorder()
	handleCalculate(fresh, httptest.NewRequest(http.MethodPost, path, nil).WithContext(ctx))
	check(fresh, "220", 100, 0)
}

func TestCalculationInputReleasesDatabaseBeforeWorkerPostgres(t *testing.T) {
	database := migrationTestDatabase(t)
	if err := runMigrationsFromSource(database, migrationSourceURL(t)); err != nil {
		t.Fatal(err)
	}
	var scheme int
	if err := database.QueryRow(`INSERT INTO circuit_schemes(name) VALUES('Pool fixture') RETURNING id`).Scan(&scheme); err != nil {
		t.Fatal(err)
	}
	if _, err := database.Exec(`INSERT INTO scheme_components(scheme_id,component_type_id) SELECT $1,id FROM component_types WHERE code='busbar'`, scheme); err != nil {
		t.Fatal(err)
	}
	database.SetMaxOpenConns(1)
	previous, previousURL := db, juliaBaseURL
	db = database
	defer func() { db, juliaBaseURL = previous, previousURL }()
	var calls atomic.Int32
	worker := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		ctx, cancel := context.WithTimeout(r.Context(), time.Second)
		defer cancel()
		if err := database.PingContext(ctx); err != nil {
			w.WriteHeader(503)
			return
		}
		w.Write([]byte(`{"captured":true}`))
	}))
	defer worker.Close()
	juliaBaseURL = worker.URL
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	response := httptest.NewRecorder()
	handleCalculate(response, httptest.NewRequest(http.MethodPost, fmt.Sprintf("/api/ees/calculate/%d", scheme), nil).WithContext(ctx))
	if response.Code != 200 || calls.Load() != 1 {
		t.Fatalf("Database connection held during compute: %d %s", response.Code, response.Body.String())
	}
	missing := httptest.NewRecorder()
	handleCalculate(missing, httptest.NewRequest(http.MethodPost, "/api/ees/calculate/99999", nil).WithContext(ctx))
	if missing.Code != 404 || calls.Load() != 1 {
		t.Fatal("Missing scheme reached worker", missing.Code)
	}
	cancel()
	cancelled := httptest.NewRecorder()
	handleCalculate(cancelled, httptest.NewRequest(http.MethodPost, fmt.Sprintf("/api/ees/calculate/%d", scheme), nil).WithContext(ctx))
	if cancelled.Code != 500 || calls.Load() != 1 {
		t.Fatal("Cancelled read reached worker", cancelled.Code)
	}
}
