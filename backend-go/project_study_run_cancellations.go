package main

import (
	"context"
	"database/sql"
	"errors"
)

var errStudyRunStarted = errors.New("Study run has already been claimed")
var errStudyRunCancellationQuota = errors.New("Study run cancellation command quota exceeded")

// CancelQueuedStudyRun serializes cancellation against claim on the admission
// row. It never interrupts a solver, rewrites input, or removes command history.
func (store projectStore) CancelQueuedStudyRun(ctx context.Context, token string, project, id int64, command string) (studyRun, error) {
	var empty studyRun
	if project <= 0 || id <= 0 || !commandUUID.MatchString(command) {
		return empty, errStudyInput
	}
	tx, err := store.database.BeginTx(ctx, &sql.TxOptions{Isolation: sql.LevelReadCommitted})
	if err != nil {
		return empty, err
	}
	defer rollbackTx(tx)
	account, err := lockArchiveProject(ctx, tx, token, project, true)
	if err != nil {
		return empty, err
	}
	// Same project command/quota lock as admission; worker does not take it.
	if _, err = tx.ExecContext(ctx, `SELECT pg_advisory_xact_lock(hashtextextended('enersy-study-runs:' || $1::text,0))`, project); err != nil {
		return empty, err
	}
	if _, err = lockArchiveProject(ctx, tx, token, project, true); err != nil {
		return empty, err
	}
	var prior int64
	err = tx.QueryRowContext(ctx, `SELECT run_id FROM project_study_run_cancellations WHERE project_id=$1 AND command_id=$2`, project, command).Scan(&prior)
	if err == nil && prior != id {
		return empty, errStudyRunCommand
	}
	replay := err == nil
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		return empty, err
	}
	var locked int64
	if err = tx.QueryRowContext(ctx, `SELECT id FROM project_study_runs WHERE project_id=$1 AND id=$2 FOR UPDATE`, project, id).Scan(&locked); err != nil {
		return empty, err
	}
	if !replay {
		var started bool
		if err = tx.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM project_study_run_leases WHERE run_id=$1)`, id).Scan(&started); err != nil {
			return empty, err
		}
		if started {
			return empty, errStudyRunStarted
		}
		var count int
		if err = tx.QueryRowContext(ctx, `SELECT count(*) FROM project_study_run_cancellations WHERE project_id=$1`, project).Scan(&count); err != nil {
			return empty, err
		}
		if count >= 1000 {
			return empty, errStudyRunCancellationQuota
		}
		if _, err = tx.ExecContext(ctx, `INSERT INTO project_study_run_cancellations(project_id,command_id,run_id,requested_by) VALUES($1,$2,$3,$4)`, project, command, id, account); err != nil {
			return empty, err
		}
	}
	run, err := scanStudyRun(tx.QueryRowContext(ctx, `SELECT `+studyRunColumns+studyRunJoin+` WHERE r.project_id=$1 AND r.id=$2`, project, id))
	if err != nil {
		return empty, err
	}
	if _, err = lockArchiveProject(ctx, tx, token, project, true); err != nil {
		return empty, err
	}
	return run, tx.Commit()
}
