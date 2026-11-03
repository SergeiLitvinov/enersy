package main

import (
	"context"
	"database/sql"
	"errors"
	"os"
	"path/filepath"
	"strconv"
	"sync"
	"testing"
)

func TestQueuedCancellationUpgradeFromV3Postgres(t *testing.T) {
	dir := t.TempDir()
	for _, name := range []string{"000001_v1.up.sql", "000002_application_commands.up.sql", "000003_parameter_bases.up.sql"} {
		body, err := os.ReadFile(filepath.Join("..", "database", "migrations", name))
		if err != nil {
			t.Fatal(err)
		}
		if err = os.WriteFile(filepath.Join(dir, name), body, 0o600); err != nil {
			t.Fatal(err)
		}
	}
	f := newStudyFixture(t, "file://"+filepath.ToSlash(dir))
	ctx := context.Background()
	v, err := f.store.SaveStudy(ctx, f.tokens[0].Token, f.project, f.scheme, 0, 0, f.topology, studyCommand(7601), f.doc)
	if err != nil {
		t.Fatal(err)
	}
	var queued, claimed int64
	for i, target := range []*int64{&queued, &claimed} {
		if err = f.store.database.QueryRow(`INSERT INTO project_study_runs(project_id,study_id,study_revision,requested_by,command_id) VALUES($1,$2,1,$3,$4) RETURNING id`, f.project, v.ID, f.tokens[0].Identity.AccountID, studyCommand(7602+i)).Scan(target); err != nil {
			t.Fatal(err)
		}
	}
	if _, err = f.store.database.Exec(`INSERT INTO project_study_run_leases(run_id,executor_id,generation,status,lease_until) VALUES($1,$2,1,'validating',clock_timestamp()+interval '30 seconds')`, claimed, studyCommand(7604)); err != nil {
		t.Fatal(err)
	}
	snapshot := func() string {
		var value string
		if err := f.store.database.QueryRow(`SELECT json_build_array(
 (SELECT json_agg(r ORDER BY id) FROM project_study_runs r),
 (SELECT json_agg(l ORDER BY run_id) FROM project_study_run_leases l),
 (SELECT json_agg(v ORDER BY study_id,revision) FROM project_study_versions v),
 (SELECT json_agg(s ORDER BY version) FROM schema_migration_integrity s WHERE version<=3))::text`).Scan(&value); err != nil {
			t.Fatal(err)
		}
		return value
	}
	before := snapshot()
	if err = runMigrationsFromSource(f.store.database, migrationSourceURL(t)); err != nil {
		t.Fatal(err)
	}
	if snapshot() != before {
		t.Fatal("v4 changed admissions, leases, snapshots or prior migration seals")
	}
	if run, err := f.store.CancelQueuedStudyRun(ctx, f.tokens[0].Token, f.project, queued, studyCommand(7605)); err != nil || run.Status != "cancelled" {
		t.Fatal(run, err)
	}
	if _, err := f.store.CancelQueuedStudyRun(ctx, f.tokens[0].Token, f.project, claimed, studyCommand(7606)); !errors.Is(err, errStudyRunStarted) {
		t.Fatal("upgrade lost existing worker claim", err)
	}
}

