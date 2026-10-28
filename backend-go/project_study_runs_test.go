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

func TestStudyRunAdmissionPostgres(t *testing.T) {
	f := newStudyFixture(t)
	ctx := context.Background()
	owner := f.tokens[0].Token
	v, err := f.store.SaveStudy(ctx, owner, f.project, f.scheme, 0, 0, f.topology, studyCommand(901), f.doc)
	if err != nil {
		t.Fatal(err)
	}
	study, _ := strconv.ParseInt(v.ID, 10, 64)
	// Concurrent duplicate deliveries admit exactly one durable command.
	const attempts = 8
	var wg sync.WaitGroup
	results := make(chan studyRun, attempts)
	errorsOut := make(chan error, attempts)
	for i := 0; i < attempts; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			run, err := f.store.EnqueueStudyRun(ctx, owner, f.project, study, 1, studyCommand(902))
			results <- run
			errorsOut <- err
		}()
	}
	wg.Wait()
	close(results)
	close(errorsOut)
	for err := range errorsOut {
		if err != nil {
			t.Fatal(err)
		}
	}
	var first studyRun
	for run := range results {
		if first.ID == "" {
			first = run
		}
		if run != first || run.Status != "queued" || run.InputSHA256 != v.InputSHA256 || run.ProvenanceSHA256 != v.ProvenanceSHA256 || run.StudyRevision != "1" {
			t.Fatal("duplicate delivery changed immutable target", run, first)
		}
	}
	var count int
	if err := f.store.database.QueryRow(`SELECT count(*) FROM project_study_runs`).Scan(&count); err != nil || count != 1 {
		t.Fatal("duplicate admission", count, err)
	}
	// A later head does not change a queued version or a successful replay.
	f.doc.Name = "New study head"
	if _, err = f.store.SaveStudy(ctx, owner, f.project, 0, study, 1, f.topology, studyCommand(903), f.doc); err != nil {
		t.Fatal(err)
	}
	if _, err = f.store.EnqueueStudyRun(ctx, owner, f.project, study, 2, studyCommand(902)); !errors.Is(err, errStudyRunCommand) {
		t.Fatal("command retargeted to a later version", err)
	}
	if _, err = f.store.EnqueueStudyRun(ctx, owner, f.project, study, 0, studyCommand(904)); !errors.Is(err, errStudyInput) {
		t.Fatal("implicit current head accepted", err)
	}
	if _, err = f.store.EnqueueStudyRun(ctx, owner, f.project, study, 99, studyCommand(904)); !errors.Is(err, sql.ErrNoRows) {
		t.Fatal("missing version accepted", err)
	}
	id, _ := strconv.ParseInt(first.ID, 10, 64)
	for _, actor := range []int{0, 1, 2} {
		read, err := f.store.ReadStudyRun(ctx, f.tokens[actor].Token, f.project, id)
		if err != nil || read != first {
			t.Fatal("project reader could not inspect run", actor, read, err)
		}
	}
	for _, actor := range []int{2, 3} {
		if _, err = f.store.EnqueueStudyRun(ctx, f.tokens[actor].Token, f.project, study, 1, studyCommand(902)); !errors.Is(err, sql.ErrNoRows) {
			t.Fatal("unauthorized replay exposed run", actor, err)
		}
	}
	if _, err = f.store.ReadStudyRun(ctx, f.tokens[3].Token, f.project, id); !errors.Is(err, sql.ErrNoRows) {
		t.Fatal("outsider read a run", err)
	}
	otherProject, err := f.store.Create(ctx, owner, "Other run project")
	if err != nil {
		t.Fatal(err)
	}
	if _, err = f.store.ReadStudyRun(ctx, owner, otherProject, id); !errors.Is(err, sql.ErrNoRows) {
		t.Fatal("cross-project run read", err)
	}
	if _, err = f.store.EnqueueStudyRun(ctx, owner, otherProject, study, 1, studyCommand(905)); !errors.Is(err, sql.ErrNoRows) {
		t.Fatal("cross-project Study admitted", err)
	}
	// Deleting the working graph does not destroy the admitted immutable input.
	if _, err = f.store.database.Exec(`DELETE FROM circuit_schemes WHERE id=$1`, f.scheme); err != nil {
		t.Fatal(err)
	}
	if replay, err := f.store.EnqueueStudyRun(ctx, owner, f.project, study, 1, studyCommand(902)); err != nil || replay != first {
		t.Fatal("source deletion changed replay", replay, err)
	}
	if _, err = f.store.EnqueueStudyRun(ctx, owner, f.project, study, 1, studyCommand(906)); err != nil {
		t.Fatal("historical version required a live scheme", err)
	}
	for _, query := range []string{
		`UPDATE project_study_runs SET study_revision=2 WHERE id=$1`,
		`UPDATE project_study_runs SET status='succeeded' WHERE id=$1`,
		`DELETE FROM project_study_runs WHERE id=$1`,
	} {
		if _, err = f.store.database.Exec(query, id); err == nil {
			t.Fatal("SQL changed immutable admission", query)
		}
	}
	// Project deletion is the one intentional history deletion boundary.
	if _, err = f.store.database.Exec(`DELETE FROM projects WHERE id=$1`, f.project); err != nil {
		t.Fatal("project deletion failed", err)
	}
	if err = f.store.database.QueryRow(`SELECT count(*) FROM project_study_runs`).Scan(&count); err != nil || count != 0 {
		t.Fatal("private admissions survived project deletion", count, err)
	}
}

