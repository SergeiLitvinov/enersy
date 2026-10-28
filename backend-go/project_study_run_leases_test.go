package main

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"strconv"
	"sync"
	"syscall"
	"testing"
	"time"
)

// A transport fixture only; numerical accuracy is tested with the real worker.
const runTransportResult = `{"success":true,"node_count":1,"nodes":[{"node_id":1,"voltage":1.234567890123456700e+1}],"method_used":"three-phase/newton-raphson","version":"transport-fixture","solver":{"compute_backend":{"id":"julia"}},"operating_assessment":{"schema_version":1,"policy":"explicit-terminal-voltage-v1","stability_assessed":false,"status":"not_declared","checks":[]}}`

func admittedRunFixture(t *testing.T, backends ...string) (studyTestFixture, studyVersion, studyRun) {
	t.Helper()
	f := newStudyFixture(t)
	if len(backends) == 1 {
		f.doc.ComputeBackend = backends[0]
	}
	f.doc.Limits = []terminalVoltageLimit{}
	v, err := f.store.SaveStudy(context.Background(), f.tokens[0].Token, f.project, f.scheme, 0, 0, f.topology, studyCommand(2001), f.doc)
	if err != nil {
		t.Fatal(err)
	}
	id, _ := strconv.ParseInt(v.ID, 10, 64)
	run, err := f.store.EnqueueStudyRun(context.Background(), f.tokens[0].Token, f.project, id, 1, studyCommand(2002))
	if err != nil {
		t.Fatal(err)
	}
	return f, v, run
}

func runClaim(t *testing.T, f studyTestFixture, executor int) studyRunClaim {
	t.Helper()
	claim, err := f.store.ClaimStudyRun(context.Background(), studyCommand(executor))
	if err != nil {
		t.Fatal(err)
	}
	return claim
}

func startRun(t *testing.T, f studyTestFixture, claim studyRunClaim) {
	t.Helper()
	for _, state := range []string{"initializing", "running"} {
		if err := f.store.AdvanceStudyRun(context.Background(), claim, state); err != nil {
			t.Fatal(err)
		}
	}
}

func expireRun(t *testing.T, f studyTestFixture, claim studyRunClaim) {
	t.Helper()
	// Administrative fault injection; no waiting or weakening the production TTL.
	if _, err := f.store.database.Exec(`UPDATE project_study_run_leases SET lease_until=clock_timestamp()-interval '1 second' WHERE run_id=$1`, claim.ID); err != nil {
		t.Fatal(err)
	}
}