func TestQueuedRunCancellationPostgres(t *testing.T) {
	f, v, admitted := admittedRunFixture(t)
	ctx := context.Background()
	owner := f.tokens[0].Token
	id, _ := strconv.ParseInt(admitted.ID, 10, 64)
	study, _ := strconv.ParseInt(v.ID, 10, 64)
	const attempts = 8
	var wg sync.WaitGroup
	results := make(chan studyRun, attempts)
	failures := make(chan error, attempts)
	for range attempts {
		wg.Add(1)
		go func() {
			defer wg.Done()
			r, e := f.store.CancelQueuedStudyRun(ctx, owner, f.project, id, studyCommand(7101))
			results <- r
			failures <- e
		}()
	}
	wg.Wait()
	close(results)
	close(failures)
	for e := range failures {
		if e != nil {
			t.Fatal(e)
		}
	}
	expected := admitted
	expected.Status = "cancelled"
	for r := range results {
		if r != expected {
			t.Fatal("cancellation changed input or identity", r)
		}
	}
	var count int
	if err := f.store.database.QueryRow(`SELECT count(*) FROM project_study_run_cancellations`).Scan(&count); err != nil || count != 1 {
		t.Fatal(count, err)
	}
	if _, err := f.store.ClaimStudyRun(ctx, studyCommand(7102)); !errors.Is(err, sql.ErrNoRows) {
		t.Fatal("cancelled run claimed", err)
	}
	if r, err := f.store.EnqueueStudyRun(ctx, owner, f.project, study, 1, studyCommand(2002)); err != nil || r != expected {
		t.Fatal("admission replay lost cancellation", r, err)
	}
	page, err := f.store.ListStudyRuns(ctx, owner, f.project, study, 1, 0, 25)
	if err != nil || len(page.Items) != 1 || page.Items[0] != expected {
		t.Fatal(page, err)
	}
	for _, actor := range []int{2, 3} {
		if _, err = f.store.CancelQueuedStudyRun(ctx, f.tokens[actor].Token, f.project, id, studyCommand(7101)); !errors.Is(err, sql.ErrNoRows) {
			t.Fatal("unauthorized replay", actor, err)
		}
	}
	if _, err = f.store.CancelQueuedStudyRun(ctx, f.tokens[1].Token, f.project, id, studyCommand(7103)); err != nil {
		t.Fatal("editor cancellation replay", err)
	}
	second, err := f.store.EnqueueStudyRun(ctx, owner, f.project, study, 1, studyCommand(7104))
	if err != nil {
		t.Fatal(err)
	}
	secondID, _ := strconv.ParseInt(second.ID, 10, 64)
	if _, err = f.store.CancelQueuedStudyRun(ctx, owner, f.project, secondID, studyCommand(7101)); !errors.Is(err, errStudyRunCommand) {
		t.Fatal("cancellation command retargeted", err)
	}
	claim := runClaim(t, f, 7107)
	if claim.ID != secondID || archiveDigest(claim.Input) != v.InputSHA256 {
		t.Fatal("cancelled queue head blocked or changed the next admitted run", claim)
	}
	other, err := f.store.Create(ctx, owner, "Other cancellation project")
	if err != nil {
		t.Fatal(err)
	}
	if _, err = f.store.CancelQueuedStudyRun(ctx, owner, other, id, studyCommand(7105)); !errors.Is(err, sql.ErrNoRows) {
		t.Fatal("cross-project cancellation", err)
	}
	for _, query := range []string{`DELETE FROM project_study_run_cancellations WHERE run_id=$1`, `UPDATE project_study_run_cancellations SET requested_by=requested_by WHERE run_id=$1`,
		`INSERT INTO project_study_run_leases(run_id,executor_id,generation,status,lease_until) VALUES($1,'11111111-1111-4111-8111-000000007106',1,'validating',clock_timestamp()+interval '30 seconds')`} {
		if _, err = f.store.database.Exec(query, id); err == nil {
			t.Fatal("SQL bypassed cancellation fence", query)
		}
	}
	if _, err = f.store.database.Exec(`DELETE FROM circuit_schemes WHERE id=$1`, f.scheme); err != nil {
		t.Fatal(err)
	}
	if _, err = f.store.database.Exec(`DELETE FROM projects WHERE id=$1`, f.project); err != nil {
		t.Fatal("project history deletion blocked", err)
	}
	if err = f.store.database.QueryRow(`SELECT count(*) FROM project_study_run_cancellations`).Scan(&count); err != nil || count != 0 {
		t.Fatal("cancellation history survived project", count, err)
	}
}

