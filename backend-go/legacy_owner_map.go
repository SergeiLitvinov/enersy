package main

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"strconv"
	"strings"

	"github.com/lib/pq"
)

// Set distinguishes a deliberately supplied JSON null from an omitted field.
type legacyOwnerID struct {
	Value *string
	Set   bool
}

func (id *legacyOwnerID) UnmarshalJSON(body []byte) error {
	id.Set = true
	if err := json.Unmarshal(body, &id.Value); err != nil {
		return err
	}
	if id.Value != nil {
		if !canonicalLegacyOwnerID(*id.Value) {
			return fmt.Errorf("owner ID must be an exact decimal string or null")
		}
	}
	return nil
}

func canonicalLegacyOwnerID(value string) bool {
	id, err := strconv.ParseInt(value, 10, 64)
	return err == nil && strconv.FormatInt(id, 10) == value
}

func (id legacyOwnerID) MarshalJSON() ([]byte, error) { return json.Marshal(id.Value) }

type legacyOwnerChange struct {
	SchemeID       string        `json:"schemeId"`
	ExpectedSHA256 string        `json:"expectedSchemeSha256"`
	FromOwnerID    legacyOwnerID `json:"fromOwnerId"`
	ToOwnerID      legacyOwnerID `json:"toOwnerId"`
	Reason         string        `json:"reason"`
}

type legacyOwnerMap struct {
	FormatVersion   int                 `json:"formatVersion"`
	Scope           string              `json:"scope"`
	Database        string              `json:"database"`
	Schema          string              `json:"schema"`
	SourceVersion   string              `json:"sourceVersion"`
	MigrationSHA256 string              `json:"migrationSha256"`
	SnapshotSHA256  string              `json:"snapshotSha256"`
	Changes         []legacyOwnerChange `json:"changes"`
}

type legacyOwnerRow struct {
	ID        string  `json:"id"`
	RowSHA256 string  `json:"rowSha256"`
	OwnerID   *string `json:"ownerId"`
	ProjectID *string `json:"projectId"`
}

type legacyOwnerInventory struct {
	FormatVersion   int              `json:"formatVersion"`
	Scope           string           `json:"scope"`
	ReadOnly        bool             `json:"readOnly"`
	Database        string           `json:"database"`
	Schema          string           `json:"schema"`
	SourceVersion   string           `json:"sourceVersion"`
	MigrationSHA256 string           `json:"migrationSha256"`
	SnapshotSHA256  string           `json:"snapshotSha256"`
	Users           []legacyOwnerRow `json:"users"`
	Schemes         []legacyOwnerRow `json:"schemes"`
}

type legacyOwnerMapResult struct {
	FormatVersion        int                 `json:"formatVersion"`
	Scope                string              `json:"scope"`
	Status               string              `json:"status"`
	ReadOnly             bool                `json:"readOnly"`
	MapSHA256            string              `json:"mapSha256"`
	BeforeSnapshotSHA256 string              `json:"beforeSnapshotSha256"`
	AfterSnapshotSHA256  string              `json:"afterSnapshotSha256"`
	Changes              []legacyOwnerChange `json:"changes"`
}

func ownerDigest(value any) (string, error) {
	body, err := json.Marshal(value)
	if err != nil {
		return "", err
	}
	hash := sha256.Sum256(body)
	return hex.EncodeToString(hash[:]), nil
}

func readLegacyOwnerMap(input io.Reader) (legacyOwnerMap, error) {
	plan, err := readOperatorMap[legacyOwnerMap](input)
	if err != nil {
		return plan, err
	}
	return plan, validateLegacyOwnerMap(plan)
}

