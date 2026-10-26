package main

import (
	"database/sql"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
)

// The response may already be committed. Report delivery failures without
// retrying, appending another JSON document, or logging the response payload.
func writeJSON(w http.ResponseWriter, value any) {
	if err := json.NewEncoder(w).Encode(value); err != nil {
		slog.Warn("HTTP JSON response write failed", "error", err)
	}
}

func writeJSONBody(w http.ResponseWriter, status int, body []byte) {
	if !json.Valid(body) {
		slog.Error("Invalid JSON response body")
		sendError(w, "Response integrity failure", http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.WriteHeader(status)
	// #nosec G705 -- Validated JSON is served as application/json with nosniff.
	// Preserve archived bytes and their SHA-256; this is never an HTML response.
	written, err := w.Write(body)
	if err == nil && written != len(body) {
		err = io.ErrShortWrite
	}
	if err != nil {
		slog.Warn("HTTP response write failed", "bytesWritten", written, "error", err)
	}
}

// Deferred rollback is also called after a successful commit. ErrTxDone is
// expected then; any other failure remains visible without hiding the caller's
// original error or attempting to commit a failed operation.
func rollbackTx(tx *sql.Tx) {
	if err := tx.Rollback(); err != nil && !errors.Is(err, sql.ErrTxDone) {
		slog.Warn("Database transaction rollback failed", "error", err)
	}
}
