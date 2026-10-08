package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// Real PostgreSQL plans, with normal planner settings and unrelated schemes.
// This is an access-path regression, not a solver or latency benchmark.
func TestSchemeAccessIndexesPostgres(t *testing.T) {
	database := migrationTestDatabase(t)
	// Build the actual preceding release source, including its checksum history.
	previousSource := t.TempDir()
	migrations := filepath.Join("..", "database", "migrations")
	entries, err := os.ReadDir(migrations)
	if err != nil {
		t.Fatal(err)
	}
	for _, entry := range entries {
		if entry.IsDir() || strings.HasPrefix(entry.Name(), "20261008002_") {
			continue
		}
		body, err := os.ReadFile(filepath.Join(migrations, entry.Name()))
		if err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(previousSource, entry.Name()), body, 0600); err != nil {
			t.Fatal(err)
		}
	}
	if err := runMigrationsFromSource(database, "file://"+filepath.ToSlash(previousSource)); err != nil {
		t.Fatal(err)
	}
	if _, err := database.Exec(`
 INSERT INTO circuit_schemes(id,name) SELECT n,'Access fixture ' || n FROM generate_series(1,100) n;
 INSERT INTO scheme_components(id,scheme_id,component_type_id,pos_x,pos_y,rotation)
 SELECT n,1+(n-1)/200,ct.id,0,0,0 FROM generate_series(1,20000) n
 CROSS JOIN component_types ct WHERE ct.code='busbar';
 INSERT INTO scheme_connections(scheme_id,from_component_id,to_component_id,from_port,to_port)
 SELECT scheme_id,id,id+1,'right','left' FROM scheme_components WHERE id % 200 <> 0;
 ANALYZE scheme_components; ANALYZE scheme_connections;`); err != nil {
		t.Fatal(err)
	}
	type planNode struct {
		NodeType  string            `json:"Node Type"`
		IndexName string            `json:"Index Name"`
		Plans     []json.RawMessage `json:"Plans"`
	}
	queries := []struct{ query, index string }{
		{`SELECT * FROM scheme_components WHERE scheme_id=42`, "scheme_components_scheme_idx"},
		{`SELECT * FROM scheme_connections WHERE scheme_id=42`, "scheme_connections_scheme_idx"},
		{`SELECT * FROM scheme_connections WHERE from_component_id=8201 AND scheme_id=42`, "scheme_connections_from_scheme_idx"},
		{`SELECT * FROM scheme_connections WHERE to_component_id=8202 AND scheme_id=42`, "scheme_connections_to_scheme_idx"},
	}
	check := func(indexed bool) {
		t.Helper()
		for _, query := range queries {
			var encoded []byte
			if err := database.QueryRow("EXPLAIN (FORMAT JSON) " + query.query).Scan(&encoded); err != nil {
				t.Fatal(err)
			}
			var roots []struct{ Plan json.RawMessage }
			if err := json.Unmarshal(encoded, &roots); err != nil {
				t.Fatal(err)
			}
			foundIndex, foundSequential := false, false
			var visit func(json.RawMessage)
			visit = func(raw json.RawMessage) {
				var node planNode
				if err := json.Unmarshal(raw, &node); err != nil {
					t.Fatal(err)
				}
				foundIndex = foundIndex || node.IndexName == query.index
				foundSequential = foundSequential || node.NodeType == "Seq Scan"
				for _, child := range node.Plans {
					visit(child)
				}
			}
			for _, root := range roots {
				visit(root.Plan)
			}
			if indexed && (!foundIndex || foundSequential) {
				t.Fatalf("expected %s without full scan: %s", query.index, encoded)
			}
			if !indexed && !foundSequential {
				t.Fatalf("expected unindexed baseline full scan: %s", encoded)
			}
			t.Logf("indexed=%t %s: %s", indexed, query.index, encoded)
		}
	}
	check(false)
	if err := runMigrationsFromSource(database, migrationSourceURL(t)); err != nil {
		t.Fatal(err)
	}
	check(true)
	var components, connections int
	if err := database.QueryRow(`SELECT (SELECT count(*) FROM scheme_components),(SELECT count(*) FROM scheme_connections)`).Scan(&components, &connections); err != nil {
		t.Fatal(err)
	}
	if components != 20000 || connections != 19900 {
		t.Fatalf("index migration changed fixture: %d/%d", components, connections)
	}
	down, err := os.ReadFile(filepath.Join(migrations, "20261008002_scheme_access_indexes.down.sql"))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := database.Exec(string(down)); err != nil {
		t.Fatal(err)
	}
	check(false)
}
