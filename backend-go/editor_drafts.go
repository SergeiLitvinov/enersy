package main

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"strconv"
	"time"
)

var errEditorDraftConflict = errors.New("editor draft revision conflict")
var errEditorDraftQuota = errors.New("editor draft quota exceeded")

type editorDraftView struct {
	WorkspaceID string          `json:"workspaceId"`
	Revision    string          `json:"revision"`
	UpdatedAt   time.Time       `json:"updatedAt"`
	Payload     json.RawMessage `json:"payload,omitempty"`
}

// Drafts belong to an account, not to everyone who can read the shared scheme.
// Project membership writes take the conflicting project lock. Recheck after
// waiting; keep the actual parent scheme locked until the draft transaction ends.
func lockEditorDraftScope(ctx context.Context, tx *sql.Tx, token string, project int64, scheme int, writing bool) (int64, error) {
	hash, err := sessionTokenHash(token)
	if err != nil {
		return 0, sql.ErrNoRows
	}
	query := `SELECT s.account_id FROM projects p
 JOIN auth_sessions s ON s.token_hash=$2 JOIN auth_accounts a ON a.id=s.account_id
 LEFT JOIN project_members m ON m.project_id=p.id AND m.account_id=a.id
 WHERE p.id=$1 AND s.revoked_at IS NULL AND s.expires_at>statement_timestamp() AND a.disabled_at IS NULL
 AND (p.owner_account_id=a.id OR m.role IN ('admin','editor') OR (NOT $3 AND m.role='viewer'))`
	var account int64
	if err := tx.QueryRowContext(ctx, query+` FOR SHARE OF p`, project, hash, writing).Scan(&account); err != nil {
		return 0, err
	}
	if err := tx.QueryRowContext(ctx, query, project, hash, writing).Scan(&account); err != nil {
		return 0, err
	}
	var parent int
	if err := tx.QueryRowContext(ctx, `SELECT id FROM circuit_schemes WHERE id=$1 AND project_id=$2 FOR SHARE`, scheme, project).Scan(&parent); err != nil {
		return 0, err
	}
	return account, nil
}

func (store projectStore) ReadEditorDrafts(ctx context.Context, token string, project int64, scheme int, workspace string) ([]editorDraftView, error) {
	tx, err := store.database.BeginTx(ctx, &sql.TxOptions{Isolation: sql.LevelReadCommitted})
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()
	account, err := lockEditorDraftScope(ctx, tx, token, project, scheme, false)
	if err != nil {
		return nil, err
	}
	items := []editorDraftView{}
	if workspace != "" {
		var item editorDraftView
		var revision int64
		var payload []byte
		err := tx.QueryRowContext(ctx, `SELECT workspace_id::text,revision,updated_at,payload FROM project_editor_drafts
 WHERE account_id=$1 AND scheme_id=$2 AND workspace_id=$3 AND deleted_at IS NULL`, account, scheme, workspace).Scan(&item.WorkspaceID, &revision, &item.UpdatedAt, &payload)
		if err != nil {
			return nil, err
		}
		item.Revision = strconv.FormatInt(revision, 10)
		item.Payload = json.RawMessage(payload)
		items = append(items, item)
	} else {
		// Account-wide active quota bounds this list; do not return journal bodies.
		rows, err := tx.QueryContext(ctx, `SELECT workspace_id::text,revision,updated_at FROM project_editor_drafts
 WHERE account_id=$1 AND scheme_id=$2 AND deleted_at IS NULL ORDER BY updated_at DESC,workspace_id LIMIT 32`, account, scheme)
		if err != nil {
			return nil, err
		}
		for rows.Next() {
			var item editorDraftView
			var revision int64
			if err := rows.Scan(&item.WorkspaceID, &revision, &item.UpdatedAt); err != nil {
				rows.Close()
				return nil, err
			}
			item.Revision = strconv.FormatInt(revision, 10)
			items = append(items, item)
		}
		err = rows.Err()
		rows.Close()
		if err != nil {
			return nil, err
		}
	}
	if err := tx.Commit(); err != nil {
		return nil, err
	}
	return items, nil
}

