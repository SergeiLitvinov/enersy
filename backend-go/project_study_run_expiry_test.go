package main

import (
	"context"
	"errors"
	"testing"
	"time"
)

func TestStudyRunExpiryDuringPublicationPostgres(t *testing.T) {
	f, _, _ := admittedRunFixture(t)
	ctx, cancel := context.WithTimeout(context.Background(), 8*time.Second)
	defer cancel()
	claim := runClaim(t, f, 2801)
	startRun(t, f, claim)
	blocker, err := f.store.database.BeginTx(ctx, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer blocker.Rollback()
	var pid int
	if err = blocker.QueryRowContext(ctx, `SELECT pg_backend_pid()`).Scan(&pid); err != nil {
		t.Fatal(err)
	}
	if _, err = blocker.ExecContext(ctx, `SELECT pg_advisory_xact_lock(hashtextextended('enersy-calculation-archives:' || $1::text,0))`, f.project); err != nil {
		t.Fatal(err)
	}
	// Administrative fault injection shortens only this test's lease. The normal
	// 30-second production lease and numerical budgets remain unchanged.
	if _, err = f.store.database.ExecContext(ctx, `UPDATE project_study_run_leases SET lease_until=clock_timestamp()+interval '2 seconds' WHERE run_id=$1`, claim.ID); err != nil {
		t.Fatal(err)
	}
	completed := make(chan error, 1)
	go func() { _, err := f.store.CompleteStudyRun(ctx, claim, []byte(runTransportResult)); completed <- err }()
	// Prove completion acquired its execution lock and reached the archive lock.
	for {
		var waiting bool
		if err = f.store.database.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid)))`, pid).Scan(&waiting); err != nil {
			t.Fatal(err)
		}
		if waiting {
			break
		}
		select {
		case err := <-completed:
			t.Fatal("completion did not reach quota barrier", err)
		case <-time.After(time.Millisecond):
		case <-ctx.Done():
			t.Fatal(ctx.Err())
		}
	}
	// Observe database time crossing the actual deadline rather than assuming a
	// fixed sleep is enough. The completion transaction still holds its row lock.
	for {
		var expired bool
		if err = f.store.database.QueryRowContext(ctx, `SELECT lease_until<=clock_timestamp() FROM project_study_run_leases WHERE run_id=$1`, claim.ID).Scan(&expired); err != nil {
			t.Fatal(err)
		}
		if expired {
			break
		}
		select {
		case <-time.After(5 * time.Millisecond):
		case <-ctx.Done():
			t.Fatal(ctx.Err())
		}
	}
	if err = blocker.Rollback(); err != nil {
		t.Fatal(err)
	}
	select {
	case err = <-completed:
		if !errors.Is(err, errRunLeaseLost) {
			t.Fatal("expired execution published", err)
		}
	case <-ctx.Done():
		t.Fatal(ctx.Err())
	}
	var count int
	if err = f.store.database.QueryRowContext(ctx, `SELECT count(*) FROM project_calculation_archives`).Scan(&count); err != nil || count != 0 {
		t.Fatal("expired publication left an artifact", count, err)
	}
	replacement := runClaim(t, f, 2802)
	if replacement.ID != claim.ID || replacement.Generation != claim.Generation+1 {
		t.Fatal("expired publication was not recoverable", replacement)
	}
}
