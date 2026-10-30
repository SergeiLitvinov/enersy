package main

import (
	"context"
	"encoding/json"
	"strings"
	"testing"
)

func TestLegacyIdentityAuditPostgres(t *testing.T) {
	db := migrationTestDatabase(t)
	if _, err := db.Exec(`
CREATE TABLE users(id bigint,name text);
INSERT INTO users VALUES(NULL,'private null 1'),(NULL,'private null 2'),
(-7,'private negative 1'),(-7,'private negative 2'),(42,'private positive 1'),(42,'private positive 2'),(42,'private positive 3'),(99,'private unique');
CREATE TABLE circuit_nodes(id int);
CREATE TABLE component_params_template(private_payload text);
CREATE TABLE equipment_models(id int,bucket int) PARTITION BY LIST(bucket);
CREATE TABLE models_a PARTITION OF equipment_models FOR VALUES IN (1);
CREATE TABLE models_b PARTITION OF equipment_models FOR VALUES IN (2);
INSERT INTO equipment_models VALUES(1,1),(1,2);
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
	counts, err := auditLegacyIdentities(context.Background(), tx, schema)
	if err != nil || len(counts) != 39 {
		t.Fatal(counts, err)
	}
	for code, want := range map[string]int64{
		"users.id.null": 2, "users.id.duplicateGroups": 2, "users.id.duplicateRows": 5,
		"circuit_nodes.id.null": 0, "circuit_nodes.id.duplicateGroups": 0, "circuit_nodes.id.duplicateRows": 0,
		"equipment_models.id.null": 0, "equipment_models.id.duplicateGroups": 1, "equipment_models.id.duplicateRows": 2,
	} {
		if got := counts[code]; got == nil || *got != want {
			t.Fatalf("%s: got %v, want %d", code, got, want)
		}
	}
	for _, table := range []string{"component_params_template", "scheme_components"} {
		for _, suffix := range []string{"null", "duplicateGroups", "duplicateRows"} {
			if counts[table+".id."+suffix] != nil {
				t.Fatal("missing ID column/table presented as assessed", table, suffix)
			}
		}
	}
	outside, err := auditLegacyIdentities(context.Background(), tx, "absent_identity_schema")
	if err != nil || len(outside) != 39 {
		t.Fatal(outside, err)
	}
	for code, count := range outside {
		if count != nil {
			t.Fatal("identity check borrowed a search_path table", code)
		}
	}
}

func TestLegacyIdentityAuditFindingsAndPrivacyPostgres(t *testing.T) {
	db := migrationTestDatabase(t)
	if _, err := db.Exec(`CREATE TABLE users(id bigint,name text,private_payload text);
INSERT INTO users VALUES(86543217891023,'private identity 1','do not disclose identity source'),
(86543217891023,'private identity 2','do not disclose identity source'),(NULL,'private identity null','do not disclose identity source')`); err != nil {
		t.Fatal(err)
	}
	fingerprint := func() string {
		t.Helper()
		var value string
		if err := db.QueryRow(`SELECT json_agg(u ORDER BY name)::text FROM users u`).Scan(&value); err != nil {
			t.Fatal(err)
		}
		return value
	}
	before := fingerprint()
	report, err := auditDatabase(context.Background(), db, migrationSourceURL(t))
	if err != nil || !report.ReadOnly || report.Status != "review_required" || before != fingerprint() {
		t.Fatal("identity audit failed or changed source data", report, err)
	}
	if report.IdentityChecks["users.id.null"] == nil || *report.IdentityChecks["users.id.null"] != 1 ||
		report.IdentityChecks["users.id.duplicateRows"] == nil || *report.IdentityChecks["users.id.duplicateRows"] != 2 {
		t.Fatal(report.IdentityChecks)
	}
	findings := strings.Join(report.Findings, ",")
	if !strings.Contains(findings, "legacy_identity_ambiguities_require_review") || !strings.Contains(findings, "legacy_identity_checks_incomplete") {
		t.Fatal(report.Findings)
	}
	body, err := json.Marshal(report)
	if err != nil {
		t.Fatal(err)
	}
	for _, private := range []string{"86543217891023", "private identity", "private_payload", "do not disclose"} {
		if strings.Contains(string(body), private) {
			t.Fatal("identity audit disclosed source content", private)
		}
	}
}
