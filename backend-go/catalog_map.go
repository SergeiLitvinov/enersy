package main

import (
	"bytes"
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"strconv"
	"strings"
	"unicode/utf8"

	"github.com/golang-migrate/migrate/v4/source"
	"github.com/lib/pq"
)

// An operator resolves every binding explicitly. No catalog row, parameter,
// user, permission, passport version or historical archive is merged or deleted.
type catalogMapChange struct {
	ComponentID      string `json:"componentId"`
	SchemeID         string `json:"schemeId"`
	ExpectedRevision string `json:"expectedRevision"`
	FromModelID      string `json:"fromModelId"`
	ToModelID        string `json:"toModelId"`
	Reason           string `json:"reason"`
}

type catalogMap struct {
	FormatVersion   int                `json:"formatVersion"`
	Scope           string             `json:"scope"`
	Database        string             `json:"database"`
	Schema          string             `json:"schema"`
	SnapshotSHA256  string             `json:"snapshotSha256"`
	BaselineSHA256  string             `json:"baselineSha256"`
	MigrationSHA256 string             `json:"migrationSha256"`
	Changes         []catalogMapChange `json:"changes"`
}

type catalogMapResult struct {
	FormatVersion  int                `json:"formatVersion"`
	Scope          string             `json:"scope"`
	Status         string             `json:"status"`
	ReadOnly       bool               `json:"readOnly"`
	MapSHA256      string             `json:"mapSha256"`
	SnapshotSHA256 string             `json:"snapshotSha256"`
	Changes        []catalogMapChange `json:"changes"`
}

func readCatalogMap(input io.Reader) (catalogMap, error) {
	plan, err := readOperatorMap[catalogMap](input)
	if err != nil {
		return plan, err
	}
	return plan, validateCatalogMap(plan)
}

func readOperatorMap[T any](input io.Reader) (T, error) {
	var plan T
	body, err := io.ReadAll(io.LimitReader(input, (1<<20)+1))
	if err != nil {
		return plan, err
	}
	if len(body) > 1<<20 {
		return plan, fmt.Errorf("operator map exceeds 1 MiB")
	}
	if !utf8.Valid(body) {
		return plan, fmt.Errorf("operator map must be UTF-8")
	}
	// encoding/json normally accepts duplicate members. Operator maps must have
	// one meaning in both a reviewer and Go; reject duplicates at every level.
	tokens := json.NewDecoder(bytes.NewReader(body))
	if err := checkOperatorMapJSON(tokens, 0); err != nil {
		return plan, err
	}
	if _, err := tokens.Token(); err != io.EOF {
		return plan, fmt.Errorf("operator map must contain exactly one JSON document")
	}
	decoder := json.NewDecoder(bytes.NewReader(body))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&plan); err != nil {
		return plan, err
	}
	return plan, nil
}

func checkOperatorMapJSON(d *json.Decoder, depth int) error {
	if depth > 16 {
		return fmt.Errorf("operator map JSON nesting exceeds limit")
	}
	token, err := d.Token()
	if err != nil {
		return err
	}
	delimiter, composite := token.(json.Delim)
	if !composite {
		return nil
	}
	if delimiter != '{' && delimiter != '[' {
		return fmt.Errorf("unexpected operator map JSON delimiter")
	}
	seen := map[string]bool{}
	for d.More() {
		if delimiter == '{' {
			key, err := d.Token()
			if err != nil {
				return err
			}
			name, ok := key.(string)
			// Both operator contracts have ASCII field names. encoding/json also
			// accepts Unicode case-fold aliases (for example long s -> S); exclude
			// them so a second spelling cannot bypass the duplicate-member check.
			if strings.IndexFunc(name, func(r rune) bool { return r > 127 }) >= 0 {
				return fmt.Errorf("operator map field names must be ASCII")
			}
			folded := strings.ToLower(name)
			if !ok || seen[folded] {
				return fmt.Errorf("duplicate or invalid operator map member")
			}
			seen[folded] = true
		}
		if err := checkOperatorMapJSON(d, depth+1); err != nil {
			return err
		}
	}
	_, err = d.Token()
	return err
}

func canonicalCatalogID(value string) bool {
	id, err := strconv.ParseInt(value, 10, 64)
	return err == nil && id > 0 && strconv.FormatInt(id, 10) == value
}

