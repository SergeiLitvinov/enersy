package main

import (
	"context"
	"database/sql"
	"errors"
)

// Keep project -> scheme -> component as the lock order. All membership writes
// lock the project exclusively. Recheck rights after waiting on the shared lock.
func lockProjectSchemeWrite(ctx context.Context, tx *sql.Tx, token string, project int64, scheme int) error {
	hash, err := sessionTokenHash(token)
	if err != nil || project <= 0 || scheme <= 0 {
		return sql.ErrNoRows
	}
	query := `SELECT p.id FROM projects p WHERE p.id=$1 AND EXISTS(
 SELECT 1 FROM auth_sessions s JOIN auth_accounts a ON a.id=s.account_id
 LEFT JOIN project_members m ON m.project_id=p.id AND m.account_id=a.id
 WHERE s.token_hash=$2 AND s.revoked_at IS NULL AND s.expires_at>statement_timestamp() AND a.disabled_at IS NULL
 AND (p.owner_account_id=a.id OR m.role IN ('admin','editor')))`
	var id int64
	if err := tx.QueryRowContext(ctx, query+` FOR SHARE OF p`, project, hash).Scan(&id); err != nil {
		return err
	}
	if err := tx.QueryRowContext(ctx, query, project, hash).Scan(&id); err != nil {
		return err
	}
	return tx.QueryRowContext(ctx, `SELECT id FROM circuit_schemes WHERE id=$1 AND project_id=$2 FOR UPDATE`, scheme, project).Scan(&id)
}

func (store projectStore) CreateComponent(ctx context.Context, token string, project int64, req createComponentRequest) (int, map[string]string, int64, error) {
	if err := validateComponentCreation(req); err != nil {
		return 0, nil, 0, err
	}
	tx, err := store.database.BeginTx(ctx, &sql.TxOptions{Isolation: sql.LevelReadCommitted})
	if err != nil {
		return 0, nil, 0, err
	}
	defer rollbackTx(tx)
	if err := lockProjectSchemeWrite(ctx, tx, token, project, req.SchemeID); err != nil {
		return 0, nil, 0, err
	}
	if req.ProjectPassportVersionID != nil {
		if _, err := lockArchiveProject(ctx, tx, token, project, true); err != nil {
			return 0, nil, 0, err
		}
		params, err := copyProjectPassport(ctx, tx, project, req)
		if err != nil {
			return 0, nil, 0, err
		}
		req.Params = params
	}
	id, params, revision, err := createComponentInTx(ctx, tx, req)
	if err != nil {
		return 0, nil, 0, err
	}
	if err := tx.Commit(); err != nil {
		return 0, nil, 0, err
	}
	return id, params, revision, nil
}

func (store projectStore) MutateComponent(ctx context.Context, token string, project int64, scheme, id int, expected int64, mutate func(*sql.Tx) error, deleting bool) (int64, error) {
	if id <= 0 || expected <= 0 {
		return 0, sql.ErrNoRows
	}
	tx, err := store.database.BeginTx(ctx, &sql.TxOptions{Isolation: sql.LevelReadCommitted})
	if err != nil {
		return 0, err
	}
	defer rollbackTx(tx)
	if err := lockProjectSchemeWrite(ctx, tx, token, project, scheme); err != nil {
		return 0, err
	}
	var revision int64
	if err := tx.QueryRowContext(ctx, `SELECT revision FROM scheme_components WHERE id=$1 AND scheme_id=$2 FOR UPDATE`, id, scheme).Scan(&revision); err != nil {
		return 0, err
	}
	if revision != expected {
		return 0, errComponentConflict
	}
	if err := mutate(tx); err != nil {
		return 0, err
	}
	if !deleting {
		if err := tx.QueryRowContext(ctx, `SELECT revision FROM scheme_components WHERE id=$1`, id).Scan(&revision); err != nil {
			return 0, err
		}
	}
	if err := tx.Commit(); err != nil {
		return 0, err
	}
	return revision, nil
}

func projectComponentCreationError(err error) (int, string) {
	var validation *componentCreationError
	if errors.As(err, &validation) {
		return validation.status, validation.message
	}
	if errors.Is(err, sql.ErrNoRows) {
		return 404, "Оборудование или схема недоступны"
	}
	return 500, "Не удалось сохранить оборудование; изменения отменены"
}
