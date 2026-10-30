package main

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"strconv"
	"time"
)

var errArchiveResult = errors.New("invalid successful calculation result")
var errArchiveQuota = errors.New("calculation archive quota exceeded")
var errArchiveCorrupt = errors.New("calculation archive integrity mismatch")

type calculationArchive struct {
	ProvenanceSHA256 string `json:"provenanceSha256,omitempty"`
	ProvenanceBytes  int64  `json:"provenanceBytes,omitempty"`
	provenance       []byte
	ID               string    `json:"id"`
	SchemeID         string    `json:"schemeId"`
	SchemeName       string    `json:"schemeName"`
	AuthorAccountID  string    `json:"authorAccountId"`
	TopologyRevision string    `json:"topologyRevision"`
	ModelGroup       string    `json:"modelGroup"`
	Method           string    `json:"method"`
	CreatedAt        time.Time `json:"createdAt"`
	InputSHA256      string    `json:"inputSha256"`
	ResultSHA256     string    `json:"resultSha256"`
	InputBytes       int64     `json:"inputBytes"`
	ResultBytes      int64     `json:"resultBytes"`
}
type calculationArchivePage struct {
	Items        []calculationArchive `json:"items"`
	NextBeforeID string               `json:"nextBeforeId,omitempty"`
}

func archiveDigest(body []byte) string {
	digest := sha256.Sum256(body)
	return hex.EncodeToString(digest[:])
}

// Project membership changes lock p FOR UPDATE. Session/account revocation also
// cannot pass our shared row locks while a result is being committed or read.
// Recheck AFTER acquiring locks under READ COMMITTED, without the worker call.
func lockArchiveProject(ctx context.Context, tx *sql.Tx, token string, project int64, writing bool) (int64, error) {
	hash, err := sessionTokenHash(token)
	if err != nil {
		return 0, sql.ErrNoRows
	}
	query := `SELECT a.id FROM projects p JOIN auth_sessions s ON s.token_hash=$2
 JOIN auth_accounts a ON a.id=s.account_id LEFT JOIN project_members m ON m.project_id=p.id AND m.account_id=a.id
 WHERE p.id=$1 AND s.revoked_at IS NULL AND s.expires_at>statement_timestamp() AND a.disabled_at IS NULL
 AND (p.owner_account_id=a.id OR m.role IN ('admin','editor') OR (NOT $3 AND m.role='viewer'))`
	var account int64
	if err := tx.QueryRowContext(ctx, query+` FOR SHARE OF p,s,a`, project, hash, writing).Scan(&account); err != nil {
		return 0, err
	}
	err = tx.QueryRowContext(ctx, query, project, hash, writing).Scan(&account)
	return account, err
}

func validateCalculationArchive(input calculationInput, group, method string, request, result []byte) error {
	if !confirmsRequestedUnitContract(request, result) {
		return errArchiveResult
	}
	var outcome struct {
		Success   bool              `json:"success"`
		NodeCount int               `json:"node_count"`
		Nodes     []json.RawMessage `json:"nodes"`
		Method    string            `json:"method_used"`
		Version   string            `json:"version"`
	}
	if len(request) == 0 || len(request) > computeBodyLimit || len(result) == 0 || len(result) > computeBodyLimit || !json.Valid(request) ||
		len(input.Provenance) > computeBodyLimit || (len(input.Provenance) > 0 && !json.Valid(input.Provenance)) ||
		json.Unmarshal(result, &outcome) != nil || !outcome.Success || outcome.NodeCount < 1 || outcome.NodeCount != len(outcome.Nodes) ||
		outcome.Method != group+"/"+method || outcome.Version == "" {
		return errArchiveResult
	}
	return nil
}

func (store projectStore) SaveCalculationArchive(ctx context.Context, token string, project int64, scheme int,
	input calculationInput, group, method string, request, result []byte) (int64, error) {
	if err := validateCalculationArchive(input, group, method, request, result); err != nil {
		return 0, err
	}
	tx, err := store.database.BeginTx(ctx, &sql.TxOptions{Isolation: sql.LevelReadCommitted})
	if err != nil {
		return 0, err
	}
	defer rollbackTx(tx)
	account, err := lockArchiveProject(ctx, tx, token, project, true)
	if err != nil {
		return 0, err
	}
	if account != input.AuthorAccountID {
		return 0, sql.ErrNoRows
	}
	// Preserve the historical revision, even if another client has since edited
	// the scheme. Only its current project ownership is rechecked here.
	var parent int
	if err := tx.QueryRowContext(ctx, `SELECT id FROM circuit_schemes WHERE id=$1 AND project_id=$2 FOR SHARE`, scheme, project).Scan(&parent); err != nil {
		return 0, err
	}
	id, err := insertCalculationArchive(ctx, tx, project, scheme, input, group, method, request, result, func() error {
		_, err := lockArchiveProject(ctx, tx, token, project, true)
		return err
	})
	if err != nil {
		return 0, err
	}
	return id, tx.Commit()
}