func TestStudyRunQuotaAndMigrationPostgres(t *testing.T) {
	f := newStudyFixture(t)
	ctx := context.Background()
	owner := f.tokens[0].Token
	for _, migration := range []string{"20261028002_study_run_leases.down", "20261028001_study_run_queue.down", "20261028001_study_run_queue.up", "20261028002_study_run_leases.up"} {
		body, err := os.ReadFile(filepath.Join("..", "database", "migrations", migration+".sql"))
		if err != nil {
			t.Fatal(err)
		}
		if _, err = f.store.database.Exec(string(body)); err != nil {
			t.Fatal("empty migration round trip", err)
		}
	}
	v, err := f.store.SaveStudy(ctx, owner, f.project, f.scheme, 0, 0, f.topology, studyCommand(951), f.doc)
	if err != nil {
		t.Fatal(err)
	}
	study, _ := strconv.ParseInt(v.ID, 10, 64)
	var first studyRun
	for i := 0; i < 20; i++ {
		run, err := f.store.EnqueueStudyRun(ctx, owner, f.project, study, 1, studyCommand(1000+i))
		if err != nil {
			t.Fatal(i, err)
		}
		if i == 0 {
			first = run
		}
	}
	if _, err = f.store.EnqueueStudyRun(ctx, owner, f.project, study, 1, studyCommand(1020)); !errors.Is(err, errStudyRunQuota) {
		t.Fatal("project admission quota ignored", err)
	}
	if replay, err := f.store.EnqueueStudyRun(ctx, owner, f.project, study, 1, studyCommand(1000)); err != nil || replay != first {
		t.Fatal("quota blocked successful replay", replay, err)
	}
	body, err := os.ReadFile(filepath.Join("..", "database", "migrations", "20261028001_study_run_queue.down.sql"))
	if err != nil {
		t.Fatal(err)
	}
	if _, err = f.store.database.Exec(string(body)); err == nil {
		t.Fatal("downgrade discarded admitted commands")
	}
	if err = (sessionStore{database: f.store.database}).Revoke(ctx, owner, f.tokens[0].Identity.SessionID); err != nil {
		t.Fatal(err)
	}
	if _, err = f.store.EnqueueStudyRun(ctx, owner, f.project, study, 1, studyCommand(1000)); !errors.Is(err, sql.ErrNoRows) {
		t.Fatal("revoked session replayed admission", err)
	}
}