func TestStudyRunLeaseFencingPostgres(t *testing.T) {
	f, v, run := admittedRunFixture(t)
	ctx := context.Background()
	first := runClaim(t, f, 2101)
	if first.Generation != 1 || archiveDigest(first.Input) != v.InputSHA256 {
		t.Fatal("claim changed frozen input", first)
	}
	if _, err := f.store.ClaimStudyRun(ctx, studyCommand(2102)); !errors.Is(err, sql.ErrNoRows) {
		t.Fatal("live lease was delivered twice", err)
	}
	if err := f.store.RenewStudyRun(ctx, first); err != nil {
		t.Fatal(err)
	}
	wrong := first
	wrong.Executor = studyCommand(2102)
	if err := f.store.RenewStudyRun(ctx, wrong); !errors.Is(err, errRunLeaseLost) {
		t.Fatal("other executor renewed lease", err)
	}
	expireRun(t, f, first)
	if err := f.store.RenewStudyRun(ctx, first); !errors.Is(err, errRunLeaseLost) {
		t.Fatal("expired lease resurrected", err)
	}
	second := runClaim(t, f, 2102)
	if second.ID != first.ID || second.Generation != 2 || !bytes.Equal(first.Input, second.Input) {
		t.Fatal("reclaim changed target", first, second)
	}
	startRun(t, f, second)
	if _, err := f.store.CompleteStudyRun(ctx, first, []byte(runTransportResult)); !errors.Is(err, errRunLeaseLost) {
		t.Fatal("stale executor published", err)
	}
	if err := f.store.FailStudyRun(ctx, first, "worker_transport"); !errors.Is(err, errRunLeaseLost) {
		t.Fatal("stale executor failed replacement", err)
	}
	if _, err := f.store.CompleteStudyRun(ctx, second, []byte(`{"success":true}`)); !errors.Is(err, errArchiveResult) {
		t.Fatal("invalid result archived", err)
	}
	wrongEngine := bytes.ReplaceAll([]byte(runTransportResult), []byte(`"id":"julia"`), []byte(`"id":"julia-rust-jacobian"`))
	if _, err := f.store.CompleteStudyRun(ctx, second, wrongEngine); !errors.Is(err, errArchiveResult) {
		t.Fatal("another compute backend was silently accepted", err)
	}
	var count int
	if err := f.store.database.QueryRow(`SELECT count(*) FROM project_calculation_archives`).Scan(&count); err != nil || count != 0 {
		t.Fatal("rejected completion left an archive", count, err)
	}
	archive, err := f.store.CompleteStudyRun(ctx, second, []byte(runTransportResult))
	if err != nil {
		t.Fatal(err)
	}
	if _, err = f.store.CompleteStudyRun(ctx, second, []byte(runTransportResult)); !errors.Is(err, errRunLeaseLost) {
		t.Fatal("second terminal publication accepted", err)
	}
	read, err := f.store.ReadStudyRun(ctx, f.tokens[2].Token, f.project, second.ID)
	if err != nil || read.Status != "succeeded" || read.ArchiveID != strconv.FormatInt(archive, 10) || read.InputSHA256 != run.InputSHA256 {
		t.Fatal("terminal metadata mismatch", read, err)
	}
	_, input, result, err := f.store.CalculationArchive(ctx, f.tokens[2].Token, f.project, archive)
	if err != nil || !bytes.Equal(input, second.Input) || string(result) != runTransportResult {
		t.Fatal("archive rounded or changed bytes", err)
	}
	if _, err = f.store.ClaimStudyRun(ctx, studyCommand(2103)); !errors.Is(err, sql.ErrNoRows) {
		t.Fatal("terminal run redelivered", err)
	}
	if _, err = f.store.database.Exec(`UPDATE project_study_run_leases SET status='running',archive_id=NULL,lease_until=clock_timestamp()+interval '30 seconds' WHERE run_id=$1`, first.ID); err == nil {
		t.Fatal("SQL reopened terminal execution")
	}
	if _, err = f.store.database.Exec(`DELETE FROM circuit_schemes WHERE id=$1`, f.scheme); err != nil {
		t.Fatal(err)
	}
	if _, err = f.store.database.Exec(`DELETE FROM projects WHERE id=$1`, f.project); err != nil {
		t.Fatal("project deletion did not clear private execution", err)
	}
}

func TestStudyRunClaimRaceAndExhaustionPostgres(t *testing.T) {
	f, _, _ := admittedRunFixture(t)
	ctx := context.Background()
	var wg sync.WaitGroup
	claims := make(chan studyRunClaim, 8)
	errs := make(chan error, 8)
	for i := 0; i < 8; i++ {
		wg.Add(1)
		go func(executor int) {
			defer wg.Done()
			claim, err := f.store.ClaimStudyRun(ctx, studyCommand(executor))
			if err == nil {
				claims <- claim
			} else if !errors.Is(err, sql.ErrNoRows) {
				errs <- err
			}
		}(2200 + i)
	}
	wg.Wait()
	close(errs)
	for err := range errs {
		t.Fatal(err)
	}
	if len(claims) != 1 {
		t.Fatal("concurrent claims", len(claims))
	}
	claim := <-claims
	for attempt := int64(2); attempt <= 3; attempt++ {
		expireRun(t, f, claim)
		claim = runClaim(t, f, 2210+int(attempt))
		if claim.Generation != attempt {
			t.Fatal("nonmonotone fencing generation", claim.Generation)
		}
	}
	expireRun(t, f, claim)
	if _, err := f.store.ClaimStudyRun(ctx, studyCommand(2220)); !errors.Is(err, sql.ErrNoRows) {
		t.Fatal("unbounded crash retry", err)
	}
	read, err := f.store.ReadStudyRun(ctx, f.tokens[0].Token, f.project, claim.ID)
	if err != nil || read.Status != "failed" || read.ErrorCode != "lease_exhausted" {
		t.Fatal("exhausted run was not terminal", read, err)
	}
}

