package main

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"strconv"
	"time"
)

var errRunLeaseLost = errors.New("Run execution lease lost")

const runLeaseDuration = 30 * time.Second
const runActive = `status IN ('validating','initializing','running')`

type studyRunClaim struct {
	ID, Project, Study, Revision, Generation int64
	Executor                                 string
	Input                                    []byte
	Document                                 studyDocument
}

// ClaimStudyRun is an internal worker capability, never an end-user API. Each
// claim holds database locks only while choosing and reading the frozen input.
func (store projectStore) ClaimStudyRun(ctx context.Context, executor string) (studyRunClaim, error) {
	var claim studyRunClaim
	if !commandUUID.MatchString(executor) {
		return claim, errStudyInput
	}
	tx, err := store.database.BeginTx(ctx, nil)
	if err != nil {
		return claim, err
	}
	defer rollbackTx(tx)
	// A bounded number of deliveries prevents endless retry after worker crashes.
	if _, err = tx.ExecContext(ctx, `WITH expired AS (SELECT run_id FROM project_study_run_leases WHERE `+runActive+`
 AND lease_until<=clock_timestamp() AND generation>=3 FOR UPDATE SKIP LOCKED)
 UPDATE project_study_run_leases l SET status='failed',error_code='lease_exhausted',lease_until=NULL,updated_at=clock_timestamp()
 FROM expired e WHERE l.run_id=e.run_id`); err != nil {
		return claim, err
	}
	err = tx.QueryRowContext(ctx, `SELECT r.id,r.project_id,r.study_id,r.study_revision FROM project_study_runs r
 LEFT JOIN project_study_run_leases l ON l.run_id=r.id
 WHERE l.run_id IS NULL OR (l.status IN ('validating','initializing','running') AND l.lease_until<=clock_timestamp() AND l.generation<3)
 ORDER BY r.id FOR UPDATE OF r SKIP LOCKED LIMIT 1`).Scan(&claim.ID, &claim.Project, &claim.Study, &claim.Revision)
	if errors.Is(err, sql.ErrNoRows) {
		if commitErr := tx.Commit(); commitErr != nil {
			return claim, commitErr
		}
		return claim, sql.ErrNoRows
	}
	if err != nil {
		return claim, err
	}
	claim.Executor = executor
	err = tx.QueryRowContext(ctx, `INSERT INTO project_study_run_leases(run_id,executor_id,generation,status,lease_until)
 VALUES($1,$2,1,'validating',clock_timestamp()+interval '30 seconds')
 ON CONFLICT(run_id) DO UPDATE SET executor_id=excluded.executor_id,generation=project_study_run_leases.generation+1,
 status='validating',lease_until=excluded.lease_until,updated_at=clock_timestamp()
 WHERE project_study_run_leases.lease_until<=clock_timestamp() AND project_study_run_leases.generation<3
 RETURNING generation`, claim.ID, executor).Scan(&claim.Generation)
	if err != nil {
		return claim, err
	}
	version, err := studyInTx(ctx, tx, claim.Project, claim.Study, claim.Revision)
	if err != nil {
		return claim, err
	}
	claim.Document = version.Document
	if err = tx.QueryRowContext(ctx, `SELECT input_body FROM project_study_versions WHERE study_id=$1 AND revision=$2`, claim.Study, claim.Revision).Scan(&claim.Input); err != nil {
		return claim, err
	}
	if archiveDigest(claim.Input) != version.InputSHA256 {
		return claim, errArchiveCorrupt
	}
	return claim, tx.Commit()
}

func (store projectStore) RenewStudyRun(ctx context.Context, claim studyRunClaim) error {
	result, err := store.database.ExecContext(ctx, `UPDATE project_study_run_leases
 SET lease_until=clock_timestamp()+interval '30 seconds',updated_at=clock_timestamp()
 WHERE run_id=$1 AND executor_id=$2 AND generation=$3 AND `+runActive+` AND lease_until>clock_timestamp()`, claim.ID, claim.Executor, claim.Generation)
	return runLeaseUpdate(result, err)
}

func runLeaseUpdate(result sql.Result, err error) error {
	if err != nil {
		return err
	}
	count, err := result.RowsAffected()
	if err == nil && count != 1 {
		return errRunLeaseLost
	}
	return err
}

func (store projectStore) AdvanceStudyRun(ctx context.Context, claim studyRunClaim, status string) error {
	previous := "validating"
	if status == "running" {
		previous = "initializing"
	} else if status != "initializing" {
		return errStudyInput
	}
	result, err := store.database.ExecContext(ctx, `UPDATE project_study_run_leases SET status=$4,updated_at=clock_timestamp()
 WHERE run_id=$1 AND executor_id=$2 AND generation=$3 AND status=$5 AND lease_until>clock_timestamp()`, claim.ID, claim.Executor, claim.Generation, status, previous)
	return runLeaseUpdate(result, err)
}

