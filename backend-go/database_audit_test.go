package main

import (
	"context"
	"encoding/json"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

func TestDatabaseAuditPostgres(t *testing.T) {
	for _, fixture := range []string{"fresh", "init.sql", "ees_schema.sql", "repeated-bootstrap"} {
		t.Run(fixture, func(t *testing.T) {
			db := migrationTestDatabase(t)
			url := migrationSourceURL(t)
			if fixture == "fresh" {
				if err := runMigrationsFromSource(db, url); err != nil {
					t.Fatal(err)
				}
			} else {
				file := fixture
				if file == "repeated-bootstrap" {
					file = "init.sql"
				}
				executeFixture(t, db, filepath.Join("..", "database", file))
				if fixture == "repeated-bootstrap" {
					executeFixture(t, db, filepath.Join("..", "database", file))
				}
			}
			fingerprint := func() string {
				var value string
				if err := db.QueryRow(`SELECT json_build_object('columns',(SELECT json_agg(c ORDER BY table_name,ordinal_position) FROM information_schema.columns c WHERE table_schema=current_schema()),'types',(SELECT json_agg(t ORDER BY id) FROM component_types t),'models',(SELECT json_agg(m ORDER BY id) FROM equipment_models m))::text`).Scan(&value); err != nil {
					t.Fatal(err)
				}
				return value
			}
			before := fingerprint()
			var usersBefore string
			// ees_schema has no legacy users table; this absence must not become a zero count.
			if fixture != "ees_schema.sql" {
				if err := db.QueryRow(`SELECT json_agg(u ORDER BY id)::text FROM users u`).Scan(&usersBefore); err != nil {
					t.Fatal(err)
				}
			}
			report, err := auditDatabase(context.Background(), db, url)
			if err != nil {
				t.Fatal(err)
			}
			if !report.ReadOnly || report.FormatVersion != 1 {
				t.Fatal(report)
			}
			if !reflect.DeepEqual(before, fingerprint()) {
				t.Fatal("audit changed schema or catalog")
			}
			if fixture != "ees_schema.sql" {
				var after string
				if err := db.QueryRow(`SELECT json_agg(u ORDER BY id)::text FROM users u`).Scan(&after); err != nil || after != usersBefore {
					t.Fatal("audit changed users", err)
				}
			}
			body, _ := json.Marshal(report)
			for _, secret := range []string{"Alice", "Bob", "param_value", "password"} {
				if strings.Contains(string(body), secret) {
					t.Fatal("report leaked row content", secret)
				}
			}
			if fixture == "fresh" && report.Status != "no_findings_in_audited_scope" {
				t.Fatal(report)
			}
			if fixture == "repeated-bootstrap" && (report.Counts["duplicateLegacyNameGroups"] == nil || *report.Counts["duplicateLegacyNameGroups"] != 2) {
				t.Fatal(report)
			}
			if fixture == "ees_schema.sql" && report.Counts["legacyUsers"] != nil {
				t.Fatal("absent table presented as zero")
			}
			if fixture != "fresh" && report.Version != nil {
				t.Fatal("audit silently migrated legacy database")
			}
		})
	}
}

func TestDatabaseAuditFindingsPostgres(t *testing.T) {
	db := migrationTestDatabase(t)
	url := migrationSourceURL(t)
	if err := runMigrationsFromSource(db, url); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(`INSERT INTO circuit_schemes(name,owner_id) VALUES('Audit fixture',2147483647); UPDATE schema_migrations SET dirty=true; UPDATE schema_migration_integrity SET sha256=repeat('a',64) WHERE version=(SELECT min(version) FROM schema_migration_integrity)`); err != nil {
		t.Fatal(err)
	}
	r, err := auditDatabase(context.Background(), db, url)
	if err != nil {
		t.Fatal(err)
	}
	if r.Dirty == nil || !*r.Dirty || *r.Counts["checksumMismatches"] != 1 || *r.Counts["unresolvedLegacyOwners"] != 1 {
		t.Fatal(r)
	}
	joined := strings.Join(r.Findings, ",")
	for _, code := range []string{"dirty_migration", "migration_checksum_mismatch", "unresolved_legacy_owner_ids"} {
		if !strings.Contains(joined, code) {
			t.Fatal("missing finding", code)
		}
	}
	// Missing source must produce an error, not a successful partial report.
	if _, err := auditDatabase(context.Background(), db, "file://"+filepath.ToSlash(t.TempDir())); err == nil {
		t.Fatal("empty source accepted")
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := auditDatabase(ctx, db, url); err == nil {
		t.Fatal("cancelled audit accepted")
	}
	for _, marker := range []struct {
		value   int64
		finding string
	}{
		{20990101001, "database_newer_than_source"}, {20260701001, "version_absent_from_source"},
	} {
		if _, err := db.Exec(`UPDATE schema_migrations SET version=$1,dirty=false`, marker.value); err != nil {
			t.Fatal(err)
		}
		report, err := auditDatabase(context.Background(), db, url)
		if err != nil || !strings.Contains(strings.Join(report.Findings, ","), marker.finding) {
			t.Fatal("unsupported version hidden", report, err)
		}
	}
	if _, err := db.Exec(`DELETE FROM schema_migrations`); err != nil {
		t.Fatal(err)
	}
	report, err := auditDatabase(context.Background(), db, url)
	if err != nil || report.Version != nil || report.Dirty != nil || *report.Counts["migrationVersionRows"] != 0 || !strings.Contains(strings.Join(report.Findings, ","), "invalid_migration_version_row_count") {
		t.Fatal("empty metadata fabricated a version", report, err)
	}
}