func TestStudyRunDispatcherFrozenArchivePostgres(t *testing.T) {
	f, v, _ := admittedRunFixture(t)
	ctx := context.Background()
	claim := runClaim(t, f, 2301)
	received := make(chan []byte, 1)
	worker := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/ready" {
			w.WriteHeader(200)
			return
		}
		if r.URL.Path != "/calculate" || r.Header.Get("Cookie") != "" || r.Header.Get("Authorization") != "" {
			t.Error("unexpected worker endpoint or credentials")
		}
		body, _ := io.ReadAll(r.Body)
		received <- body
		_, _ = io.WriteString(w, runTransportResult)
	}))
	defer worker.Close()
	if _, err := f.store.database.Exec(`UPDATE scheme_component_params SET param_value='0.1' WHERE scheme_component_id=$1 AND param_key='p'`, f.load); err != nil {
		t.Fatal(err)
	}
	// An admitted command survives logout and removal of its mutable source.
	if err := (sessionStore{database: f.store.database}).Revoke(ctx, f.tokens[0].Token, f.tokens[0].Identity.SessionID); err != nil {
		t.Fatal(err)
	}
	if _, err := f.store.database.Exec(`DELETE FROM circuit_schemes WHERE id=$1`, f.scheme); err != nil {
		t.Fatal(err)
	}
	executeStudyRun(ctx, f.store, worker.URL, claim)
	read, err := f.store.ReadStudyRun(ctx, f.tokens[1].Token, f.project, claim.ID)
	if err != nil || read.Status != "succeeded" || archiveDigest(<-received) != v.InputSHA256 {
		t.Fatal("dispatcher did not preserve admitted source", read, err)
	}
}

func TestStudyRunDispatcherFailurePostgres(t *testing.T) {
	for _, tc := range []struct {
		name, body, code string
		status           int
	}{
		{"invalid result", `{}`, "invalid_result", 200},
		{"worker rejection", `{"error":"fixture"}`, "worker_rejected", 400},
		{"redirect", `{}`, "worker_rejected", 307},
	} {
		t.Run(tc.name, func(t *testing.T) {
			f, _, _ := admittedRunFixture(t)
			claim := runClaim(t, f, 2401)
			worker := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.URL.Path == "/ready" {
					w.WriteHeader(200)
					return
				}
				w.WriteHeader(tc.status)
				_, _ = io.WriteString(w, tc.body)
			}))
			defer worker.Close()
			executeStudyRun(context.Background(), f.store, worker.URL, claim)
			read, err := f.store.ReadStudyRun(context.Background(), f.tokens[0].Token, f.project, claim.ID)
			if err != nil || read.Status != "failed" || read.ErrorCode != tc.code {
				t.Fatal(read, err)
			}
		})
	}
}

