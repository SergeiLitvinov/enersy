package main

import (
	"context"
	"database/sql"
	"errors"
	"strconv"
	"time"
)

var errStudyRunCommand = errors.New("Study run command reused with different version")
var errStudyRunQuota = errors.New("Study run admission quota exceeded")

// studyRun joins immutable admission identity with its current lease/terminal
// state. A queued command has no execution row and never means calculated.
type studyRun struct {
	ID               string    `json:"id"`
	ProjectID        string    `json:"projectId"`
	StudyID          string    `json:"studyId"`
	StudyRevision    string    `json:"studyRevision"`
	RequestedBy      string    `json:"requestedBy"`
	Status           string    `json:"status"`
	ArchiveID        string    `json:"archiveId,omitempty"`
	ErrorCode        string    `json:"errorCode,omitempty"`
	InputSHA256      string    `json:"inputSha256"`
	ProvenanceSHA256 string    `json:"provenanceSha256"`
	CreatedAt        time.Time `json:"createdAt"`
}

const studyRunColumns = `r.id,r.project_id,r.study_id,r.study_revision,r.requested_by,coalesce(l.status,r.status),v.input_sha256,v.provenance_sha256,r.created_at,coalesce(l.archive_id::text,''),coalesce(l.error_code,'')`

func scanStudyRun(row interface{ Scan(...any) error }) (studyRun, error) {
	var run studyRun
	var id, project, study, revision, account int64
	err := row.Scan(&id, &project, &study, &revision, &account, &run.Status, &run.InputSHA256, &run.ProvenanceSHA256, &run.CreatedAt, &run.ArchiveID, &run.ErrorCode)
	run.ID, run.ProjectID = strconv.FormatInt(id, 10), strconv.FormatInt(project, 10)
	run.StudyID, run.StudyRevision = strconv.FormatInt(study, 10), strconv.FormatInt(revision, 10)
	run.RequestedBy = strconv.FormatInt(account, 10)
	return run, err
}

const studyRunJoin = ` FROM project_study_runs r JOIN project_study_versions v ON v.study_id=r.study_id AND v.revision=r.study_revision LEFT JOIN project_study_run_leases l ON l.run_id=r.id`

type studyRunPage struct {
	FormatVersion int        `json:"formatVersion"`
	Items         []studyRun `json:"items"`
	NextBeforeID  string     `json:"nextBeforeId,omitempty"`
}

func (store projectStore) ListStudyRuns(ctx context.Context, token string, project, study, revision, before int64, limit int) (studyRunPage, error) {
	page := studyRunPage{FormatVersion: 1, Items: []studyRun{}}
	if project <= 0 || study <= 0 || revision <= 0 || before < 0 || limit < 1 || limit > 50 {
		return page, errStudyInput
	}
	tx, err := store.database.BeginTx(ctx, nil)
	if err != nil {
		return page, err
	}
	defer rollbackTx(tx)
	if _, err = lockArchiveProject(ctx, tx, token, project, false); err != nil {
		return page, err
	}
	var found int
	if err = tx.QueryRowContext(ctx, `SELECT 1 FROM project_study_versions WHERE project_id=$1 AND study_id=$2 AND revision=$3`, project, study, revision).Scan(&found); err != nil {
		return page, err
	}
	rows, err := tx.QueryContext(ctx, `SELECT `+studyRunColumns+studyRunJoin+` WHERE r.project_id=$1 AND r.study_id=$2 AND r.study_revision=$3 AND ($4::bigint=0 OR r.id<$4) ORDER BY r.id DESC LIMIT $5`, project, study, revision, before, limit)
	if err != nil {
		return page, err
	}
	defer rows.Close()
	for rows.Next() {
		run, err := scanStudyRun(rows)
		if err != nil {
			return page, err
		}
		page.Items = append(page.Items, run)
	}
	if err = rows.Err(); err != nil {
		return page, err
	}
	rows.Close()
	if len(page.Items) == limit {
		page.NextBeforeID = page.Items[len(page.Items)-1].ID
	}
	if _, err = lockArchiveProject(ctx, tx, token, project, false); err != nil {
		return page, err
	}
	return page, tx.Commit()
}

