package main

import (
	"context"
	"database/sql"
	"errors"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"
)

type projectScheme struct {
	ID          string    `json:"id"`
	Name        string    `json:"name"`
	Description string    `json:"description"`
	CreatedAt   time.Time `json:"createdAt"`
	UpdatedAt   time.Time `json:"updatedAt"`
}
type projectSchemePage struct {
	Items       []projectScheme `json:"items"`
	NextAfterID string          `json:"nextAfterId,omitempty"`
}

func (store projectStore) CreateScheme(ctx context.Context, token string, project int64, name, description string) (int64, error) {
	name = strings.TrimSpace(name)
	if !utf8.ValidString(name) || strings.ContainsRune(name, 0) || utf8.RuneCountInString(name) < 1 || utf8.RuneCountInString(name) > 200 || !utf8.ValidString(description) || strings.ContainsRune(description, 0) || utf8.RuneCountInString(description) > 4000 {
		return 0, errProjectName
	}
	hash, err := sessionTokenHash(token)
	if err != nil || project <= 0 {
		return 0, errProjectUnavailable
	}
	tx, err := store.database.BeginTx(ctx, &sql.TxOptions{Isolation: sql.LevelReadCommitted})
	if err != nil {
		return 0, err
	}
	defer rollbackTx(tx)
	// A membership mutation takes FOR UPDATE on the same project. Check rights
	// again after waiting, then retain the lock until the scheme commit.
	query := `SELECT p.id FROM projects p WHERE p.id=$1 AND EXISTS(
 SELECT 1 FROM auth_sessions s JOIN auth_accounts a ON a.id=s.account_id
 LEFT JOIN project_members m ON m.project_id=p.id AND m.account_id=a.id
 WHERE s.token_hash=$2 AND s.revoked_at IS NULL AND s.expires_at>statement_timestamp() AND a.disabled_at IS NULL
 AND (p.owner_account_id=a.id OR m.role IN ('admin','editor')))`
	var id int64
	err = tx.QueryRowContext(ctx, query+` FOR SHARE OF p`, project, hash).Scan(&id)
	if errors.Is(err, sql.ErrNoRows) {
		return 0, errProjectUnavailable
	}
	if err != nil {
		return 0, err
	}
	err = tx.QueryRowContext(ctx, query, project, hash).Scan(&id)
	if errors.Is(err, sql.ErrNoRows) {
		return 0, errProjectUnavailable
	}
	if err != nil {
		return 0, err
	}
	err = tx.QueryRowContext(ctx, `INSERT INTO circuit_schemes(project_id,name,description,owner_id) VALUES($1,$2,$3,NULL) RETURNING id`, project, name, description).Scan(&id)
	if err != nil {
		return 0, err
	}
	if err := tx.Commit(); err != nil {
		return 0, err
	}
	return id, nil
}

func (store projectStore) Schemes(ctx context.Context, token string, project, after int64, limit int) (projectSchemePage, error) {
	page := projectSchemePage{Items: []projectScheme{}}
	hash, err := sessionTokenHash(token)
	if err != nil || project <= 0 || after < 0 || limit < 1 || limit > 100 {
		return page, errProjectUnavailable
	}
	rows, err := store.database.QueryContext(ctx, `SELECT p.id,cs.id,cs.name,cs.description,cs.created_at,cs.updated_at
 FROM projects p JOIN auth_sessions s ON s.token_hash=$1 JOIN auth_accounts a ON a.id=s.account_id
 LEFT JOIN project_members m ON m.project_id=p.id AND m.account_id=a.id
 LEFT JOIN LATERAL (SELECT id,name,COALESCE(description,'') AS description,created_at,updated_at FROM circuit_schemes
 WHERE project_id=p.id AND id>$3::bigint ORDER BY id LIMIT $4) cs ON true
 WHERE p.id=$2 AND s.revoked_at IS NULL AND s.expires_at>statement_timestamp() AND a.disabled_at IS NULL
 AND (p.owner_account_id=a.id OR m.role IN ('viewer','editor','admin')) ORDER BY cs.id`, hash, project, after, limit)
	if err != nil {
		return page, err
	}
	defer rows.Close()
	valid := false
	for rows.Next() {
		var actual int64
		var id sql.NullInt64
		var name, description sql.NullString
		var created, updated sql.NullTime
		if err := rows.Scan(&actual, &id, &name, &description, &created, &updated); err != nil {
			return projectSchemePage{}, err
		}
		valid = true
		if id.Valid {
			page.Items = append(page.Items, projectScheme{strconv.FormatInt(id.Int64, 10), name.String, description.String, created.Time, updated.Time})
		}
	}
	if err := rows.Err(); err != nil {
		return projectSchemePage{}, err
	}
	if !valid {
		return projectSchemePage{}, errProjectUnavailable
	}
	if len(page.Items) == limit {
		page.NextAfterID = page.Items[len(page.Items)-1].ID
	}
	return page, nil
}
