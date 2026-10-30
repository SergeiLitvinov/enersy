package main

import (
	"bytes"
	"context"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestLegacyReferenceAuditCLIPostgres(t *testing.T) {
	binary := os.Getenv("TEST_OPERATOR_BINARY")
	if binary == "" {
		t.Skip("Set TEST_OPERATOR_BINARY for the isolated read-only CLI check")
	}
	db := migrationTestDatabase(t)
	var schema string
	if err := db.QueryRow(`SELECT current_schema()`).Scan(&schema); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, binary, "-audit-database")
	cmd.Env = append(os.Environ(), "PGOPTIONS=-c search_path="+schema, "MIGRATIONS_SOURCE="+migrationSourceURL(t))
	var output, diagnostic bytes.Buffer
	cmd.Stdout, cmd.Stderr = &output, &diagnostic
	if err := cmd.Run(); err != nil {
		t.Fatal("read-only CLI failed", err, diagnostic.String())
	}
	var r databaseAudit
	if err := json.Unmarshal(output.Bytes(), &r); err != nil || !r.ReadOnly || r.Version != nil || r.Status != "review_required" || len(r.ReferenceChecks) != 37 || len(r.IdentityChecks) != 39 {
		t.Fatal("CLI did not report the unmigrated source honestly", r, err)
	}
	for code, count := range r.ReferenceChecks {
		if count != nil {
			t.Fatal("absent legacy relation presented as assessed", code)
		}
	}
	for code, count := range r.IdentityChecks {
		if count != nil {
			t.Fatal("absent legacy identity presented as assessed", code)
		}
	}
	var relations int
	if err := db.QueryRow(`SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=current_schema()`).Scan(&relations); err != nil || relations != 0 {
		t.Fatal("CLI migrated or populated the empty schema", relations, err)
	}
	// Incompatible legacy column types must fail the whole command, rather
	// than produce a partial report with some plausible zero counts.
	if _, err := db.Exec(`CREATE TABLE circuit_schemes(id int); CREATE TABLE scheme_components(id int,scheme_id text); INSERT INTO scheme_components VALUES(1,'unknown source')`); err != nil {
		t.Fatal(err)
	}
	invalid := exec.CommandContext(ctx, binary, "-audit-database")
	invalid.Env = cmd.Env
	output.Reset()
	diagnostic.Reset()
	invalid.Stdout, invalid.Stderr = &output, &diagnostic
	if err := invalid.Run(); err == nil || output.Len() != 0 {
		t.Fatal("incompatible reference emitted a partial success report", err, output.String())
	}
	if _, err := db.Exec(`DROP TABLE scheme_components,circuit_schemes; CREATE TABLE circuit_nodes(id json); INSERT INTO circuit_nodes VALUES('{"private":"identity fixture"}')`); err != nil {
		t.Fatal(err)
	}
	invalidIdentity := exec.CommandContext(ctx, binary, "-audit-database")
	invalidIdentity.Env = cmd.Env
	output.Reset()
	diagnostic.Reset()
	invalidIdentity.Stdout, invalidIdentity.Stderr = &output, &diagnostic
	if err := invalidIdentity.Run(); err == nil || output.Len() != 0 {
		t.Fatal("incompatible identity emitted a partial success report", err, output.String())
	}
}