// EnqueueStudyRun never reads the mutable scheme or a Study's current head.
// Replay is checked before quota and uses only the explicit immutable target.
func (store projectStore) EnqueueStudyRun(ctx context.Context, token string, project, study, revision int64, command string) (studyRun, error) {
	var empty studyRun
	if project <= 0 || study <= 0 || revision <= 0 || !commandUUID.MatchString(command) {
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
	// Serialize project admission/replay/quota decisions, not worker execution.
	if _, err = tx.ExecContext(ctx, `SELECT pg_advisory_xact_lock(hashtextextended('enersy-study-runs:' || $1::text,0))`, project); err != nil {
		return empty, err
	}
	if _, err = lockArchiveProject(ctx, tx, token, project, true); err != nil {
		return empty, err
	}
	run, err := scanStudyRun(tx.QueryRowContext(ctx, `SELECT `+studyRunColumns+studyRunJoin+` WHERE r.project_id=$1 AND r.command_id=$2`, project, command))
	if err == nil {
		if run.StudyID != strconv.FormatInt(study, 10) || run.StudyRevision != strconv.FormatInt(revision, 10) {
			return empty, errStudyRunCommand
		}
		if _, err = lockArchiveProject(ctx, tx, token, project, true); err != nil {
			return empty, err
		}
		return run, tx.Commit()
	}
	if !errors.Is(err, sql.ErrNoRows) {
		return empty, err
	}
	// Validate the stored bytes, without JSON decoding/re-encoding or copying
	// a second snapshot. The database prevents independent version mutation.
	version, err := studyInTx(ctx, tx, project, study, revision)
	if err != nil {
		return empty, err
	}
	var input, provenance []byte
	if err = tx.QueryRowContext(ctx, `SELECT input_body,provenance_body FROM project_study_versions WHERE study_id=$1 AND revision=$2`, study, revision).Scan(&input, &provenance); err != nil {
		return empty, err
	}
	if archiveDigest(input) != version.InputSHA256 || archiveDigest(provenance) != version.ProvenanceSHA256 {
		return empty, errArchiveCorrupt
	}
	var count, active int
	if err = tx.QueryRowContext(ctx, `SELECT count(*),count(*) FILTER(WHERE l.status IS NULL OR l.status IN ('validating','initializing','running'))
 FROM project_study_runs r LEFT JOIN project_study_run_leases l ON l.run_id=r.id WHERE r.project_id=$1`, project).Scan(&count, &active); err != nil {
		return empty, err
	}
	if active >= 20 || count >= 1000 {
		return empty, errStudyRunQuota
	}
	var id int64
	if err = tx.QueryRowContext(ctx, `INSERT INTO project_study_runs(project_id,study_id,study_revision,requested_by,command_id) VALUES($1,$2,$3,$4,$5) RETURNING id`, project, study, revision, account, command).Scan(&id); err != nil {
		return empty, err
	}
	run, err = scanStudyRun(tx.QueryRowContext(ctx, `SELECT `+studyRunColumns+studyRunJoin+` WHERE r.id=$1`, id))
	if err != nil {
		return empty, err
	}
	// Time may have passed while waiting for database I/O.
	if _, err = lockArchiveProject(ctx, tx, token, project, true); err != nil {
		return empty, err
	}
	return run, tx.Commit()
}

func (store projectStore) ReadStudyRun(ctx context.Context, token string, project, id int64) (studyRun, error) {
	var empty studyRun
	if project <= 0 || id <= 0 {
		return empty, errStudyInput
	}
	tx, err := store.database.BeginTx(ctx, &sql.TxOptions{Isolation: sql.LevelReadCommitted})
	if err != nil {
		return empty, err
	}
	defer rollbackTx(tx)
	if _, err = lockArchiveProject(ctx, tx, token, project, false); err != nil {
		return empty, err
	}
	run, err := scanStudyRun(tx.QueryRowContext(ctx, `SELECT `+studyRunColumns+studyRunJoin+` WHERE r.project_id=$1 AND r.id=$2`, project, id))
	if err != nil {
		return empty, err
	}
	if _, err = lockArchiveProject(ctx, tx, token, project, false); err != nil {
		return empty, err
	}
	return run, tx.Commit()
}
