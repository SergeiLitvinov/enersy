package main

import (
	"context"
	"database/sql"
	"fmt"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/golang-migrate/migrate/v4/source"
)

type databaseAudit struct {
	FormatVersion            int               `json:"formatVersion"`
	Scope                    string            `json:"scope"`
	Status                   string            `json:"status"`
	ReadOnly                 bool              `json:"readOnly"`
	CapturedAt               time.Time         `json:"capturedAt"`
	LatestSourceVersion      string            `json:"latestSourceVersion"`
	Version                  *string           `json:"version"`
	Dirty                    *bool             `json:"dirty"`
	Counts                   map[string]*int64 `json:"counts"`
	ReferenceChecks          map[string]*int64 `json:"referenceChecks"`
	IdentityChecks           map[string]*int64 `json:"identityChecks"`
	DependencyChecks         map[string]*int64 `json:"dependencyChecks"`
	DependencyReviewRequired bool              `json:"dependencyReviewRequired"`
	Findings                 []string          `json:"findings"`
}

// Operator-only inventory. It neither applies migrations nor enrolls legacy checksums.
// All database reads share one read-only REPEATABLE READ transaction. Names,
// credentials, parameters and user rows never enter the report.
func auditDatabase(ctx context.Context, database *sql.DB, sourceURL string) (databaseAudit, error) {
	r := databaseAudit{FormatVersion: 1, Scope: "legacy-bootstrap-and-migration-inventory", Status: "review_required", ReadOnly: true,
		Counts: map[string]*int64{"legacyUsers": nil, "duplicateLegacyNameGroups": nil, "unresolvedLegacyOwners": nil,
			"migrationVersionRows": nil, "checksumMismatches": nil, "unexpectedIntegrityEntries": nil, "missingIntegrityEntries": nil, "legacyBaselineEntries": nil}, Findings: []string{}}
	files, err := source.Open(sourceURL)
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
	tx, err := beginReadOnlyAudit(ctx, database)
	if err != nil {
		return r, err
	}
	defer rollbackTx(tx)
	if err = tx.QueryRowContext(ctx, `SELECT transaction_timestamp()`).Scan(&r.CapturedAt); err != nil {
		return r, err
	}
	var schema string
	if err = tx.QueryRowContext(ctx, `SELECT current_schema()`).Scan(&schema); err != nil {
		return r, err
	}
	hasTable := func(name string) (bool, error) {
		var present bool
		err := tx.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1 AND c.relname=$2 AND c.relkind IN ('r','p'))`, schema, name).Scan(&present)
		return present, err
	}
	hasColumn := func(table, column string) (bool, error) {
		var present bool
		err := tx.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema=$1 AND table_name=$2 AND column_name=$3)`, schema, table, column).Scan(&present)
		return present, err
	}
	count := func(key, query string) error {
		var value int64
		if err := tx.QueryRowContext(ctx, query).Scan(&value); err != nil {
			return fmt.Errorf("audit %s: %w", key, err)
		}
		r.Counts[key] = &value
		return nil
	}
	// Fixed identifiers are schema-qualified to exclude fallback through search_path.
	qualified := func(table string) string { return `"` + strings.ReplaceAll(schema, `"`, `""`) + `"."` + table + `"` }
	users, err := hasTable("users")
	if err != nil {
		return r, err
	}
	if users {
		if err = count("legacyUsers", `SELECT count(*) FROM `+qualified("users")); err != nil {
			return r, err
		}
		if err = count("duplicateLegacyNameGroups", `SELECT count(*) FROM (SELECT name FROM `+qualified("users")+` GROUP BY name HAVING count(*)>1) d`); err != nil {
			return r, err
		}
		if *r.Counts["duplicateLegacyNameGroups"] > 0 {
			r.Findings = append(r.Findings, "legacy_user_name_duplicates_require_reference_review")
		}
	} else {
		r.Counts["legacyUsers"] = nil
		r.Counts["duplicateLegacyNameGroups"] = nil
		r.Findings = append(r.Findings, "legacy_users_table_absent")
	}
	schemes, err := hasTable("circuit_schemes")
	if err != nil {
		return r, err
	}
	owner, err := hasColumn("circuit_schemes", "owner_id")
	if err != nil {
		return r, err
	}
	r.Counts["unresolvedLegacyOwners"] = nil
	if schemes && users && owner {
		if err = count("unresolvedLegacyOwners", `SELECT count(*) FROM `+qualified("circuit_schemes")+` s LEFT JOIN `+qualified("users")+` u ON u.id=s.owner_id WHERE s.owner_id IS NOT NULL AND u.id IS NULL`); err != nil {
			return r, err
		}
		if *r.Counts["unresolvedLegacyOwners"] > 0 {
			r.Findings = append(r.Findings, "unresolved_legacy_owner_ids")
		}
	} else {
		r.Findings = append(r.Findings, "legacy_owner_links_not_assessed")
	}
	versioned, err := hasTable("schema_migrations")
	if err != nil {
		return r, err
	}
	var version uint64
	if versioned {
		if err = count("migrationVersionRows", `SELECT count(*) FROM `+qualified("schema_migrations")); err != nil {
			return r, err
		}
		if *r.Counts["migrationVersionRows"] != 1 {
			r.Findings = append(r.Findings, "invalid_migration_version_row_count")
			versioned = false
		}
	}
	if versioned {
		var dirty bool
		var value int64
		if err = tx.QueryRowContext(ctx, `SELECT version,dirty FROM `+qualified("schema_migrations")).Scan(&value, &dirty); err != nil {
			return r, err
		}
		v := strconv.FormatInt(value, 10)
		r.Version, r.Dirty = &v, &dirty
		if value < 0 {
			r.Findings = append(r.Findings, "invalid_migration_version")
		} else {
			version = uint64(value)
		}
		if dirty {
			r.Findings = append(r.Findings, "dirty_migration")
		}
		if version > uint64(latest) {
			r.Findings = append(r.Findings, "database_newer_than_source")
		}
		if _, ok := manifest.scripts[uint(version)]; !ok {
			r.Findings = append(r.Findings, "version_absent_from_source")
		}
		if version < uint64(latest) {
			r.Findings = append(r.Findings, "pending_migrations")
		}
	} else {
		r.Findings = append(r.Findings, "unversioned_database")
	}
	integrity, err := hasTable("schema_migration_integrity")
	if err != nil {
		return r, err
	}
	if integrity {
		// #nosec G202 -- qualified quotes the DB schema and this fixed table name.
		rows, err := tx.QueryContext(ctx, `SELECT version,sha256,origin FROM `+qualified("schema_migration_integrity")+` ORDER BY version`)
		if err != nil {
			return r, err
		}
		seen := map[uint]bool{}
		var mismatches, unknown, baselines int64
		for rows.Next() {
			var v uint
			var hash, origin string
			if err = rows.Scan(&v, &hash, &origin); err != nil {
				rows.Close()
				return r, err
			}
			seen[v] = true
			script, ok := manifest.scripts[v]
			if !ok || uint64(v) > version {
				unknown++
			} else if script.hash != hash {
				mismatches++
			}
			if origin == "legacy-baseline" {
				baselines++
			}
		}
		err = rows.Err()
		rows.Close()
		if err != nil {
			return r, err
		}
		var missing int64
		for v := range manifest.scripts {
			if uint64(v) <= version && !seen[v] {
				missing++
			}
		}
		r.Counts["checksumMismatches"], r.Counts["unexpectedIntegrityEntries"], r.Counts["missingIntegrityEntries"], r.Counts["legacyBaselineEntries"] = &mismatches, &unknown, &missing, &baselines
		if mismatches > 0 {
			r.Findings = append(r.Findings, "migration_checksum_mismatch")
		}
		if unknown > 0 {
			r.Findings = append(r.Findings, "unexpected_integrity_entries")
		}
		if missing > 0 {
			r.Findings = append(r.Findings, "missing_integrity_entries")
		}
		if baselines > 0 {
			r.Findings = append(r.Findings, "legacy_baseline_is_not_historical_proof")
		}
	} else {
		r.Findings = append(r.Findings, "integrity_table_absent")
	}
	r.ReferenceChecks, err = auditLegacyReferences(ctx, tx, schema)
	if err != nil {
		return r, err
	}
	for _, count := range r.ReferenceChecks {
		if count == nil {
			r.Findings = append(r.Findings, "legacy_reference_checks_incomplete")
			break
		}
	}
	r.IdentityChecks, err = auditLegacyIdentities(ctx, tx, schema)
	if err != nil {
		return r, err
	}
	for _, count := range r.IdentityChecks {
		if count == nil {
			r.Findings = append(r.Findings, "legacy_identity_checks_incomplete")
			break
		}
	}
	for _, count := range r.IdentityChecks {
		if count != nil && *count > 0 {
			r.Findings = append(r.Findings, "legacy_identity_ambiguities_require_review")
			break
		}
	}
	for _, count := range r.ReferenceChecks {
		if count != nil && *count > 0 {
			r.Findings = append(r.Findings, "legacy_references_require_review")
			break
		}
	}
	r.DependencyChecks, err = auditLegacyDependencies(ctx, tx, schema)
	if err != nil {
		return r, err
	}
	// Incoming FK metadata is a migration-planning inventory, not a data
	// integrity finding: extra constraints and NOT VALID are legal in fresh DBs.
	// Keep its review signal separate from the existing integrity status.
	for key, count := range r.DependencyChecks {
		if count == nil || (!strings.HasSuffix(key, ".total") && *count > 0) {
			r.DependencyReviewRequired = true
			break
		}
	}

	sort.Strings(r.Findings)
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