func TestCancellationHistoryQuotaAndRevokedReplayPostgres(t *testing.T) {
	f, v, run := admittedRunFixture(t)
	ctx := context.Background()
	owner := f.tokens[0].Token
	study, _ := strconv.ParseInt(v.ID, 10, 64)
	id, _ := strconv.ParseInt(run.ID, 10, 64)
	// Administrative setup reaches the historical quota with no active runs.
	if _, err := f.store.database.Exec(`INSERT INTO project_study_runs(project_id,study_id,study_revision,requested_by,command_id)
 SELECT $1,$2,1,$3,md5('admission-fixture-'||n::text)::uuid FROM generate_series(1,999) n`, f.project, study, f.tokens[0].Identity.AccountID); err != nil {
		t.Fatal(err)
	}
	if _, err := f.store.database.Exec(`INSERT INTO project_study_run_cancellations(project_id,run_id,requested_by,command_id)
 SELECT project_id,id,requested_by,md5('cancellation-fixture-'||id::text)::uuid FROM project_study_runs WHERE project_id=$1`, f.project); err != nil {
		t.Fatal(err)
	}
	if _, err := f.store.EnqueueStudyRun(ctx, owner, f.project, study, 1, studyCommand(7501)); !errors.Is(err, errStudyRunQuota) {
		t.Fatal("cancellations bypassed admission history quota", err)
	}
	if _, err := f.store.CancelQueuedStudyRun(ctx, owner, f.project, id, studyCommand(7502)); !errors.Is(err, errStudyRunCancellationQuota) {
		t.Fatal("unbounded cancellation history", err)
	}
	var command string
	if err := f.store.database.QueryRow(`SELECT command_id::text FROM project_study_run_cancellations WHERE run_id=$1`, id).Scan(&command); err != nil {
		t.Fatal(err)
	}
	if replay, err := f.store.CancelQueuedStudyRun(ctx, owner, f.project, id, command); err != nil || replay.Status != "cancelled" {
		t.Fatal("history quota blocked original command replay", replay, err)
	}
	if err := (sessionStore{database: f.store.database}).Revoke(ctx, owner, f.tokens[0].Identity.SessionID); err != nil {
		t.Fatal(err)
	}
	if _, err := f.store.CancelQueuedStudyRun(ctx, owner, f.project, id, command); !errors.Is(err, sql.ErrNoRows) {
		t.Fatal("revoked session replayed cancellation", err)
	}
}

func TestCancellationLosesToWorkerClaimPostgres(t *testing.T) {
	f, _, run := admittedRunFixture(t)
	ctx := context.Background()
	claim := runClaim(t, f, 7201)
	id, _ := strconv.ParseInt(run.ID, 10, 64)
	for _, state := range []string{"validating", "initializing", "running", "failed"} {
		if state == "initializing" || state == "running" {
			if err := f.store.AdvanceStudyRun(ctx, claim, state); err != nil {
				t.Fatal(err)
			}
		}
		if state == "failed" {
			if err := f.store.FailStudyRun(ctx, claim, "worker_transport"); err != nil {
				t.Fatal(err)
			}
		}
		if _, err := f.store.CancelQueuedStudyRun(ctx, f.tokens[0].Token, f.project, id, studyCommand(7202)); !errors.Is(err, errStudyRunStarted) {
			t.Fatal(state, err)
		}
	}
	if _, err := f.store.database.Exec(`INSERT INTO project_study_run_cancellations(project_id,command_id,run_id,requested_by) VALUES($1,$2,$3,$4)`, f.project, studyCommand(7203), id, f.tokens[0].Identity.AccountID); err == nil {
		t.Fatal("direct SQL cancelled claimed run")
	}
}

