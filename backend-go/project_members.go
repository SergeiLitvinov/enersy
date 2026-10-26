package main

import (
	"context"
	"database/sql"
	"errors"
	"strconv"
)

var errMembershipConflict = errors.New("membership revision conflict")
var errMembershipTarget = errors.New("membership target unavailable")
var errMembershipRole = errors.New("invalid membership role")

type projectMember struct {
	AccountID string `json:"accountId"`
	Role      string `json:"role"`
}
type memberPage struct {
	OwnerAccountID string          `json:"ownerAccountId"`
	Revision       string          `json:"revision"`
	Items          []projectMember `json:"items"`
	NextAfterID    string          `json:"nextAfterId,omitempty"`
}

// Roster and authorization share one statement snapshot. Only managers see it.
func (store projectStore) Members(ctx context.Context, token string, project, after int64, limit int) (memberPage, error) {
	page := memberPage{Items: []projectMember{}}
	hash, err := sessionTokenHash(token)
	if err != nil || project <= 0 || after < 0 || limit < 1 || limit > 100 {
		return page, errProjectUnavailable
	}
	rows, err := store.database.QueryContext(ctx, `SELECT p.owner_account_id,p.membership_revision,m.account_id,m.role
 FROM projects p JOIN auth_sessions s ON s.token_hash=$1 JOIN auth_accounts a ON a.id=s.account_id
 LEFT JOIN project_members actor ON actor.project_id=p.id AND actor.account_id=a.id
 LEFT JOIN LATERAL (SELECT account_id,role FROM project_members WHERE project_id=p.id AND account_id>$3 ORDER BY account_id LIMIT $4) m ON true
 WHERE p.id=$2 AND s.revoked_at IS NULL AND s.expires_at>statement_timestamp() AND a.disabled_at IS NULL
 AND (p.owner_account_id=a.id OR actor.role='admin') ORDER BY m.account_id`, hash, project, after, limit)
	if err != nil {
		return page, err
	}
	defer rows.Close()
	valid := false
	for rows.Next() {
		var owner, revision int64
		var account sql.NullInt64
		var role sql.NullString
		if err := rows.Scan(&owner, &revision, &account, &role); err != nil {
			return memberPage{}, err
		}
		valid = true
		page.OwnerAccountID = strconv.FormatInt(owner, 10)
		page.Revision = strconv.FormatInt(revision, 10)
		if account.Valid {
			page.Items = append(page.Items, projectMember{strconv.FormatInt(account.Int64, 10), role.String})
		}
	}
	if err := rows.Err(); err != nil {
		return memberPage{}, err
	}
	if !valid {
		return memberPage{}, errProjectUnavailable
	}
	if len(page.Items) == limit {
		page.NextAfterID = page.Items[len(page.Items)-1].AccountID
	}
	return page, nil
}

// All membership commands serialize on the project row. Authorization is read
// AFTER the lock under READ COMMITTED so a waiting, removed admin cannot write.
// expectedRevision prevents silently replacing another manager's changes.
func (store projectStore) ChangeMember(ctx context.Context, token string, project, target, expected int64, role string, remove bool) (int64, error) {
	if !remove && role != "viewer" && role != "editor" && role != "admin" {
		return 0, errMembershipRole
	}
	hash, err := sessionTokenHash(token)
	if err != nil || project <= 0 || target <= 0 || expected < 0 {
		return 0, errProjectUnavailable
	}
	tx, err := store.database.BeginTx(ctx, &sql.TxOptions{Isolation: sql.LevelReadCommitted})
	if err != nil {
		return 0, err
	}
	defer rollbackTx(tx)
	var owner, revision int64
	err = tx.QueryRowContext(ctx, `SELECT p.owner_account_id,p.membership_revision FROM projects p WHERE p.id=$1
 AND EXISTS(SELECT 1 FROM auth_sessions s JOIN auth_accounts a ON a.id=s.account_id
 LEFT JOIN project_members m ON m.project_id=p.id AND m.account_id=a.id
 WHERE s.token_hash=$2 AND s.revoked_at IS NULL AND s.expires_at>statement_timestamp() AND a.disabled_at IS NULL
 AND (p.owner_account_id=a.id OR m.role='admin')) FOR UPDATE OF p`, project, hash).Scan(&owner, &revision)
	if errors.Is(err, sql.ErrNoRows) {
		return 0, errProjectUnavailable
	}
	if err != nil {
		return 0, err
	}
	var actor int64
	err = tx.QueryRowContext(ctx, `SELECT a.id FROM auth_sessions s JOIN auth_accounts a ON a.id=s.account_id
 LEFT JOIN project_members m ON m.project_id=$2 AND m.account_id=a.id
 WHERE s.token_hash=$1 AND s.revoked_at IS NULL AND s.expires_at>statement_timestamp() AND a.disabled_at IS NULL
 AND (a.id=$3 OR m.role='admin')`, hash, project, owner).Scan(&actor)
	if errors.Is(err, sql.ErrNoRows) {
		return 0, errProjectUnavailable
	}
	if err != nil {
		return 0, err
	}
	if revision != expected {
		return 0, errMembershipConflict
	}
	if target == owner {
		return 0, errMembershipTarget
	}
	if remove {
		result, err := tx.ExecContext(ctx, `DELETE FROM project_members WHERE project_id=$1 AND account_id=$2`, project, target)
		if err != nil {
			return 0, err
		}
		count, err := result.RowsAffected()
		if err != nil {
			return 0, err
		}
		if count == 0 {
			return 0, errMembershipTarget
		}
	} else {
		var id int64
		err = tx.QueryRowContext(ctx, `INSERT INTO project_members(project_id,account_id,role)
 SELECT $1,id,$3 FROM auth_accounts WHERE id=$2 AND disabled_at IS NULL
 ON CONFLICT(project_id,account_id) DO UPDATE SET role=EXCLUDED.role RETURNING account_id`, project, target, role).Scan(&id)
		if errors.Is(err, sql.ErrNoRows) {
			return 0, errMembershipTarget
		}
		if err != nil {
			return 0, err
		}
	}
	err = tx.QueryRowContext(ctx, `UPDATE projects SET membership_revision=membership_revision+1 WHERE id=$1 RETURNING membership_revision`, project).Scan(&revision)
	if err != nil {
		return 0, err
	}
	if err := tx.Commit(); err != nil {
		return 0, err
	}
	return revision, nil
}