func TestLegacyReferenceAuditPostgres(t *testing.T) {
	db := migrationTestDatabase(t)
	executeFixture(t, db, filepath.Join("..", "database", "init.sql"))
	// Deliberately malformed historical data in this disposable schema only.
	// Remove newer connection guards here to represent an older database;
	// single-column FKs still require both referenced components to exist.
	if _, err := db.Exec(`
ALTER TABLE scheme_connections DROP CONSTRAINT connection_from_scheme_fk;
ALTER TABLE scheme_connections DROP CONSTRAINT connection_to_scheme_fk;
DROP TRIGGER connection_ports_check ON scheme_connections;
INSERT INTO circuit_schemes(id,name,owner_id) VALUES(91001,'Private fixture A',NULL),(91002,'Private fixture B',NULL);
INSERT INTO scheme_components(id,scheme_id,component_type_id,custom_name)
 SELECT 91001,91001,id,'Do not disclose params' FROM component_types WHERE code='busbar';
INSERT INTO scheme_components(id,scheme_id,component_type_id)
 SELECT 91002,91002,id FROM component_types WHERE code='busbar';
INSERT INTO circuit_nodes(id,scheme_id,node_number,node_type) VALUES(92001,91001,1,'PQ'),(92002,91002,1,'PQ'),(92003,NULL,2,'PQ');
INSERT INTO calculation_results(id,scheme_id,calculation_type,status) VALUES(93001,91001,'legacy','saved'),(93002,NULL,'legacy','saved');
INSERT INTO calculation_node_results(calculation_id,node_id) VALUES(93001,92001),(93001,92002),(93001,NULL);
INSERT INTO calculation_branch_results(calculation_id,from_component_id,to_component_id)
 VALUES(93001,91001,91001),(93001,91002,91002),(93001,NULL,NULL);
INSERT INTO scheme_connections(scheme_id,from_component_id,to_component_id,from_port,to_port) VALUES(91001,91002,91002,'left','right');
ALTER TABLE calculation_node_results DROP CONSTRAINT calculation_node_results_node_id_fkey;
INSERT INTO calculation_node_results(calculation_id,node_id) VALUES(93001,2147483647);
`); err != nil {
		t.Fatal(err)
	}
	fingerprint := func() string {
		t.Helper()
		var result string
		if err := db.QueryRow(`SELECT json_build_object(
 'nodes',(SELECT json_agg(n ORDER BY id) FROM circuit_nodes n),
 'results',(SELECT json_agg(r ORDER BY id) FROM calculation_results r),
 'nodeResults',(SELECT json_agg(n ORDER BY id) FROM calculation_node_results n),
 'branches',(SELECT json_agg(b ORDER BY id) FROM calculation_branch_results b),
 'connections',(SELECT json_agg(c ORDER BY id) FROM scheme_connections c))::text`).Scan(&result); err != nil {
			t.Fatal(err)
		}
		return result
	}
	before := fingerprint()
	r, err := auditDatabase(context.Background(), db, migrationSourceURL(t))
	if err != nil {
		t.Fatal(err)
	}
	if !r.ReadOnly || before != fingerprint() || len(r.ReferenceChecks) != 37 {
		t.Fatal("audit changed data or omitted checks", r)
	}
	expected := map[string]int64{
		"circuit_nodes.scheme_id.null": 1, "calculation_results.scheme_id.null": 1,
		"calculation_node_results.node_id.null": 1, "calculation_node_results.node_id.dangling": 1,
		"calculation_branch_results.from_component_id.null": 1, "calculation_branch_results.to_component_id.null": 1,
		"nodeResults.schemeMismatch": 1, "branchResults.fromSchemeMismatch": 1, "branchResults.toSchemeMismatch": 1,
		"scheme_connections.from_component_id.schemeMismatch": 1, "scheme_connections.to_component_id.schemeMismatch": 1,
	}
	for code, count := range r.ReferenceChecks {
		if count == nil || *count != expected[code] {
			t.Fatalf("%s: got %v, expected %d", code, count, expected[code])
		}
	}
	if !strings.Contains(strings.Join(r.Findings, ","), "legacy_references_require_review") {
		t.Fatal("unresolved links not flagged")
	}
	body, err := json.Marshal(r)
	if err != nil || strings.Contains(string(body), "Private fixture") || strings.Contains(string(body), "Do not disclose") || strings.Contains(string(body), "91001") {
		t.Fatal("audit exposed fixture values", err)
	}
	// A missing relation must become unknown, never a green zero. The .null
	// check remains assessed because it only needs the still-existing source.
	if _, err := db.Exec(`DROP TABLE circuit_nodes CASCADE`); err != nil {
		t.Fatal(err)
	}
	r, err = auditDatabase(context.Background(), db, migrationSourceURL(t))
	if err != nil || r.ReferenceChecks["calculation_node_results.node_id.dangling"] != nil || r.ReferenceChecks["nodeResults.schemeMismatch"] != nil ||
		r.ReferenceChecks["calculation_node_results.node_id.null"] == nil || !strings.Contains(strings.Join(r.Findings, ","), "legacy_reference_checks_incomplete") {
		t.Fatal("missing relation fabricated a successful check", r, err)
	}
}

func TestLegacyReferenceAuditSchemaIsolationPostgres(t *testing.T) {
	db := migrationTestDatabase(t)
	if _, err := db.Exec(`CREATE TABLE scheme_components(id int,scheme_id int); INSERT INTO scheme_components VALUES(1,2)`); err != nil {
		t.Fatal(err)
	}
	tx, err := beginReadOnlyAudit(context.Background(), db)
	if err != nil {
		t.Fatal(err)
	}
	defer rollbackTx(tx)
	// Even with real similarly named relations in search_path, an absent exact
	// schema cannot borrow those tables to claim a completed reference audit.
	r, err := auditLegacyReferences(context.Background(), tx, "absent_reference_schema")
	if err != nil || len(r) != 37 {
		t.Fatal(r, err)
	}
	for code, count := range r {
		if count != nil {
			t.Fatal("read outside requested schema", code)
		}
	}
}

func TestLegacyReferenceMismatchCountsSourceRowsWithDuplicateTargetIDsPostgres(t *testing.T) {
	db := migrationTestDatabase(t)
	if _, err := db.Exec(`
CREATE TABLE calculation_results(id int,scheme_id int);
CREATE TABLE circuit_nodes(id int,scheme_id int);
CREATE TABLE scheme_components(id int,scheme_id int);
CREATE TABLE calculation_node_results(calculation_id int,node_id int);
CREATE TABLE calculation_branch_results(calculation_id int,from_component_id int,to_component_id int);
CREATE TABLE scheme_connections(scheme_id int,from_component_id int,to_component_id int);
INSERT INTO calculation_results VALUES(10,1),(10,2),(10,3);
INSERT INTO circuit_nodes VALUES(20,4),(20,5);
INSERT INTO scheme_components VALUES(30,4),(30,5);
INSERT INTO calculation_node_results VALUES(10,20),(10,20);
INSERT INTO calculation_branch_results VALUES(10,30,30);
INSERT INTO scheme_connections VALUES(1,30,30);
`); err != nil {
		t.Fatal(err)
	}
	tx, err := beginReadOnlyAudit(context.Background(), db)
	if err != nil {
		t.Fatal(err)
	}
	defer rollbackTx(tx)
	var schema string
	if err := tx.QueryRow(`SELECT current_schema()`).Scan(&schema); err != nil {
		t.Fatal(err)
	}
	counts, err := auditLegacyReferences(context.Background(), tx, schema)
	if err != nil {
		t.Fatal(err)
	}
	for code, want := range map[string]int64{
		"nodeResults.schemeMismatch":                          2,
		"branchResults.fromSchemeMismatch":                    1,
		"branchResults.toSchemeMismatch":                      1,
		"scheme_connections.from_component_id.schemeMismatch": 1,
		"scheme_connections.to_component_id.schemeMismatch":   1,
	} {
		if got := counts[code]; got == nil {
			t.Errorf("%s unexpectedly not assessed", code)
		} else if *got != want {
			t.Errorf("%s must count each source row once, got %d, want %d", code, *got, want)
		}
	}
}
