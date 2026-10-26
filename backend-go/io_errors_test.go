package main

import (
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

type failingResponseWriter struct {
	headers  http.Header
	writes   int
	statuses int
	err      error
}

func (w *failingResponseWriter) Header() http.Header { return w.headers }
func (w *failingResponseWriter) WriteHeader(_ int)   { w.statuses++ }
func (w *failingResponseWriter) Write(body []byte) (int, error) {
	w.writes++
	return len(body) / 2, w.err
}

func TestResponseDeliveryFailureDoesNotRetryOrReplaceCommittedStatus(t *testing.T) {
	for _, deliveryError := range []error{nil, errors.New("closed response stream")} {
		for _, jsonBody := range []bool{false, true} {
			w := &failingResponseWriter{headers: http.Header{}, err: deliveryError}
			if jsonBody {
				w.WriteHeader(http.StatusCreated)
				writeJSON(w, map[string]string{"id": "1"})
			} else {
				writeJSONBody(w, http.StatusCreated, []byte(`{"id":"1"}`))
			}
			if w.writes != 1 || w.statuses != 1 {
				t.Fatalf("partial delivery retried or status replaced: writes=%d statuses=%d", w.writes, w.statuses)
			}
		}
	}
}

func TestRawJSONPreservesArchiveBytesWithoutBecomingHTML(t *testing.T) {
	body := []byte(" \n" + `{"label":"</script><svg onload='alert(1)'>","value":1.2345678901234567}` + "\n")
	w := httptest.NewRecorder()
	writeJSONBody(w, http.StatusAccepted, body)
	if w.Code != http.StatusAccepted || w.Body.String() != string(body) || w.Header().Get("Content-Type") != "application/json" || w.Header().Get("X-Content-Type-Options") != "nosniff" {
		t.Fatal("raw JSON bytes, status or MIME protection changed")
	}
	w = httptest.NewRecorder()
	writeJSONBody(w, http.StatusOK, []byte(`<html>invalid archived response</html>`))
	if w.Code != 500 || strings.Contains(w.Body.String(), "<html>") || !strings.Contains(w.Body.String(), "Response integrity failure") {
		t.Fatal("invalid JSON was exposed as a successful raw response")
	}
}