func validateLegacyOwnerMap(plan legacyOwnerMap) error {
	if plan.FormatVersion != 1 || plan.Scope != "legacy-scheme-owner-map" || plan.Database == "" || plan.Schema == "" ||
		!decimalString(plan.SourceVersion) || !catalogHash.MatchString(plan.MigrationSHA256) || !catalogHash.MatchString(plan.SnapshotSHA256) || len(plan.Changes) == 0 || len(plan.Changes) > 1000 {
		return fmt.Errorf("invalid legacy owner map header or change count")
	}
	seen := map[string]bool{}
	for i, c := range plan.Changes {
		if !canonicalCatalogID(c.SchemeID) || seen[c.SchemeID] || !catalogHash.MatchString(c.ExpectedSHA256) || !c.FromOwnerID.Set || !c.ToOwnerID.Set ||
			strings.TrimSpace(c.Reason) == "" || len(c.Reason) > 1000 || (c.ToOwnerID.Value != nil && !canonicalCatalogID(*c.ToOwnerID.Value)) {
			return fmt.Errorf("invalid legacy owner map change %d", i+1)
		}
		if c.FromOwnerID.Value != nil && !canonicalLegacyOwnerID(*c.FromOwnerID.Value) {
			return fmt.Errorf("invalid source owner ID in change %d", i+1)
		}
		if c.FromOwnerID.Value == nil && c.ToOwnerID.Value == nil || c.FromOwnerID.Value != nil && c.ToOwnerID.Value != nil && *c.FromOwnerID.Value == *c.ToOwnerID.Value {
			return fmt.Errorf("legacy owner map change %d is a no-op", i+1)
		}
		seen[c.SchemeID] = true
	}
	return nil
}

func readLegacyOwnersTx(ctx context.Context, tx *sql.Tx, version, migrationHash string) (legacyOwnerInventory, error) {
	r := legacyOwnerInventory{FormatVersion: 1, Scope: "legacy-scheme-owner-inventory", ReadOnly: true, SourceVersion: version, MigrationSHA256: migrationHash,
		Users: []legacyOwnerRow{}, Schemes: []legacyOwnerRow{}}
	if err := tx.QueryRowContext(ctx, `SELECT current_database(),current_schema()`).Scan(&r.Database, &r.Schema); err != nil {
		return r, err
	}
	queries := []string{
		`SELECT id::text,encode(sha256(convert_to(to_jsonb(u)::text,'UTF8')),'hex'),NULL::text,NULL::text FROM users u ORDER BY id LIMIT 100001`,
		`SELECT id::text,encode(sha256(convert_to(to_jsonb(s)::text,'UTF8')),'hex'),owner_id::text,project_id::text FROM circuit_schemes s ORDER BY id LIMIT 100001`,
	}
	for i, query := range queries {
		rows, err := tx.QueryContext(ctx, query)
		if err != nil {
			return r, err
		}
		items := []legacyOwnerRow{}
		for rows.Next() {
			var row legacyOwnerRow
			if err = rows.Scan(&row.ID, &row.RowSHA256, &row.OwnerID, &row.ProjectID); err != nil {
				rows.Close()
				return r, err
			}
			items = append(items, row)
			if len(items) > catalogRowLimit {
				rows.Close()
				return r, fmt.Errorf("legacy owner inventory exceeds row limit")
			}
		}
		err = rows.Err()
		rows.Close()
		if err != nil {
			return r, err
		}
		if i == 0 {
			r.Users = items
		} else {
			r.Schemes = items
		}
	}
	hash, err := ownerDigest(struct {
		Users   []legacyOwnerRow `json:"users"`
		Schemes []legacyOwnerRow `json:"schemes"`
	}{r.Users, r.Schemes})
	r.SnapshotSHA256 = hash
	return r, err
}

func auditLegacyOwners(ctx context.Context, db *sql.DB, url string) (legacyOwnerInventory, error) {
	version, digest, err := catalogMigrationIdentity(url)
	if err != nil {
		return legacyOwnerInventory{}, err
	}
	tx, err := beginReadOnlyAudit(ctx, db)
	if err != nil {
		return legacyOwnerInventory{}, err
	}
	defer rollbackTx(tx)
	var schema string
	if err = tx.QueryRowContext(ctx, `SELECT current_schema()`).Scan(&schema); err != nil {
		return legacyOwnerInventory{}, err
	}
	if _, err = tx.ExecContext(ctx, `SELECT set_config('search_path',$1,true)`, pq.QuoteIdentifier(schema)); err != nil {
		return legacyOwnerInventory{}, err
	}
	if err = checkOperatorMigrationHistory(ctx, tx, url, version); err != nil {
		return legacyOwnerInventory{}, err
	}
	r, err := readLegacyOwnersTx(ctx, tx, version, digest)
	if err != nil {
		return r, err
	}
	endVersion, endDigest, err := catalogMigrationIdentity(url)
	if err != nil || endVersion != version || endDigest != digest {
		return r, fmt.Errorf("migration source changed during owner inventory")
	}
	return r, tx.Commit()
}