func TestStudyRunRealWorkerPostgres(t *testing.T) {
	worker := os.Getenv("TEST_JULIA_URL")
	if worker == "" {
		t.Skip("Set TEST_JULIA_URL for real Study Run execution")
	}
	backend := os.Getenv("TEST_COMPUTE_BACKEND")
	if backend == "" {
		backend = "julia"
	}
	f, v, _ := admittedRunFixture(t, backend)
	claim := runClaim(t, f, 2501)
	if _, err := f.store.database.Exec(`UPDATE scheme_component_params SET param_value='0.1' WHERE scheme_component_id=$1 AND param_key='p'`, f.load); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 40*time.Second)
	defer cancel()
	executeStudyRun(ctx, f.store, worker, claim)
	read, err := f.store.ReadStudyRun(ctx, f.tokens[0].Token, f.project, claim.ID)
	if err != nil || read.Status != "succeeded" || read.InputSHA256 != v.InputSHA256 {
		t.Fatal(read, err)
	}
	archive, _ := strconv.ParseInt(read.ArchiveID, 10, 64)
	_, input, body, err := f.store.CalculationArchive(ctx, f.tokens[0].Token, f.project, archive)
	if err != nil || archiveDigest(input) != v.InputSHA256 {
		t.Fatal("archive input mismatch", err)
	}
	var result struct {
		Nodes []struct {
			Voltage  float64 `json:"voltage"`
			Internal bool    `json:"is_internal_source_node"`
		} `json:"nodes"`
	}
	if err = json.Unmarshal(body, &result); err != nil {
		t.Fatal(err)
	}
	external := 0
	for _, node := range result.Nodes {
		if !node.Internal {
			external++
			if math.Abs(node.Voltage-(1+math.Sqrt(0.2))/2) > 1e-10 {
				t.Fatal("used edited demand", node.Voltage)
			}
		}
	}
	if external != 1 {
		t.Fatalf("expected one external bus, got %d", external)
	}
}

func TestStudyRunWorkerProcessPostgres(t *testing.T) {
	binary := os.Getenv("TEST_OPERATOR_BINARY")
	if binary == "" {
		t.Skip("Set TEST_OPERATOR_BINARY for Docker worker process acceptance")
	}
	f, v, run := admittedRunFixture(t)
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	var schema string
	if err := f.store.database.QueryRow(`SELECT current_schema()`).Scan(&schema); err != nil {
		t.Fatal(err)
	}
	received := make(chan []byte, 1)
	worker := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/ready" {
			w.WriteHeader(200)
			return
		}
		body, _ := io.ReadAll(r.Body)
		received <- body
		_, _ = io.WriteString(w, runTransportResult)
	}))
	defer worker.Close()
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	port := listener.Addr().(*net.TCPAddr).Port
	listener.Close()
	cmd := exec.CommandContext(ctx, binary, "-study-worker")
	cmd.Env = append(os.Environ(), "PGOPTIONS=-c search_path="+schema, "MIGRATIONS_SOURCE="+migrationSourceURL(t), "PORT="+strconv.Itoa(port), "JULIA_BASE_URL="+worker.URL)
	var output bytes.Buffer
	cmd.Stdout, cmd.Stderr = &output, &output
	if err = cmd.Start(); err != nil {
		t.Fatal(err)
	}
	finished := make(chan error, 1)
	go func() { finished <- cmd.Wait() }()
	defer func() { _ = cmd.Process.Kill() }()
	select {
	case input := <-received:
		if archiveDigest(input) != v.InputSHA256 {
			t.Fatal("process used another source")
		}
	case err = <-finished:
		t.Fatal("worker exited before execution", err, output.String())
	case <-ctx.Done():
		t.Fatal("worker did not execute queued command")
	}
	id, _ := strconv.ParseInt(run.ID, 10, 64)
	for {
		read, err := f.store.ReadStudyRun(ctx, f.tokens[0].Token, f.project, id)
		if err != nil {
			t.Fatal(err)
		}
		if read.Status == "succeeded" {
			break
		}
		if read.Status == "failed" {
			t.Fatal(read)
		}
		select {
		case <-time.After(20 * time.Millisecond):
		case <-ctx.Done():
			t.Fatal("worker did not publish")
		}
	}
	req, _ := http.NewRequestWithContext(ctx, http.MethodGet, fmt.Sprintf("http://127.0.0.1:%d/ready", port), nil)
	response, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	response.Body.Close()
	if response.StatusCode != 200 {
		t.Fatal("worker readiness", response.StatusCode)
	}
	if err = cmd.Process.Signal(syscall.SIGTERM); err != nil {
		t.Fatal(err)
	}
	select {
	case err = <-finished:
		if err != nil {
			t.Fatal("worker did not shut down cleanly", err, output.String())
		}
	case <-ctx.Done():
		t.Fatal("worker ignored shutdown")
	}
}