func validateCatalogMap(plan catalogMap) error {
	if plan.FormatVersion != 1 || plan.Scope != "legacy-model-reference-map" || plan.Database == "" || plan.Schema == "" ||
		!catalogHash.MatchString(plan.SnapshotSHA256) || !catalogHash.MatchString(plan.BaselineSHA256) || !catalogHash.MatchString(plan.MigrationSHA256) || len(plan.Changes) == 0 || len(plan.Changes) > 1000 {
		return fmt.Errorf("invalid catalog map header or change count")
	}
	seen := map[string]bool{}
	for i, change := range plan.Changes {
		if !canonicalCatalogID(change.ComponentID) || !canonicalCatalogID(change.SchemeID) || !canonicalCatalogID(change.ExpectedRevision) ||
			!canonicalCatalogID(change.FromModelID) || !canonicalCatalogID(change.ToModelID) || change.FromModelID == change.ToModelID ||
			seen[change.ComponentID] || strings.TrimSpace(change.Reason) == "" || len(change.Reason) > 1000 {
			return fmt.Errorf("invalid or duplicate catalog map change %d", i+1)
		}
		seen[change.ComponentID] = true
	}
	return nil
}

// Read-only verification and explicit application share all preconditions.
// Application uses short, exclusive maintenance locks before reading any data.
// It never calls the application bootstrap or migration runner.
func executeCatalogMap(ctx context.Context, database *sql.DB, url, baselinePath string, plan catalogMap, apply bool) (catalogMapResult, error) {
	result := catalogMapResult{}
	if err := validateCatalogMap(plan); err != nil {
		return result, err
	}
	b, err := readCatalogBaseline(baselinePath, url)
	if err != nil {
		return result, err
	}
	if plan.BaselineSHA256 != catalogDigest(b) || plan.MigrationSHA256 != b.MigrationSHA256 {
		return result, fmt.Errorf("catalog map baseline or migration source changed")
	}
	var tx *sql.Tx
	if apply {
		tx, err = database.BeginTx(ctx, &sql.TxOptions{Isolation: sql.LevelReadCommitted})
	} else {
		tx, err = beginReadOnlyAudit(ctx, database)
	}
	if err != nil {
		return result, err
	}
	defer rollbackTx(tx)
	if _, err = tx.ExecContext(ctx, `SET LOCAL lock_timeout='2s'; SET LOCAL statement_timeout='10s'`); err != nil {
		return result, err
	}
	var dbName, schema string
	if err = tx.QueryRowContext(ctx, `SELECT current_database(),current_schema()`).Scan(&dbName, &schema); err != nil {
		return result, err
	}
	if plan.Database != dbName || plan.Schema != schema {
		return result, fmt.Errorf("catalog map targets another database or schema")
	}
	if _, err = tx.ExecContext(ctx, `SELECT set_config('search_path',$1,true)`, pq.QuoteIdentifier(schema)); err != nil {
		return result, err
	}
	if apply {
		if _, err = tx.ExecContext(ctx, `LOCK TABLE schema_migrations,schema_migration_integrity,component_types,component_params_template,equipment_models,equipment_model_params,component_type_ports,circuit_schemes,scheme_components,scheme_component_params IN SHARE ROW EXCLUSIVE MODE`); err != nil {
			return result, err
		}
	}
	if err = checkOperatorMigrationHistory(ctx, tx, url, b.SourceVersion); err != nil {
		return result, err
	}
	if err = checkCatalogMapIdentities(ctx, tx, schema); err != nil {
		return result, err
	}
	snapshot, err := readCatalogSnapshotTx(ctx, tx)
	if err != nil {
		return result, err
	}
	for _, entity := range snapshot.Entities {
		if !entity.Available {
			return result, fmt.Errorf("catalog map requires all catalog sections")
		}
	}
	if plan.SnapshotSHA256 != catalogDigest(snapshot.Entities) {
		return result, fmt.Errorf("catalog map source snapshot changed")
	}
	for i, change := range plan.Changes {
		var valid bool
		err = tx.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM scheme_components c
JOIN circuit_schemes scheme ON scheme.id=c.scheme_id
JOIN component_types component_type ON component_type.id=c.component_type_id
JOIN equipment_models old ON old.id=c.equipment_model_id AND old.component_type_id=c.component_type_id
JOIN equipment_models target ON target.id=$5 AND target.component_type_id=c.component_type_id
WHERE c.id=$1 AND c.scheme_id=$2 AND c.revision=$3 AND c.equipment_model_id=$4 AND c.project_passport_version_id IS NULL)`,
			change.ComponentID, change.SchemeID, change.ExpectedRevision, change.FromModelID, change.ToModelID).Scan(&valid)
		if err != nil {
			return result, err
		}
		if !valid {
			return result, fmt.Errorf("catalog map change %d is stale, missing or has an incompatible type/binding", i+1)
		}
	}
	if apply {
		for _, change := range plan.Changes {
			// Explicitly change only the reference. The existing revision trigger
			// invalidates stale editors. Parameters and physical topology stay intact.
			updated, err := tx.ExecContext(ctx, `UPDATE scheme_components SET equipment_model_id=$1 WHERE id=$2 AND scheme_id=$3 AND revision=$4 AND equipment_model_id=$5`, change.ToModelID, change.ComponentID, change.SchemeID, change.ExpectedRevision, change.FromModelID)
			if err != nil {
				return result, err
			}
			count, err := updated.RowsAffected()
			if err != nil || count != 1 {
				return result, fmt.Errorf("catalog map binding update did not affect exactly one row")
			}
		}
	}
	version, digest, err := catalogMigrationIdentity(url)
	if err != nil || version != b.SourceVersion || digest != b.MigrationSHA256 {
		return result, fmt.Errorf("migration source changed during catalog map operation")
	}
	if err = tx.Commit(); err != nil {
		return result, err
	}
	body, _ := json.Marshal(plan) // Validated struct: no unsupported JSON values.
	hash := sha256.Sum256(body)
	status := "checked_not_applied"
	if apply {
		status = "applied"
	}
	return catalogMapResult{1, plan.Scope, status, !apply, hex.EncodeToString(hash[:]), plan.SnapshotSHA256, plan.Changes}, nil
}

func checkCatalogMapIdentities(ctx context.Context, tx *sql.Tx, schema string) error {
	tables := []string{"component_types", "equipment_models", "circuit_schemes", "scheme_components"}
	counts, err := auditLegacyIdentityTables(ctx, tx, schema, tables)
	if err != nil {
		return err
	}
	for _, table := range tables {
		for _, kind := range []string{"null", "duplicateGroups"} {
			count := counts[table+".id."+kind]
			if count == nil || *count != 0 {
				return fmt.Errorf("catalog map requires assessed, non-NULL unique IDs in %s", table)
			}
		}
	}
	return nil
}

func checkOperatorMigrationHistory(ctx context.Context, tx *sql.Tx, url, expectedVersion string) error {
	var versions int
	var version string
	var dirty bool
	if err := tx.QueryRowContext(ctx, `SELECT count(*),coalesce(min(version)::text,''),coalesce(bool_or(dirty),true) FROM schema_migrations`).Scan(&versions, &version, &dirty); err != nil {
		return err
	}
	if versions != 1 || dirty || version != expectedVersion {
		return fmt.Errorf("operator map requires a clean fully migrated database")
	}
	files, err := source.Open(url)
	if err != nil {
		return err
	}
	defer files.Close()
	manifest, err := snapshotMigrations(files)
	if err != nil {
		return err
	}
	rows, err := tx.QueryContext(ctx, `SELECT version,sha256,origin FROM schema_migration_integrity`)
	if err != nil {
		return err
	}
	defer rows.Close()
	seen := map[uint]bool{}
	for rows.Next() {
		var id uint
		var hash, origin string
		if err := rows.Scan(&id, &hash, &origin); err != nil {
			return err
		}
		script, exists := manifest.scripts[id]
		if !exists || seen[id] || hash != script.hash || (origin != "applied" && origin != "legacy-baseline") {
			return fmt.Errorf("operator map migration integrity mismatch")
		}
		seen[id] = true
	}
	if err := rows.Err(); err != nil {
		return err
	}
	if len(seen) != len(manifest.scripts) {
		return fmt.Errorf("operator map migration history is incomplete")
	}
	return nil
}
