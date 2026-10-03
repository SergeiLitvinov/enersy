package main

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
)

var errComponentConflict = errors.New("equipment revision conflict")

// mutateComponentRevision locks the parent before writing either its geometry
// or parameters. The database triggers own revision increments. The result is
// published only after commit, so a conflict never leaks a partial mutation.
// HTTP writes require If-Match; client integration must use the acknowledged
// revision for the next queued mutation. Authorization remains a separate check.
func mutateComponentRevision(ctx context.Context, database *sql.DB, id int, expected int64,
	mutate func(*sql.Tx) error, deleting bool) (int64, error) {
	if id <= 0 || expected <= 0 {
		return 0, fmt.Errorf("positive component ID and revision required")
	}
	tx, err := database.BeginTx(ctx, nil)
	if err != nil {
		return 0, err
	}
	defer tx.Rollback()
	var revision int64
	if err = tx.QueryRowContext(ctx, `SELECT revision FROM scheme_components WHERE id=$1 FOR UPDATE`, id).Scan(&revision); err != nil {
		return 0, err
	}
	if revision != expected {
		return 0, errComponentConflict
	}
	if err = mutate(tx); err != nil {
		return 0, err
	}
	if !deleting {
		if err = tx.QueryRowContext(ctx, `SELECT revision FROM scheme_components WHERE id=$1`, id).Scan(&revision); err != nil {
			return 0, err
		}
	}
	if err = tx.Commit(); err != nil {
		return 0, err
	}
	return revision, nil
}
