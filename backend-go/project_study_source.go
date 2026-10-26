package main

import (
	"context"
	"database/sql"
)

// Called after the project/scheme locks in the short Study write transaction.
// Component SHARE locks also block the parameter revision trigger, including
// direct SQL writers, until the immutable version has committed or rolled back.
func checkStudySourceRevisions(ctx context.Context, tx *sql.Tx, scheme int, captured []calculationComponent) error {
	rows, err := tx.QueryContext(ctx, `SELECT id,revision FROM scheme_components WHERE scheme_id=$1 ORDER BY id FOR SHARE`, scheme)
	if err != nil {
		return err
	}
	defer rows.Close()
	index := 0
	for rows.Next() {
		var id int
		var revision int64
		if err := rows.Scan(&id, &revision); err != nil {
			return err
		}
		if index >= len(captured) || captured[index].ID != id || captured[index].Revision != revision {
			return errStudySource
		}
		index++
	}
	if err := rows.Err(); err != nil {
		return err
	}
	if index != len(captured) {
		return errStudySource
	}
	return nil
}