func (store projectStore) FailStudyRun(ctx context.Context, claim studyRunClaim, code string) error {
	switch code {
	case "worker_unavailable", "worker_transport", "worker_rejected", "invalid_result", "archive_quota", "invalid_snapshot":
	default:
		return errStudyInput
	}
	result, err := store.database.ExecContext(ctx, `UPDATE project_study_run_leases SET status='failed',error_code=$4,lease_until=NULL,updated_at=clock_timestamp()
 WHERE run_id=$1 AND executor_id=$2 AND generation=$3 AND `+runActive+` AND lease_until>clock_timestamp()`, claim.ID, claim.Executor, claim.Generation, code)
	return runLeaseUpdate(result, err)
}

// CompleteStudyRun publishes the archive and terminal state in one transaction.
// No account session survives in a job: its authority is the admitted project
// command and a live internal lease. Project membership still protects reads.
func (store projectStore) CompleteStudyRun(ctx context.Context, claim studyRunClaim, result []byte) (int64, error) {
	tx, err := store.database.BeginTx(ctx, nil)
	if err != nil {
		return 0, err
	}
	defer rollbackTx(tx)
	var project int64
	if err = tx.QueryRowContext(ctx, `SELECT id FROM projects WHERE id=$1 FOR SHARE`, claim.Project).Scan(&project); err != nil {
		return 0, err
	}
	var id int64
	if err = tx.QueryRowContext(ctx, `SELECT l.run_id FROM project_study_run_leases l JOIN project_study_runs r ON r.id=l.run_id
 WHERE l.run_id=$1 AND l.executor_id=$2 AND l.generation=$3 AND l.status='running' AND l.lease_until>clock_timestamp() AND r.project_id=$4
 FOR UPDATE OF l`, claim.ID, claim.Executor, claim.Generation, claim.Project).Scan(&id); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return 0, errRunLeaseLost
		}
		return 0, err
	}
	// Re-read metadata by admitted identity, never from the caller's claim body.
	var study, revision, author int64
	if err = tx.QueryRowContext(ctx, `SELECT study_id,study_revision,requested_by FROM project_study_runs WHERE id=$1`, id).Scan(&study, &revision, &author); err != nil {
		return 0, err
	}
	v, err := studyInTx(ctx, tx, project, study, revision)
	if err != nil {
		return 0, err
	}
	var request, provenance []byte
	if err = tx.QueryRowContext(ctx, `SELECT input_body,provenance_body FROM project_study_versions WHERE study_id=$1 AND revision=$2`, study, revision).Scan(&request, &provenance); err != nil {
		return 0, err
	}
	if archiveDigest(request) != v.InputSHA256 || archiveDigest(provenance) != v.ProvenanceSHA256 {
		return 0, errArchiveCorrupt
	}
	input := calculationInput{AuthorAccountID: author, SchemeName: v.SchemeName, Provenance: provenance}
	input.TopologyRevision, err = strconv.ParseInt(v.TopologyRevision, 10, 64)
	if err != nil {
		return 0, err
	}
	scheme, err := strconv.Atoi(v.SchemeID)
	if err != nil {
		return 0, err
	}
	if err = validateCalculationArchive(input, v.Document.ModelGroup, v.Document.Method, request, result); err != nil {
		return 0, err
	}
	if !confirmsCalculationLimits(result, v.Document.Limits) {
		return 0, errArchiveResult
	}
	var engine struct {
		Solver struct {
			Backend struct {
				ID string `json:"id"`
			} `json:"compute_backend"`
		} `json:"solver"`
	}
	if json.Unmarshal(result, &engine) != nil || engine.Solver.Backend.ID != v.Document.ComputeBackend {
		return 0, errArchiveResult
	}
	fence := func() error {
		var valid bool
		if err := tx.QueryRowContext(ctx, `SELECT lease_until>clock_timestamp() FROM project_study_run_leases WHERE run_id=$1`, id).Scan(&valid); err != nil {
			return err
		}
		if !valid {
			return errRunLeaseLost
		}
		return nil
	}
	archive, err := insertCalculationArchive(ctx, tx, project, scheme, input, v.Document.ModelGroup, v.Document.Method, request, result, fence)
	if err != nil {
		return 0, err
	}
	updated, err := tx.ExecContext(ctx, `UPDATE project_study_run_leases SET status='succeeded',archive_id=$2,lease_until=NULL,updated_at=clock_timestamp()
 WHERE run_id=$1 AND status='running' AND lease_until>clock_timestamp()`, id, archive)
	if err = runLeaseUpdate(updated, err); err != nil {
		return 0, err
	}
	return archive, tx.Commit()
}
