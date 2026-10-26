package main

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"math"
	"regexp"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"
)

var errPassportInput = errors.New("invalid passport document or units")
var errPassportConflict = errors.New("passport version or command conflict")
var errPassportQuota = errors.New("project passport quota exceeded")
var passportNumber = regexp.MustCompile(`^-?(0|[1-9][0-9]*)(\.[0-9]+)?([eE][+-]?[0-9]+)?$`)

type passportParameter struct {
	Value string `json:"value"`
	Unit  string `json:"unit"`
}
type passportDocument struct {
	FormatVersion     int                          `json:"formatVersion"`
	ComponentTypeCode string                       `json:"componentTypeCode"`
	Name              string                       `json:"name"`
	Manufacturer      string                       `json:"manufacturer"`
	Source            string                       `json:"source"`
	License           string                       `json:"license"`
	Parameters        map[string]passportParameter `json:"parameters"`
}
type passportVersion struct {
	ID              string           `json:"id"`
	ProjectID       string           `json:"projectId"`
	AuthorAccountID string           `json:"authorAccountId"`
	PredecessorID   *string          `json:"predecessorId"`
	Revision        int              `json:"revision"`
	Status          string           `json:"status"`
	SHA256          string           `json:"sha256"`
	CreatedAt       time.Time        `json:"createdAt"`
	Document        passportDocument `json:"document"`
}

func passportText(value string, maxLength int, required bool) bool {
	return utf8.ValidString(value) && !strings.ContainsRune(value, 0) && utf8.RuneCountInString(value) <= maxLength && (!required || strings.TrimSpace(value) != "")
}
func validatePassportDocument(doc passportDocument) error {
	if doc.FormatVersion != 1 || !passportText(doc.ComponentTypeCode, 50, true) || !passportText(doc.Name, 200, true) ||
		!passportText(doc.Manufacturer, 200, false) || !passportText(doc.Source, 4000, true) || !passportText(doc.License, 200, true) ||
		len(doc.Parameters) == 0 || len(doc.Parameters) > 128 {
		return errPassportInput
	}
	for key, param := range doc.Parameters {
		if !passportText(key, 50, true) || !passportText(param.Value, 1000, true) || !passportText(param.Unit, 20, false) {
			return errPassportInput
		}
	}
	return nil
}

// Validation checks declared legacy types and units; no default insertion or
// physical applicability claim. The parameter contract is retained in the bytes.
func checkPassportParameters(ctx context.Context, tx *sql.Tx, doc passportDocument) error {
	rows, err := tx.QueryContext(ctx, `SELECT t.param_key,t.param_type,coalesce(t.unit,'') FROM component_params_template t
 JOIN component_types c ON c.id=t.component_type_id WHERE c.code=$1`, doc.ComponentTypeCode)
	if err != nil {
		return err
	}
	defer rows.Close()
	found := make(map[string]bool)
	for rows.Next() {
		var key, kind, unit string
		if err := rows.Scan(&key, &kind, &unit); err != nil {
			return err
		}
		param, ok := doc.Parameters[key]
		if !ok {
			continue
		}
		if param.Unit != unit {
			return errPassportInput
		}
		switch kind {
		case "number":
			value, err := strconv.ParseFloat(param.Value, 64)
			if err != nil || !passportNumber.MatchString(param.Value) || math.IsNaN(value) || math.IsInf(value, 0) {
				return errPassportInput
			}
		case "boolean":
			if param.Value != "true" && param.Value != "false" {
				return errPassportInput
			}
		case "string":
		default:
			return errPassportInput
		}
		found[key] = true
	}
	if err := rows.Err(); err != nil {
		return err
	}
	if len(found) != len(doc.Parameters) {
		return errPassportInput
	}
	return nil
}

func scanPassport(row interface{ Scan(...any) error }) (passportVersion, error) {
	var v passportVersion
	var id, project, author int64
	var parent sql.NullInt64
	var body []byte
	err := row.Scan(&id, &project, &author, &parent, &v.Revision, &v.SHA256, &v.CreatedAt, &body)
	if err != nil {
		return v, err
	}
	if archiveDigest(body) != v.SHA256 || json.Unmarshal(body, &v.Document) != nil {
		return v, errArchiveCorrupt
	}
	v.ID = strconv.FormatInt(id, 10)
	v.ProjectID = strconv.FormatInt(project, 10)
	v.AuthorAccountID = strconv.FormatInt(author, 10)
	v.Status = "draft"
	if parent.Valid {
		text := strconv.FormatInt(parent.Int64, 10)
		v.PredecessorID = &text
	}
	return v, nil
}

