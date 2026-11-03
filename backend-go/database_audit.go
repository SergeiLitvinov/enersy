package main

import (
	"context"
	"database/sql"
	"fmt"
	"sort"
	"strconv"
	"time"

	"github.com/golang-migrate/migrate/v4/source"
	"github.com/lib/pq"
)

type databaseAudit struct {
	FormatVersion       int               `json:"formatVersion"`
	Scope               string            `json:"scope"`
	Status              string            `json:"status"`
	ReadOnly            bool              `json:"readOnly"`
	CapturedAt          time.Time         `json:"capturedAt"`
	LatestSourceVersion string            `json:"latestSourceVersion"`
	Version             *string           `json:"version"`
	Dirty               *bool             `json:"dirty"`
	Counts              map[string]*int64 `json:"counts"`
	Findings            []string          `json:"findings"`
}

// This is an integrity inventory of the v1 domain, never a legacy importer.
// It takes one read-only snapshot and emits aggregate counts, not user rows.
func auditDatabase(ctx context.Context, db *sql.DB, url string) (databaseAudit, error) {
	r := databaseAudit{FormatVersion: 1, Scope: "database-v1-integrity", Status: "review_required", ReadOnly: true, CapturedAt: time.Now().UTC(), Counts: map[string]*int64{}, Findings: []string{}}
	files, err := source.Open(url)
	if err != nil {
		return r, err
	}
	defer files.Close()
	manifest, err := snapshotMigrations(files)
	if err != nil {
		return r, err
	}
	var latest uint
	for v := range manifest.scripts {
		if v > latest {
			latest = v
		}
	}
	r.LatestSourceVersion = strconv.FormatUint(uint64(latest), 10)
	tx, err := beginReadOnlyAudit(ctx, db)
	if err != nil {
		return r, err
	}
	defer rollbackTx(tx)
	var schema string
	if err = tx.QueryRowContext(ctx, `SELECT current_schema()`).Scan(&schema); err != nil {
		return r, err
	}
	qualified := func(name string) string { return pq.QuoteIdentifier(schema) + "." + pq.QuoteIdentifier(name) }
	present := func(name string) (bool, error) {
		var found bool
		err := tx.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1 AND c.relname=$2 AND c.relkind IN ('r','p'))`, schema, name).Scan(&found)
		return found, err
	}
	count := func(name, key string) (bool, error) {
		r.Counts[key] = nil
		found, err := present(name)
		if err != nil || !found {
			return found, err
		}
		var n int64
		err = tx.QueryRowContext(ctx, "SELECT count(*) FROM "+qualified(name)).Scan(&n)
		if err == nil {
			r.Counts[key] = &n
		}
		return true, err
	}
	tables := []string{"auth_accounts", "auth_local_credentials", "auth_sessions", "circuit_schemes", "component_params_template", "component_type_ports", "component_types", "connection_commands", "project_application_commands", "equipment_model_params", "equipment_models", "scheme_components", "scheme_connections", "project_calculation_archives", "project_editor_drafts", "project_members", "project_passports", "project_studies", "project_study_run_cancellations", "project_study_run_leases", "project_study_runs", "project_study_versions", "projects", "scheme_component_params"}
	for _, name := range tables {
		ok, e := count(name, "tables."+name)
		if e != nil {
			return r, e
		}
		if !ok {
			r.Findings = append(r.Findings, "schema_incomplete")
		}
	}
	found, err := present("schema_migrations")
	if err != nil {
		return r, err
	}
	if found {
		var n int64
		var version sql.NullInt64
		var dirty sql.NullBool
		if err = tx.QueryRowContext(ctx, "SELECT count(*),min(version),bool_or(dirty) FROM "+qualified("schema_migrations")).Scan(&n, &version, &dirty); err != nil {
			return r, err
		}
		if n != 1 || !version.Valid || !dirty.Valid {
			r.Findings = append(r.Findings, "migration_history_invalid")
		} else {
			value := strconv.FormatInt(version.Int64, 10)
			r.Version = &value
			r.Dirty = &dirty.Bool
			if version.Int64 < 0 || uint64(version.Int64) != uint64(latest) {
				r.Findings = append(r.Findings, "unsupported_database_version")
			}
			if dirty.Bool {
				r.Findings = append(r.Findings, "dirty_migration")
			}
		}
	} else {
		r.Findings = append(r.Findings, "migration_history_missing")
	}
	found, err = count("schema_migration_integrity", "migrationIntegrityRecords")
	if err != nil {
		return r, err
	}
	if !found {
		r.Findings = append(r.Findings, "migration_integrity_missing")
	} else {
		// #nosec G202 -- only current_schema() is interpolated, and qualified quotes both identifiers with pq.QuoteIdentifier.
		rows, e := tx.QueryContext(ctx, "SELECT version,sha256,origin FROM "+qualified("schema_migration_integrity"))
		if e != nil {
			return r, e
		}
		expected := map[string]migrationScript{}
		for version, script := range manifest.scripts {
			expected[strconv.FormatUint(uint64(version), 10)] = script
		}
		seen := map[string]bool{}
		for rows.Next() {
			var id int64
			var hash, origin string
			if e = rows.Scan(&id, &hash, &origin); e != nil {
				rows.Close()
				return r, e
			}
			key := strconv.FormatInt(id, 10)
			script, exists := expected[key]
			if id < 0 || !exists || seen[key] || hash != script.hash || origin != "applied" {
				r.Findings = append(r.Findings, "migration_integrity_mismatch")
			}
			seen[key] = true
		}
		e = rows.Err()
		rows.Close()
		if e != nil {
			return r, e
		}
		if len(seen) != len(manifest.scripts) {
			r.Findings = append(r.Findings, "migration_integrity_incomplete")
		}
	}
	for key, query := range map[string]string{
		"unvalidatedConstraints": `SELECT count(*) FROM pg_constraint c JOIN pg_namespace n ON n.oid=c.connamespace WHERE n.nspname=$1 AND c.contype IN ('f','c') AND NOT c.convalidated`,
		"disabledTriggers":       `SELECT count(*) FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1 AND NOT t.tgisinternal AND t.tgenabled='D'`,
	} {
		var n int64
		if err = tx.QueryRowContext(ctx, query, schema).Scan(&n); err != nil {
			return r, err
		}
		r.Counts[key] = &n
		if n > 0 {
			r.Findings = append(r.Findings, key)
		}
	}
	if r.Counts["tables.project_study_run_cancellations"] != nil && r.Counts["tables.project_study_runs"] != nil && r.Counts["tables.project_study_run_leases"] != nil {
		var conflicts int64
		// #nosec G202 -- Only fixed table names and current_schema() identifiers quoted by pq.QuoteIdentifier.
		query := "SELECT count(*) FROM " + qualified("project_study_run_cancellations") + " c LEFT JOIN " + qualified("project_study_runs") + " r ON r.id=c.run_id LEFT JOIN " + qualified("project_study_run_leases") + " l ON l.run_id=c.run_id WHERE r.id IS NULL OR r.project_id<>c.project_id OR l.run_id IS NOT NULL"
		if err = tx.QueryRowContext(ctx, query).Scan(&conflicts); err != nil {
			return r, err
		}
		r.Counts["runCancellationConflicts"] = &conflicts
		if conflicts > 0 {
			r.Findings = append(r.Findings, "run_cancellation_conflict")
		}
	}
	sort.Strings(r.Findings)
	unique := r.Findings[:0]
	for _, f := range r.Findings {
		if len(unique) == 0 || unique[len(unique)-1] != f {
			unique = append(unique, f)
		}
	}
	r.Findings = unique
	if len(r.Findings) == 0 {
		r.Status = "no_findings_in_audited_scope"
	}
	if err = tx.Commit(); err != nil {
		return r, err
	}
	return r, nil
}

func beginReadOnlyAudit(ctx context.Context, database *sql.DB) (*sql.Tx, error) {
	tx, err := database.BeginTx(ctx, &sql.TxOptions{ReadOnly: true, Isolation: sql.LevelRepeatableRead})
	if err != nil {
		return nil, err
	}
	var confirmed bool
	if err = tx.QueryRowContext(ctx, `SELECT current_setting('transaction_read_only')::boolean`).Scan(&confirmed); err != nil {
		rollbackTx(tx)
		return nil, err
	}
	if !confirmed {
		rollbackTx(tx)
		return nil, fmt.Errorf("database did not confirm a read-only audit transaction")
	}
	if _, err = tx.ExecContext(ctx, `SET LOCAL statement_timeout='5s'; SET LOCAL lock_timeout='1s'`); err != nil {
		rollbackTx(tx)
		return nil, err
	}
	return tx, nil
}
