package main

import (
	"context"
	"encoding/json"
	"errors"
	"net/http/httptest"
	"strconv"
	"testing"
	"time"
)

func TestStudyParameterChangeBeforeCommitPostgres(t *testing.T) {
	f := newStudyFixture(t)
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	blocker, err := f.store.database.BeginTx(ctx, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer blocker.Rollback()
	var key int64
	if err := blocker.QueryRowContext(ctx, `SELECT hashtextextended('enersy-studies:' || $1::text,0)`, f.project).Scan(&key); err != nil {
		t.Fatal(err)
	}
	if _, err := blocker.ExecContext(ctx, `SELECT pg_advisory_xact_lock($1)`, key); err != nil {
		t.Fatal(err)
	}
	type outcome struct {
		version studyVersion
		err     error
	}
	done := make(chan outcome, 1)
	finished := make(chan struct{})
	go func() {
		defer close(finished)
		v, err := f.store.SaveStudy(ctx, f.tokens[0].Token, f.project, f.scheme, 0, 0, f.topology, studyCommand(801), f.doc)
		done <- outcome{v, err}
	}()
	defer func() { _ = blocker.Rollback(); cancel(); <-finished }()
	// Wait for the exact post-snapshot write barrier, not an arbitrary sleep.
	deadline := time.Now().Add(5 * time.Second)
	for {
		var waiting bool
		if err := f.store.database.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM pg_locks WHERE locktype='advisory' AND NOT granted AND classid=(($1::bigint>>32)&4294967295)::oid AND objid=($1::bigint&4294967295)::oid AND objsubid=1)`, key).Scan(&waiting); err != nil {
			t.Fatal(err)
		}
		if waiting {
			break
		}
		select {
		case result := <-done:
			t.Fatalf("save ended before barrier: %v", result.err)
		default:
		}
		if time.Now().After(deadline) {
			t.Fatal("Study did not reach post-snapshot barrier")
		}
		time.Sleep(10 * time.Millisecond)
	}
	if _, err := f.store.database.ExecContext(ctx, `UPDATE scheme_component_params SET param_value='0.1' WHERE scheme_component_id=$1 AND param_key='p'`, f.load); err != nil {
		t.Fatal(err)
	}
	var topology int64
	if err := f.store.database.QueryRowContext(ctx, `SELECT topology_revision FROM circuit_schemes WHERE id=$1`, f.scheme).Scan(&topology); err != nil || topology != f.topology {
		t.Fatalf("fixture unexpectedly changed topology: %d %v", topology, err)
	}
	if err := blocker.Rollback(); err != nil {
		t.Fatal(err)
	}
	result := <-done
	if !errors.Is(result.err, errStudySource) {
		t.Fatalf("parameter revision change accepted: version=%s error=%v", result.version.ID, result.err)
	}
	var studies, versions int
	if err := f.store.database.QueryRowContext(ctx, `SELECT (SELECT count(*) FROM project_studies WHERE project_id=$1),(SELECT count(*) FROM project_study_versions WHERE project_id=$1)`, f.project).Scan(&studies, &versions); err != nil || studies != 0 || versions != 0 {
		t.Fatalf("partial capture persisted: %d/%d %v", studies, versions, err)
	}
	// A rejected command has no success receipt. Explicit retry captures the new
	// source once; later successful retries must keep that immutable capture.
	version, err := f.store.SaveStudy(ctx, f.tokens[0].Token, f.project, f.scheme, 0, 0, f.topology, studyCommand(801), f.doc)
	if err != nil {
		t.Fatal(err)
	}
	id, _ := strconv.ParseInt(version.ID, 10, 64)
	_, body, err := f.store.ReadStudy(ctx, f.tokens[0].Token, f.project, id, 1, "input")
	if err != nil {
		t.Fatal(err)
	}
	var input struct {
		Components []calculationComponent `json:"components"`
	}
	if err := json.Unmarshal(body, &input); err != nil {
		t.Fatal(err)
	}
	found := false
	for _, component := range input.Components {
		if component.ID == f.load {
			found = true
			if component.Params["p"] != "0.1" {
				t.Fatal("retry kept the old demand")
			}
		}
	}
	if !found {
		t.Fatal("load absent from capture")
	}
	if _, err := f.store.database.ExecContext(ctx, `UPDATE scheme_component_params SET param_value='0.05' WHERE scheme_component_id=$1 AND param_key='p'`, f.load); err != nil {
		t.Fatal(err)
	}
	replay, err := f.store.SaveStudy(ctx, f.tokens[0].Token, f.project, f.scheme, 0, 0, f.topology, studyCommand(801), f.doc)
	if err != nil || replay.ID != version.ID || replay.InputSHA256 != version.InputSHA256 {
		t.Fatalf("success replay changed capture: %+v %v", replay, err)
	}
}

func TestStudySourceLocksParameterRevisionUntilRollbackPostgres(t *testing.T) {
	f := newStudyFixture(t)
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	input, err := readCalculationInputScope(ctx, f.store.database, f.scheme, f.project, f.tokens[0].Token, true)
	if err != nil {
		t.Fatal(err)
	}
	tx, err := f.store.database.BeginTx(ctx, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback()
	if _, err := lockArchiveProject(ctx, tx, f.tokens[0].Token, f.project, true); err != nil {
		t.Fatal(err)
	}
	var savePID, scheme int
	if err := tx.QueryRowContext(ctx, `SELECT id,pg_backend_pid() FROM circuit_schemes WHERE id=$1 AND project_id=$2 FOR SHARE`, f.scheme, f.project).Scan(&scheme, &savePID); err != nil {
		t.Fatal(err)
	}
	if err := checkStudySourceRevisions(ctx, tx, scheme, input.Components); err != nil {
		t.Fatal(err)
	}
	writer, err := f.store.database.Conn(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer writer.Close()
	var writerPID int
	if err := writer.QueryRowContext(ctx, `SELECT pg_backend_pid()`).Scan(&writerPID); err != nil {
		t.Fatal(err)
	}
	done, finished := make(chan error, 1), make(chan struct{})
	go func() {
		defer close(finished)
		_, err := writer.ExecContext(ctx, `UPDATE scheme_component_params SET param_value='0.1' WHERE scheme_component_id=$1 AND param_key='p'`, f.load)
		done <- err
	}()
	defer func() { _ = tx.Rollback(); cancel(); <-finished }()
	deadline := time.Now().Add(5 * time.Second)
	for {
		var blocked bool
		if err := f.store.database.QueryRowContext(ctx, `SELECT $1::int=ANY(pg_blocking_pids($2))`, savePID, writerPID).Scan(&blocked); err != nil {
			t.Fatal(err)
		}
		if blocked {
			break
		}
		select {
		case err := <-done:
			t.Fatalf("parameter writer was not held by capture: %v", err)
		default:
		}
		if time.Now().After(deadline) {
			t.Fatal("parameter writer did not wait for source revision lock")
		}
		time.Sleep(10 * time.Millisecond)
	}
	if err := tx.Rollback(); err != nil {
		t.Fatal(err)
	}
	if err := <-done; err != nil {
		t.Fatal(err)
	}
	// The trigger can advance the revision after rollback releases SHARE locks.
	check, err := f.store.database.BeginTx(ctx, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer check.Rollback()
	if err := checkStudySourceRevisions(ctx, check, f.scheme, input.Components); !errors.Is(err, errStudySource) {
		t.Fatalf("changed revision went unnoticed: %v", err)
	}
}

func TestStudyEquipmentConflictUsesExistingHTTPContract(t *testing.T) {
	w := httptest.NewRecorder()
	if !studyHTTPError(w, errStudySource) {
		t.Fatal("source conflict not handled")
	}
	var body struct {
		Code string `json:"code"`
	}
	if json.Unmarshal(w.Body.Bytes(), &body) != nil || w.Code != 412 || body.Code != "study_source_conflict" {
		t.Fatalf("source conflict contract changed: %d %s", w.Code, w.Body.String())
	}
}
