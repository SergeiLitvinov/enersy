package main

import (
	"bytes"
	"context"
	"crypto/rand"
	"database/sql"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"time"
)

func studyExecutorID() (string, error) {
	var value [16]byte
	if _, err := rand.Read(value[:]); err != nil {
		return "", err
	}
	return fmt.Sprintf("%x-%x-%x-%x-%x", value[:4], value[4:6], value[6:8], value[8:10], value[10:]), nil
}

func runStudyDispatcher(ctx context.Context, store projectStore, workerURL string) error {
	executor, err := studyExecutorID()
	if err != nil {
		return err
	}
	for ctx.Err() == nil {
		claimCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
		claim, err := store.ClaimStudyRun(claimCtx, executor)
		cancel()
		if err == nil {
			executeStudyRun(ctx, store, workerURL, claim)
			continue
		}
		if !errors.Is(err, sql.ErrNoRows) && ctx.Err() == nil {
			slog.Error("study queue claim failed", "error", err)
		}
		timer := time.NewTimer(time.Second)
		select {
		case <-ctx.Done():
			if !timer.Stop() {
				<-timer.C
			}
		case <-timer.C:
		}
	}
	return nil
}

// The request context belongs to this Docker worker, not to a browser session.
// Heartbeat loss cancels transport; fencing also rejects any late publication.
func executeStudyRun(parent context.Context, store projectStore, workerURL string, claim studyRunClaim) {
	ctx, cancel := context.WithTimeout(parent, 45*time.Second)
	defer cancel()
	done := make(chan struct{})
	go func() {
		defer close(done)
		ticker := time.NewTicker(runLeaseDuration / 6)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				renewCtx, stop := context.WithTimeout(ctx, 3*time.Second)
				err := store.RenewStudyRun(renewCtx, claim)
				stop()
				if err != nil {
					cancel()
					return
				}
			}
		}
	}()
	defer func() { cancel(); <-done }()
	code := dispatchStudyRun(ctx, store, workerURL, claim)
	if code != "" && parent.Err() == nil {
		// A lost/expired lease cannot turn an old attempt into a terminal result.
		failCtx, stop := context.WithTimeout(parent, 5*time.Second)
		defer stop()
		if err := store.FailStudyRun(failCtx, claim, code); err != nil && !errors.Is(err, errRunLeaseLost) {
			slog.Error("study queue failure publication failed", "run_id", claim.ID, "error", err)
		}
	}
}

func dispatchStudyRun(ctx context.Context, store projectStore, workerURL string, claim studyRunClaim) string {
	if len(claim.Input) == 0 || len(claim.Input) > computeBodyLimit || validateStudyDocument(claim.Document) != nil {
		return "invalid_snapshot"
	}
	if err := store.AdvanceStudyRun(ctx, claim, "initializing"); err != nil {
		return "worker_transport"
	}
	client := &http.Client{Timeout: 25 * time.Second, CheckRedirect: func(_ *http.Request, _ []*http.Request) error {
		return http.ErrUseLastResponse
	}}
	readyCtx, stop := context.WithTimeout(ctx, 3*time.Second)
	// #nosec G704 -- operator-configured URL and a fixed readiness endpoint.
	req, err := http.NewRequestWithContext(readyCtx, http.MethodGet, workerURL+"/ready", nil)
	if err != nil {
		stop()
		return "worker_unavailable"
	}
	// #nosec G704 -- only the configured worker endpoint; redirects are disabled.
	ready, err := client.Do(req)
	if err != nil {
		stop()
		return "worker_unavailable"
	}
	ready.Body.Close()
	stop()
	if ready.StatusCode != http.StatusOK {
		return "worker_unavailable"
	}
	if err := store.AdvanceStudyRun(ctx, claim, "running"); err != nil {
		return "worker_transport"
	}
	// #nosec G704 -- operator-configured URL and fixed path, never user input.
	req, err = http.NewRequestWithContext(ctx, http.MethodPost, workerURL+"/calculate", bytes.NewReader(claim.Input))
	if err != nil {
		return "worker_transport"
	}
	req.Header.Set("Content-Type", "application/json")
	// #nosec G704 -- fixed configured endpoint; cookies/credentials are not sent.
	response, err := client.Do(req)
	if err != nil {
		return "worker_transport"
	}
	defer response.Body.Close()
	body, err := io.ReadAll(io.LimitReader(response.Body, computeBodyLimit+1))
	if err != nil || len(body) > computeBodyLimit {
		return "worker_transport"
	}
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return "worker_rejected"
	}
	if _, err := store.CompleteStudyRun(ctx, claim, body); err != nil {
		if errors.Is(err, errArchiveQuota) {
			return "archive_quota"
		}
		if errors.Is(err, errArchiveResult) {
			return "invalid_result"
		}
		if !errors.Is(err, errRunLeaseLost) {
			slog.Error("study queue archive publication failed", "run_id", claim.ID, "error", err)
		}
		return "worker_transport"
	}
	return ""
}

// Health endpoints are internal to the worker container. No control or user API
// is exposed here; /ready verifies the configured database/migration contract.
func serveStudyWorker(ctx context.Context, store projectStore, workerURL, port string) error {
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	mux := http.NewServeMux()
	mux.HandleFunc("/health", handleHealth)
	mux.HandleFunc("/ready", handleReady)
	server := &http.Server{Addr: ":" + port, Handler: mux, ReadHeaderTimeout: 5 * time.Second}
	finished := make(chan error, 2)
	go func() { finished <- server.ListenAndServe() }()
	go func() { finished <- runStudyDispatcher(ctx, store, workerURL) }()
	var err error
	received := 0
	select {
	case <-ctx.Done():
	case err = <-finished:
		received++
	}
	cancel()
	stopCtx, stop := context.WithTimeout(context.Background(), 5*time.Second)
	defer stop()
	if shutdownErr := server.Shutdown(stopCtx); shutdownErr != nil && err == nil {
		err = shutdownErr
	}
	for received < 2 {
		select {
		case childErr := <-finished:
			received++
			if err == nil && childErr != nil && !errors.Is(childErr, http.ErrServerClosed) {
				err = childErr
			}
		case <-stopCtx.Done():
			return stopCtx.Err()
		}
	}
	return err
}
