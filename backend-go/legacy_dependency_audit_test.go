package main

import (
	"context"
	"encoding/json"
	"strings"
	"testing"

	"github.com/lib/pq"
)

func TestLegacyDependencyAuditPostgres(t *testing.T) {
	db := migrationTestDatabase(t)
	if _, err := db.Exec(`
CREATE TABLE circuit_schemes(id int PRIMARY KEY);
CREATE TABLE users(id int PRIMARY KEY,name text);
CREATE TABLE scheme_components(id int PRIMARY KEY, scheme_id int REFERENCES circuit_schemes(id));
CREATE TABLE scheme_connections(bucket int,scheme_id int REFERENCES circuit_schemes(id)) PARTITION BY LIST(bucket);
CREATE TABLE private_partition PARTITION OF scheme_connections FOR VALUES IN (1);
CREATE TABLE private_extension(scheme_id int REFERENCES circuit_schemes(id),unchecked_id int,private_payload text);
INSERT INTO private_extension VALUES(NULL,7654321,'do not disclose dependency data');
ALTER TABLE private_extension ADD CONSTRAINT private_pending FOREIGN KEY(unchecked_id) REFERENCES circuit_schemes(id) NOT VALID;
CREATE VIEW calculation_results AS SELECT id FROM circuit_schemes;
`); err != nil {
		t.Fatal(err)
	}
	var schema string
	if err := db.QueryRow(`SELECT current_schema()`).Scan(&schema); err != nil {
		t.Fatal(err)
	}
	outside := migrationTestDatabase(t)
	// A legacy-looking source name in a DIFFERENT schema is still external.
	if _, err := outside.Exec(`CREATE TABLE scheme_components(id int,scheme_id int REFERENCES ` + pq.QuoteIdentifier(schema) + `.circuit_schemes(id))`); err != nil {
		t.Fatal(err)
	}
	fingerprint := func() string {
		t.Helper()
		var value string
		if err := db.QueryRow(`SELECT json_agg(t)::text FROM private_extension t`).Scan(&value); err != nil {
			t.Fatal(err)
		}
		return value
	}
	before := fingerprint()
	report, err := auditDatabase(context.Background(), db, migrationSourceURL(t))
	if err != nil || !report.ReadOnly || before != fingerprint() {
		t.Fatal(report, err)
	}
	if len(report.DependencyChecks) != 39 {
		t.Fatal(report.DependencyChecks)
	}
	// Two known root FKs, two extension FKs, and one cross-schema FK.
	// PostgreSQL's inherited partition FK must not become a sixth dependency.
	for code, want := range map[string]int64{
		"circuit_schemes.incomingFKs.total":          5,
		"circuit_schemes.incomingFKs.unvalidated":    1,
		"circuit_schemes.incomingFKs.otherRelations": 3,
		"users.incomingFKs.total":                    0,
		"users.incomingFKs.unvalidated":              0,
		"users.incomingFKs.otherRelations":           0,
	} {
		if got := report.DependencyChecks[code]; got == nil || *got != want {
			t.Fatalf("%s: got %v, want %d", code, got, want)
		}
	}
	for _, table := range []string{"calculation_results", "circuit_nodes"} {
		for _, suffix := range []string{"total", "unvalidated", "otherRelations"} {
			if report.DependencyChecks[table+".incomingFKs."+suffix] != nil {
				t.Fatal("missing physical target presented as assessed", table, suffix)
			}
		}
	}
	if !report.DependencyReviewRequired {
		t.Fatal("unknown or unvalidated dependencies need operator review")
	}

	body, err := json.Marshal(report)
	if err != nil {
		t.Fatal(err)
	}
	for _, private := range []string{schema, "private_extension", "private_pending", "private_partition", "private_payload", "7654321", "do not disclose"} {
		if strings.Contains(string(body), private) {
			t.Fatal("metadata audit disclosed a source identity or value", private)
		}
	}
	tx, err := beginReadOnlyAudit(context.Background(), db)
	if err != nil {
		t.Fatal(err)
	}
	defer rollbackTx(tx)
	counts, err := auditLegacyDependencies(context.Background(), tx, "missing_dependency_schema")
	if err != nil || len(counts) != 39 {
		t.Fatal(counts, err)
	}
	for key, value := range counts {
		if value != nil {
			t.Fatal("dependency audit borrowed search_path relation", key)
		}
	}
}

func TestLegacyDependencyAuditOnlyDeclaredConstraintsPostgres(t *testing.T) {
	db := migrationTestDatabase(t)
	if _, err := db.Exec(`CREATE TABLE circuit_schemes(id int PRIMARY KEY);
CREATE TABLE private_unconstrained_reference(scheme_id int);
INSERT INTO private_unconstrained_reference VALUES(987654);
CREATE TABLE private_validated_reference(scheme_id int REFERENCES circuit_schemes(id));`); err != nil {
		t.Fatal(err)
	}
	report, err := auditDatabase(context.Background(), db, migrationSourceURL(t))
	if err != nil {
		t.Fatal(err)
	}
	if count := report.DependencyChecks["circuit_schemes.incomingFKs.total"]; count == nil || *count != 1 {
		t.Fatal(report.DependencyChecks)
	}
	if count := report.DependencyChecks["circuit_schemes.incomingFKs.unvalidated"]; count == nil || *count != 0 {
		t.Fatal(report.DependencyChecks)
	}
	if !report.DependencyReviewRequired {
		t.Fatal("extension FK omitted from review signal")
	}
}