func TestQueuedCancellationClaimRacePostgres(t *testing.T) {
	f, _, run := admittedRunFixture(t)
	ctx := context.Background()
	id, _ := strconv.ParseInt(run.ID, 10, 64)
	start := make(chan struct{})
	cancelled := make(chan error, 1)
	claimed := make(chan error, 1)
	go func() {
		<-start
		_, err := f.store.CancelQueuedStudyRun(ctx, f.tokens[0].Token, f.project, id, studyCommand(7301))
		cancelled <- err
	}()
	go func() { <-start; _, err := f.store.ClaimStudyRun(ctx, studyCommand(7302)); claimed <- err }()
	close(start)
	cancelErr, claimErr := <-cancelled, <-claimed
	if !((cancelErr == nil && errors.Is(claimErr, sql.ErrNoRows)) || (errors.Is(cancelErr, errStudyRunStarted) && claimErr == nil)) {
		t.Fatal("neither or both transitions won", cancelErr, claimErr)
	}
	var cancellations, leases int
	if err := f.store.database.QueryRow(`SELECT (SELECT count(*) FROM project_study_run_cancellations),(SELECT count(*) FROM project_study_run_leases)`).Scan(&cancellations, &leases); err != nil || cancellations+leases != 1 {
		t.Fatal("conflicting durable states", cancellations, leases, err)
	}
}

func TestCancellationFreesActiveQuotaPostgres(t *testing.T) {
	f, v, run := admittedRunFixture(t)
	ctx := context.Background()
	owner := f.tokens[0].Token
	study, _ := strconv.ParseInt(v.ID, 10, 64)
	id, _ := strconv.ParseInt(run.ID, 10, 64)
	for i := 0; i < 19; i++ {
		if _, err := f.store.EnqueueStudyRun(ctx, owner, f.project, study, 1, studyCommand(7400+i)); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := f.store.EnqueueStudyRun(ctx, owner, f.project, study, 1, studyCommand(7420)); !errors.Is(err, errStudyRunQuota) {
		t.Fatal(err)
	}
	if _, err := f.store.CancelQueuedStudyRun(ctx, owner, f.project, id, studyCommand(7421)); err != nil {
		t.Fatal(err)
	}
	if _, err := f.store.EnqueueStudyRun(ctx, owner, f.project, study, 1, studyCommand(7420)); err != nil {
		t.Fatal("cancelled run retained active slot", err)
	}
	var count int
	if err := f.store.database.QueryRow(`SELECT count(*) FROM project_study_runs`).Scan(&count); err != nil || count != 21 {
		t.Fatal("admission history changed", count, err)
	}
}

func TestCancellationAuditDetectsBypassedFencesPostgres(t *testing.T) {
	f, _, run := admittedRunFixture(t)
	ctx := context.Background()
	_ = runClaim(t, f, 7701)
	id, _ := strconv.ParseInt(run.ID, 10, 64)
	// Administrative fault injection on this disposable schema only. Re-enable
	// the trigger before auditing so the data conflict must be detected itself.
	tx, err := f.store.database.BeginTx(ctx, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer rollbackTx(tx)
	if _, err = tx.Exec(`ALTER TABLE project_study_run_cancellations DISABLE TRIGGER study_run_cancellation_guard`); err != nil {
		t.Fatal(err)
	}
	if _, err = tx.Exec(`INSERT INTO project_study_run_cancellations(project_id,command_id,run_id,requested_by) VALUES($1,$2,$3,$4)`, f.project, studyCommand(7702), id, f.tokens[0].Identity.AccountID); err != nil {
		t.Fatal(err)
	}
	if _, err = tx.Exec(`ALTER TABLE project_study_run_cancellations ENABLE TRIGGER study_run_cancellation_guard`); err != nil {
		t.Fatal(err)
	}
	if err = tx.Commit(); err != nil {
		t.Fatal(err)
	}
	report, err := auditDatabase(ctx, f.store.database, migrationSourceURL(t))
	if err != nil {
		t.Fatal(err)
	}
	if report.Status != "review_required" || len(report.Findings) != 1 || report.Findings[0] != "run_cancellation_conflict" {
		t.Fatal(report)
	}
	if n := report.Counts["runCancellationConflicts"]; n == nil || *n != 1 {
		t.Fatal(n)
	}
}
