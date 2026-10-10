package main

import (
	"context"
	"database/sql"
	"strconv"
	"time"
)

type projectView struct {
	ID        string    `json:"id"`
	Name      string    `json:"name"`
	Role      string    `json:"role"`
	CreatedAt time.Time `json:"createdAt"`
}
type projectPage struct {
	Items       []projectView `json:"items"`
	NextAfterID string        `json:"nextAfterId,omitempty"`
}

// One statement verifies the session and reads only authorized project rows.
// A valid empty page retains the actor row; invalid sessions have no rows.
func (store projectStore) List(ctx context.Context, token string, after int64, limit int) (projectPage, error) {
	page := projectPage{Items: []projectView{}}
	if after < 0 || limit < 1 || limit > 100 {
		return page, errProjectUnavailable
	}
	hash, err := sessionTokenHash(token)
	if err != nil {
		return page, errSessionUnavailable
	}
	rows, err := store.database.QueryContext(ctx, `SELECT actor.account_id,p.id,p.name,p.role,p.created_at
 FROM (SELECT s.account_id FROM auth_sessions s JOIN auth_accounts a ON a.id=s.account_id
 WHERE s.token_hash=$1 AND s.revoked_at IS NULL AND s.expires_at>statement_timestamp()
 AND a.disabled_at IS NULL) actor
 LEFT JOIN LATERAL (
 SELECT p.id,p.name,p.created_at,CASE WHEN p.owner_account_id=actor.account_id THEN 'owner' ELSE m.role END AS role
 FROM projects p LEFT JOIN project_members m ON m.project_id=p.id AND m.account_id=actor.account_id
 WHERE p.id>$2 AND (p.owner_account_id=actor.account_id OR m.account_id IS NOT NULL)
 ORDER BY p.id LIMIT $3) p ON true ORDER BY p.id`, hash, after, limit)
	if err != nil {
		return page, err
	}
	defer rows.Close()
	valid := false
	for rows.Next() {
		var account int64
		var id sql.NullInt64
		var name, role sql.NullString
		var created sql.NullTime
		if err := rows.Scan(&account, &id, &name, &role, &created); err != nil {
			return projectPage{}, err
		}
		valid = true
		if id.Valid {
			page.Items = append(page.Items, projectView{ID: strconv.FormatInt(id.Int64, 10), Name: name.String, Role: role.String, CreatedAt: created.Time})
		}
	}
	if err := rows.Err(); err != nil {
		return projectPage{}, err
	}
	if !valid {
		return projectPage{}, errSessionUnavailable
	}
	if len(page.Items) == limit {
		page.NextAfterID = page.Items[len(page.Items)-1].ID
	}
	return page, nil
}