// #nosec G101 -- SQL column names; this constant contains no credentials.
const passportColumns = `id,project_id,author_account_id,predecessor_id,revision,sha256,created_at,document`

func (store projectStore) SavePassport(ctx context.Context, token string, project int64, command string, parent *int64, doc passportDocument) (passportVersion, error) {
	var empty passportVersion
	if !commandUUID.MatchString(command) || (parent != nil && *parent <= 0) {
		return empty, errPassportInput
	}
	if err := validatePassportDocument(doc); err != nil {
		return empty, err
	}
	body, err := json.Marshal(doc)
	if err != nil || len(body) > 65536 {
		return empty, errPassportInput
	}
	digest := archiveDigest(body)
	tx, err := store.database.BeginTx(ctx, &sql.TxOptions{Isolation: sql.LevelReadCommitted})
	if err != nil {
		return empty, err
	}
	defer rollbackTx(tx)
	author, err := lockArchiveProject(ctx, tx, token, project, true)
	if err != nil {
		return empty, err
	}
	// Serialize versions, idempotent commands and the per-project quota together.
	if _, err = tx.ExecContext(ctx, `SELECT pg_advisory_xact_lock(hashtextextended('enersy-passports:' || $1::text,0))`, project); err != nil {
		return empty, err
	}
	existing, err := scanPassport(tx.QueryRowContext(ctx, `SELECT `+passportColumns+` FROM project_passports WHERE project_id=$1 AND command_id=$2`, project, command))
	if err == nil {
		sameParent := (parent == nil && existing.PredecessorID == nil) || (parent != nil && existing.PredecessorID != nil && strconv.FormatInt(*parent, 10) == *existing.PredecessorID)
		if existing.SHA256 != digest || !sameParent {
			return empty, errPassportConflict
		}
		return existing, tx.Commit()
	}
	if !errors.Is(err, sql.ErrNoRows) {
		return empty, err
	}
	if err := checkPassportParameters(ctx, tx, doc); err != nil {
		return empty, err
	}
	revision := 1
	if parent != nil {
		var code string
		var hasSuccessor bool
		err = tx.QueryRowContext(ctx, `SELECT component_type_code,revision,EXISTS(SELECT 1 FROM project_passports WHERE predecessor_id=$2) FROM project_passports WHERE project_id=$1 AND id=$2`, project, *parent).Scan(&code, &revision, &hasSuccessor)
		if err != nil {
			return empty, err
		}
		if hasSuccessor || code != doc.ComponentTypeCode || revision >= 1000000 {
			return empty, errPassportConflict
		}
		revision++
	}
	var count int
	var size int64
	if err := tx.QueryRowContext(ctx, `SELECT count(*),coalesce(sum(octet_length(document)),0) FROM project_passports WHERE project_id=$1`, project).Scan(&count, &size); err != nil {
		return empty, err
	}
	if count >= 1000 || size+int64(len(body)) > 16<<20 {
		return empty, errPassportQuota
	}
	v, err := scanPassport(tx.QueryRowContext(ctx, `INSERT INTO project_passports(project_id,author_account_id,command_id,predecessor_id,revision,component_type_code,document,sha256)
 VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING `+passportColumns, project, author, command, parent, revision, doc.ComponentTypeCode, body, digest))
	if err != nil {
		return empty, err
	}
	return v, tx.Commit()
}

func (store projectStore) ReadPassports(ctx context.Context, token string, project, after int64, limit int, id *int64) ([]passportVersion, error) {
	if after < 0 || limit < 1 || limit > 100 {
		return nil, errPassportInput
	}
	tx, err := store.database.BeginTx(ctx, &sql.TxOptions{Isolation: sql.LevelReadCommitted})
	if err != nil {
		return nil, err
	}
	defer rollbackTx(tx)
	if _, err := lockArchiveProject(ctx, tx, token, project, false); err != nil {
		return nil, err
	}
	rows, err := tx.QueryContext(ctx, `SELECT `+passportColumns+` FROM project_passports WHERE project_id=$1 AND id>$2 AND ($4::bigint IS NULL OR id=$4) ORDER BY id LIMIT $3`, project, after, limit, id)
	if err != nil {
		return nil, err
	}
	result := []passportVersion{}
	for rows.Next() {
		v, err := scanPassport(rows)
		if err != nil {
			rows.Close()
			return nil, err
		}
		result = append(result, v)
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return nil, err
	}
	if id != nil && len(result) == 0 {
		return nil, sql.ErrNoRows
	}
	return result, tx.Commit()
}