func executeLegacyOwnerMap(ctx context.Context, db *sql.DB, url string, plan legacyOwnerMap, apply bool) (legacyOwnerMapResult, error) {
	result := legacyOwnerMapResult{}
	if err := validateLegacyOwnerMap(plan); err != nil {
		return result, err
	}
	version, digest, err := catalogMigrationIdentity(url)
	if err != nil || version != plan.SourceVersion || digest != plan.MigrationSHA256 {
		return result, fmt.Errorf("legacy owner map migration source changed")
	}
	var tx *sql.Tx
	if apply {
		tx, err = db.BeginTx(ctx, &sql.TxOptions{Isolation: sql.LevelReadCommitted})
	} else {
		tx, err = beginReadOnlyAudit(ctx, db)
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
	if dbName != plan.Database || schema != plan.Schema {
		return result, fmt.Errorf("legacy owner map targets another database or schema")
	}
	if _, err = tx.ExecContext(ctx, `SELECT set_config('search_path',$1,true)`, pq.QuoteIdentifier(schema)); err != nil {
		return result, err
	}
	if apply {
		if _, err = tx.ExecContext(ctx, `LOCK TABLE schema_migrations,schema_migration_integrity,users,circuit_schemes IN SHARE ROW EXCLUSIVE MODE`); err != nil {
			return result, err
		}
	}
	if err = checkOperatorMigrationHistory(ctx, tx, url, version); err != nil {
		return result, err
	}
	before, err := readLegacyOwnersTx(ctx, tx, version, digest)
	if err != nil {
		return result, err
	}
	if before.SnapshotSHA256 != plan.SnapshotSHA256 {
		return result, fmt.Errorf("legacy owner source snapshot changed")
	}
	if err = checkLegacyOwnerBindings(before, plan); err != nil {
		return result, err
	}
	if apply {
		for _, c := range plan.Changes {
			updated, err := tx.ExecContext(ctx, `UPDATE circuit_schemes SET owner_id=$1 WHERE id=$2 AND owner_id IS NOT DISTINCT FROM $3::integer AND project_id IS NULL`, c.ToOwnerID.Value, c.SchemeID, c.FromOwnerID.Value)
			if err != nil {
				return result, err
			}
			count, err := updated.RowsAffected()
			if err != nil || count != 1 {
				return result, fmt.Errorf("legacy owner update did not affect exactly one scheme")
			}
		}
	}
	after, err := readLegacyOwnersTx(ctx, tx, version, digest)
	if err != nil {
		return result, err
	}
	endVersion, endDigest, err := catalogMigrationIdentity(url)
	if err != nil || version != endVersion || digest != endDigest {
		return result, fmt.Errorf("migration source changed during legacy owner map")
	}
	mapHash, err := ownerDigest(plan)
	if err != nil {
		return result, err
	}
	if err = tx.Commit(); err != nil {
		return result, err
	}
	status := "checked_not_applied"
	if apply {
		status = "applied"
	}
	return legacyOwnerMapResult{1, plan.Scope, status, !apply, mapHash, before.SnapshotSHA256, after.SnapshotSHA256, plan.Changes}, nil
}

func checkLegacyOwnerBindings(before legacyOwnerInventory, plan legacyOwnerMap) error {
	users, schemes := map[string]bool{}, map[string]legacyOwnerRow{}
	for _, row := range before.Users {
		if users[row.ID] {
			return fmt.Errorf("legacy owner inventory has duplicate legacy user IDs")
		}
		users[row.ID] = true
	}
	for _, row := range before.Schemes {
		if _, exists := schemes[row.ID]; exists {
			return fmt.Errorf("legacy owner inventory has duplicate legacy scheme IDs")
		}
		schemes[row.ID] = row
	}
	for i, c := range plan.Changes {
		row, exists := schemes[c.SchemeID]
		sameOwner := row.OwnerID == nil && c.FromOwnerID.Value == nil || row.OwnerID != nil && c.FromOwnerID.Value != nil && *row.OwnerID == *c.FromOwnerID.Value
		if !exists || row.ProjectID != nil || !sameOwner || row.RowSHA256 != c.ExpectedSHA256 || (c.ToOwnerID.Value != nil && !users[*c.ToOwnerID.Value]) {
			return fmt.Errorf("legacy owner map change %d is stale, private or has no target user", i+1)
		}
	}
	return nil
}