// Callers hold the project row and validate their own authority (session or
// execution lease). A failed final fence check rolls back this same transaction.
func insertCalculationArchive(ctx context.Context, tx *sql.Tx, project int64, scheme int, input calculationInput,
	group, method string, request, result []byte, beforeInsert func() error) (int64, error) {
	if _, err := tx.ExecContext(ctx, `SELECT pg_advisory_xact_lock(hashtextextended('enersy-calculation-archives:' || $1::text,0))`, project); err != nil {
		return 0, err
	}
	var count, size int64
	if err := tx.QueryRowContext(ctx, `SELECT count(*),coalesce(sum(octet_length(input_body)::bigint+octet_length(result_body)+coalesce(octet_length(provenance_body),0)),0)
 FROM project_calculation_archives WHERE project_id=$1`, project).Scan(&count, &size); err != nil {
		return 0, err
	}
	if count >= 100 || size+int64(len(request))+int64(len(result))+int64(len(input.Provenance)) > 64<<20 {
		return 0, errArchiveQuota
	}
	// A session or execution lease can expire while waiting for the quota lock.
	if err := beforeInsert(); err != nil {
		return 0, err
	}
	var id int64
	var provenanceDigest any
	var provenanceBody any
	if len(input.Provenance) > 0 {
		provenanceDigest = archiveDigest(input.Provenance)
		provenanceBody = input.Provenance
	}
	err := tx.QueryRowContext(ctx, `INSERT INTO project_calculation_archives
 (project_id,scheme_id,scheme_name,author_account_id,topology_revision,model_group,method,input_body,result_body,input_sha256,result_sha256,provenance_body,provenance_sha256)
 VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING id`, project, scheme, input.SchemeName, input.AuthorAccountID, input.TopologyRevision,
		group, method, request, result, archiveDigest(request), archiveDigest(result), provenanceBody, provenanceDigest).Scan(&id)
	if err != nil {
		return 0, err
	}
	return id, nil
}

const archiveColumns = `id,scheme_id,scheme_name,author_account_id,topology_revision,model_group,method,created_at,
 input_sha256,result_sha256,octet_length(input_body),octet_length(result_body),coalesce(provenance_sha256,''),coalesce(octet_length(provenance_body),0)`

type archiveScanner interface{ Scan(...any) error }

func scanArchive(row archiveScanner, body bool) (calculationArchive, []byte, []byte, error) {
	var value calculationArchive
	var id, scheme, account, revision int64
	var input, result []byte
	targets := []any{&id, &scheme, &value.SchemeName, &account, &revision, &value.ModelGroup, &value.Method, &value.CreatedAt,
		&value.InputSHA256, &value.ResultSHA256, &value.InputBytes, &value.ResultBytes}
	targets = append(targets, &value.ProvenanceSHA256, &value.ProvenanceBytes)
	if body {
		targets = append(targets, &input, &result, &value.provenance)
	}
	err := row.Scan(targets...)
	value.ID = strconv.FormatInt(id, 10)
	value.SchemeID = strconv.FormatInt(scheme, 10)
	value.AuthorAccountID = strconv.FormatInt(account, 10)
	value.TopologyRevision = strconv.FormatInt(revision, 10)
	if err == nil && body && (archiveDigest(input) != value.InputSHA256 || archiveDigest(result) != value.ResultSHA256) {
		err = errArchiveCorrupt
	}
	if err == nil && body && ((value.ProvenanceSHA256 == "") != (len(value.provenance) == 0) ||
		(len(value.provenance) > 0 && archiveDigest(value.provenance) != value.ProvenanceSHA256)) {
		err = errArchiveCorrupt
	}
	return value, input, result, err
}

func (store projectStore) CalculationArchives(ctx context.Context, token string, project, before int64, limit int) (calculationArchivePage, error) {
	page := calculationArchivePage{Items: []calculationArchive{}}
	tx, err := store.database.BeginTx(ctx, &sql.TxOptions{Isolation: sql.LevelReadCommitted})
	if err != nil {
		return page, err
	}
	defer rollbackTx(tx)
	if _, err = lockArchiveProject(ctx, tx, token, project, false); err != nil {
		return page, err
	}
	rows, err := tx.QueryContext(ctx, `SELECT `+archiveColumns+` FROM project_calculation_archives
 WHERE project_id=$1 AND ($2::bigint=0 OR id<$2) ORDER BY id DESC LIMIT $3`, project, before, limit+1)
	if err != nil {
		return page, err
	}
	defer rows.Close()
	for rows.Next() {
		value, _, _, err := scanArchive(rows, false)
		if err != nil {
			return page, err
		}
		if len(page.Items) == limit {
			page.NextBeforeID = page.Items[len(page.Items)-1].ID
			break
		}
		page.Items = append(page.Items, value)
	}
	if err := rows.Err(); err != nil {
		return page, err
	}
	rows.Close()
	return page, tx.Commit()
}

func (store projectStore) CalculationArchive(ctx context.Context, token string, project, id int64) (calculationArchive, []byte, []byte, error) {
	tx, err := store.database.BeginTx(ctx, &sql.TxOptions{Isolation: sql.LevelReadCommitted})
	if err != nil {
		return calculationArchive{}, nil, nil, err
	}
	defer rollbackTx(tx)
	if _, err = lockArchiveProject(ctx, tx, token, project, false); err != nil {
		return calculationArchive{}, nil, nil, err
	}
	value, input, result, err := scanArchive(tx.QueryRowContext(ctx, `SELECT `+archiveColumns+`,input_body,result_body,provenance_body
 FROM project_calculation_archives WHERE project_id=$1 AND id=$2`, project, id), true)
	if err != nil {
		return value, nil, nil, err
	}
	return value, input, result, tx.Commit()
}
