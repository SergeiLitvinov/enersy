package main

import (
	"context"
	"encoding/json"
	"reflect"
	"strings"
	"testing"
)

func TestDatabaseAuditPostgres(t *testing.T) {
	db := migrationTestDatabase(t)
	url := migrationSourceURL(t)
	if err := runMigrationsFromSource(db, url); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(`INSERT INTO auth_accounts(display_name) VALUES('do not disclose account'); INSERT INTO circuit_schemes(name) VALUES('do not disclose scheme')`); err != nil {
		t.Fatal(err)
	}
	before := migrationSnapshot(t, db)
	report, err := auditDatabase(context.Background(), db, url)
	if err != nil || !report.ReadOnly || report.Status != "no_findings_in_audited_scope" || report.Version == nil || *report.Version != "3" || report.LatestSourceVersion != "3" {
		t.Fatal(report, err)
	}
	if got := report.Counts["tables.equipment_models"]; got == nil || *got != 90 {
		t.Fatal(got)
	}
	if !reflect.DeepEqual(before, migrationSnapshot(t, db)) {
		t.Fatal("read-only audit changed schema or catalog")
	}
	body, err := json.Marshal(report)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(body), "do not disclose") {
		t.Fatal("audit disclosed private rows")
	}
}

func TestDatabaseAuditFindingsPostgres(t *testing.T) {
	for _, fixture := range []struct{ name, sql, want string }{
		{"checksum", `UPDATE schema_migration_integrity SET sha256=repeat('0',64)`, "migration_integrity_mismatch"},
		{"missing seal", `DELETE FROM schema_migration_integrity`, "migration_integrity_incomplete"},
		{"dirty", `UPDATE schema_migrations SET dirty=true`, "dirty_migration"},
		{"unsupported", `UPDATE schema_migrations SET version=20261030001`, "unsupported_database_version"},
		{"unvalidated", `CREATE TABLE private_extension(value int); INSERT INTO private_extension VALUES(-1); ALTER TABLE private_extension ADD CONSTRAINT private_check CHECK(value>0) NOT VALID`, "unvalidatedConstraints"},
	} {
		t.Run(fixture.name, func(t *testing.T) {
			db := migrationTestDatabase(t)
			url := migrationSourceURL(t)
			if err := runMigrationsFromSource(db, url); err != nil {
				t.Fatal(err)
			}
			if _, err := db.Exec(fixture.sql); err != nil {
				t.Fatal(err)
			}
			report, err := auditDatabase(context.Background(), db, url)
			if err != nil {
				t.Fatal(err)
			}
			found := false
			for _, f := range report.Findings {
				if f == fixture.want {
					found = true
				}
			}
			if !found || report.Status != "review_required" {
				t.Fatal(report)
			}
		})
	}
}

func TestDatabaseAuditEmptyDoesNotBootstrapPostgres(t *testing.T) {
	db := migrationTestDatabase(t)
	report, err := auditDatabase(context.Background(), db, migrationSourceURL(t))
	if err != nil {
		t.Fatal(err)
	}
	if report.Version != nil || report.Dirty != nil || report.Counts["tables.auth_accounts"] != nil || report.Status != "review_required" {
		t.Fatal(report)
	}
	var objects int
	if err := db.QueryRow(`SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=current_schema()`).Scan(&objects); err != nil || objects != 0 {
		t.Fatal("audit bootstrapped empty schema", objects, err)
	}
}