func (store projectStore) WriteEditorDraft(ctx context.Context, token string, project int64, scheme int, workspace string, expected int64, payload []byte, deleting bool) (editorDraftView, error) {
	if !editorWorkspacePattern.MatchString(workspace) || expected < 0 {
		return editorDraftView{}, errEditorDraftPayload
	}
	if !deleting {
		if _, err := decodeEditorDraft(payload); err != nil {
			return editorDraftView{}, err
		}
	}
	tx, err := store.database.BeginTx(ctx, &sql.TxOptions{Isolation: sql.LevelReadCommitted})
	if err != nil {
		return editorDraftView{}, err
	}
	defer tx.Rollback()
	account, err := lockEditorDraftScope(ctx, tx, token, project, scheme, !deleting)
	if err != nil {
		return editorDraftView{}, err
	}
	// Serialize all journals of one account, including creation across projects,
	// so concurrent requests cannot bypass account-wide storage quotas.
	if _, err = tx.ExecContext(ctx, `SELECT pg_advisory_xact_lock(hashtextextended('enersy-editor-drafts:' || $1::text,0))`, account); err != nil {
		return editorDraftView{}, err
	}
	if _, err = lockEditorDraftScope(ctx, tx, token, project, scheme, !deleting); err != nil {
		return editorDraftView{}, err
	}
	var revision int64
	var deleted sql.NullTime
	err = tx.QueryRowContext(ctx, `SELECT revision,deleted_at FROM project_editor_drafts WHERE account_id=$1 AND scheme_id=$2 AND workspace_id=$3 FOR UPDATE`, account, scheme, workspace).Scan(&revision, &deleted)
	missing := errors.Is(err, sql.ErrNoRows)
	if err != nil && !missing {
		return editorDraftView{}, err
	}
	if deleted.Valid || (missing && deleting) {
		return editorDraftView{}, sql.ErrNoRows
	}
	if expected != revision {
		return editorDraftView{}, errEditorDraftConflict
	}
	if missing {
		var total, active int
		if err := tx.QueryRowContext(ctx, `SELECT count(*),count(*) FILTER (WHERE deleted_at IS NULL) FROM project_editor_drafts WHERE account_id=$1`, account).Scan(&total, &active); err != nil {
			return editorDraftView{}, err
		}
		if active >= 32 || total >= 256 {
			return editorDraftView{}, errEditorDraftQuota
		}
	}
	view := editorDraftView{WorkspaceID: workspace}
	if deleting {
		err = tx.QueryRowContext(ctx, `UPDATE project_editor_drafts SET payload=NULL,deleted_at=statement_timestamp(),updated_at=statement_timestamp(),revision=revision+1
 WHERE account_id=$1 AND scheme_id=$2 AND workspace_id=$3 RETURNING revision,updated_at`, account, scheme, workspace).Scan(&revision, &view.UpdatedAt)
	} else if missing {
		err = tx.QueryRowContext(ctx, `INSERT INTO project_editor_drafts(account_id,scheme_id,workspace_id,revision,payload) VALUES($1,$2,$3,1,$4::jsonb)
 RETURNING revision,updated_at`, account, scheme, workspace, string(payload)).Scan(&revision, &view.UpdatedAt)
	} else {
		err = tx.QueryRowContext(ctx, `UPDATE project_editor_drafts SET payload=$4::jsonb,revision=revision+1,updated_at=statement_timestamp()
 WHERE account_id=$1 AND scheme_id=$2 AND workspace_id=$3 RETURNING revision,updated_at`, account, scheme, workspace, string(payload)).Scan(&revision, &view.UpdatedAt)
	}
	if err != nil {
		return editorDraftView{}, err
	}
	if err = tx.Commit(); err != nil {
		return editorDraftView{}, err
	}
	view.Revision = strconv.FormatInt(revision, 10)
	return view, nil
}
