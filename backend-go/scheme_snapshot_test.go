package main

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

func TestSchemeSnapshotConcurrentCommitPostgres(t *testing.T) {
	database := migrationTestDatabase(t)
	if err := runMigrationsFromSource(database, migrationSourceURL(t)); err != nil {
		t.Fatal(err)
	}
	previous := db
	db = database
	defer func() { db = previous }()
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	var scheme, first, second, connection int
	if err := database.QueryRowContext(ctx, `INSERT INTO circuit_schemes(name,description) VALUES('Before','snapshot fixture') RETURNING id`).Scan(&scheme); err != nil {
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
	if err := database.QueryRowContext(ctx, `INSERT INTO scheme_connections(scheme_id,from_component_id,to_component_id,from_port,to_port)
	 VALUES($1,$2,$3,'right','left') RETURNING id`, scheme, first, second).Scan(&connection); err != nil {
		t.Fatal(err)
	}
	var revision string
	if err := database.QueryRowContext(ctx, `SELECT revision::text FROM scheme_components WHERE id=$1`, first).Scan(&revision); err != nil {
		t.Fatal(err)
	}
	// A fixture-only view gates the equipment SELECT on an advisory lock.
	// Foreign keys still reference the renamed physical table, so the gate
	// does not block the independent writer or change production code.
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
	completed := make(chan struct{})
	response := httptest.NewRecorder()
	go func() {
		defer close(completed)
		handleSchemeByID(response, httptest.NewRequest(http.MethodGet, fmt.Sprintf("/api/ees/schemes/%d", scheme), nil).WithContext(ctx))
	}()
	defer func() {
		blocker.Rollback()
		cancel()
		<-completed // Never restore the global fixture while the handler is running.
	}()
	deadline := time.Now().Add(5 * time.Second)
	for {
		var waiting bool
		if err := database.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM pg_locks
		 WHERE locktype='advisory' AND NOT granted AND classid=$1 AND objid=$2)`, key>>32, key&0xffffffff).Scan(&waiting); err != nil {
			t.Fatal(err)
		}
		if waiting {
			break
		}
		select {
		case <-completed:
			t.Fatalf("Reader did not reach relation lock: %d %s", response.Code, response.Body.String())
		default:
		}
		if time.Now().After(deadline) {
			t.Fatal("Reader did not reach the observed PostgreSQL lock")
		}
		time.Sleep(10 * time.Millisecond)
	}
	writer, err := database.BeginTx(ctx, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer writer.Rollback()
	for _, change := range []struct {
		query string
		id    int
	}{
		{`UPDATE circuit_schemes SET name='After' WHERE id=$1`, scheme},
		{`UPDATE scheme_components SET pos_x=100 WHERE id=$1`, first},
		{`UPDATE scheme_component_params SET param_value='220' WHERE scheme_component_id=$1`, first},
		{`DELETE FROM scheme_connections WHERE id=$1`, connection},
	} {
		if _, err := writer.ExecContext(ctx, change.query, change.id); err != nil {
			t.Fatal(change.query, err)
		}
	}
	if err := writer.Commit(); err != nil {
		t.Fatal(err)
	}
	if err := blocker.Rollback(); err != nil {
		t.Fatal(err)
	}
	<-completed
	assertSnapshot := func(w *httptest.ResponseRecorder, name, voltage, expectedRevision string, x float64, connections int) {
		t.Helper()
		var snapshot struct {
			ID         int
			Name       string
			Components []struct {
				ID       int
				X        float64
				Revision string
				Params   map[string]string
			}
			Connections []struct{ ID int }
		}
		if w.Code != 200 || json.Unmarshal(w.Body.Bytes(), &snapshot) != nil {
			t.Fatalf("Snapshot failed: %d %s", w.Code, w.Body.String())
		}
		if snapshot.ID != scheme || snapshot.Name != name || len(snapshot.Components) != 2 || len(snapshot.Connections) != connections {
			t.Fatalf("Mixed metadata/topology snapshot: %s", w.Body.String())
		}
		found := false
		for _, component := range snapshot.Components {
			if component.ID == first {
				found = true
				if component.X != x || component.Revision != expectedRevision || component.Params["voltage_nom"] != voltage {
					t.Fatalf("Mixed equipment/parameters snapshot: %s", w.Body.String())
				}
			}
		}
		if !found || (connections == 1 && snapshot.Connections[0].ID != connection) {
			t.Fatalf("Missing original identities: %s", w.Body.String())
		}
	}
	assertSnapshot(response, "Before", "110", revision, 0, 1)
	var latestRevision string
	if err := database.QueryRowContext(ctx, `SELECT revision::text FROM scheme_components WHERE id=$1`, first).Scan(&latestRevision); err != nil {
		t.Fatal(err)
	}
	if latestRevision == revision {
		t.Fatal("Writer did not change equipment revision")
	}
	fresh := httptest.NewRecorder()
	handleSchemeByID(fresh, httptest.NewRequest(http.MethodGet, fmt.Sprintf("/api/ees/schemes/%d", scheme), nil).WithContext(ctx))
	assertSnapshot(fresh, "After", "220", latestRevision, 100, 0)
}

func TestSchemeSnapshotFailureReleasesConnectionPostgres(t *testing.T) {
	database := migrationTestDatabase(t)
	if err := runMigrationsFromSource(database, migrationSourceURL(t)); err != nil {
		t.Fatal(err)
	}
	database.SetMaxOpenConns(1)
	previous := db
	db = database
	defer func() { db = previous }()
	for _, cancelled := range []bool{false, true} {
		ctx, cancel := context.WithCancel(context.Background())
		if cancelled {
			cancel()
		}
		response := httptest.NewRecorder()
		handleSchemeByID(response, httptest.NewRequest(http.MethodGet, "/api/ees/schemes/99999", nil).WithContext(ctx))
		cancel()
		want := http.StatusNotFound
		if cancelled {
			want = http.StatusInternalServerError
		}
		if response.Code != want {
			t.Fatalf("cancelled=%v: %d %s", cancelled, response.Code, response.Body.String())
		}
		probe, release := context.WithTimeout(context.Background(), time.Second)
		err := database.PingContext(probe)
		release()
		if err != nil {
			t.Fatal("Snapshot failure leaked the only database connection", err)
		}
	}
}
