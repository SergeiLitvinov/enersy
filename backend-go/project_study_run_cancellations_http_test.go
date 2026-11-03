package main

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"
)

func TestQueuedRunCancellationHTTPPostgres(t *testing.T) {
	f, v, run := admittedRunFixture(t)
	auth := newAuthHTTP(f.store.database, "https://frontend.example", true)
	handler := projectsHTTP{auth: auth}
	path := fmt.Sprintf("/api/projects/%d/runs/%s/cancel", f.project, run.ID)
	request := func(actor int, method, target, key, body string, headers http.Header) *httptest.ResponseRecorder {
		t.Helper()
		r := httptest.NewRequest(method, target, strings.NewReader(body))
		r.Header.Set("Origin", auth.origin)
		r.Header.Set("Idempotency-Key", key)
		if actor >= 0 {
			r.AddCookie(&http.Cookie{Name: auth.cookieName(), Value: f.tokens[actor].Token})
			r.Header.Set("X-Enersy-Account-Id", strconv.FormatInt(f.tokens[actor].Identity.AccountID, 10))
			r.Header.Set("X-Enersy-Session-Id", strconv.FormatInt(f.tokens[actor].Identity.SessionID, 10))
		}
		for k, values := range headers {
			r.Header[k] = values
		}
		w := httptest.NewRecorder()
		handler.ServeHTTP(w, r)
		return w
	}
	command := studyCommand(8101)
	for _, tc := range []struct {
		method, path, key, body string
		headers                 http.Header
		want                    int
	}{
		{"GET", path, command, "", nil, 405}, {"POST", path + "?force=true", command, "", nil, 400},
		{"POST", path, "bad", "", nil, 400}, {"POST", path, command, "{}", nil, 400},
		{"POST", path, command, "", http.Header{"X-Enersy-Account-Id": []string{"9999"}}, 409},
		{"POST", path, command, "", http.Header{"X-Enersy-Session-Id": []string{"9999"}}, 409},
		{"POST", path, command, "", http.Header{"X-Enersy-Session-Id": []string{"1", "2"}}, 400},
		{"POST", path, command, "", http.Header{"Origin": []string{"https://other.example"}}, 403},
	} {
		if w := request(0, tc.method, tc.path, tc.key, tc.body, tc.headers); w.Code != tc.want {
			t.Fatal(tc, w.Code, w.Body.String())
		}
	}
	if w := request(-1, "POST", path, command, "", nil); w.Code != 401 {
		t.Fatal(w.Code, w.Body.String())
	}
	first := request(0, "POST", path, command, "", nil)
	if first.Code != 200 || first.Header().Get("Cache-Control") != "no-store" {
		t.Fatal(first.Code, first.Body.String())
	}
	var ack struct {
		Format  int      `json:"formatVersion"`
		Command string   `json:"commandId"`
		ID      string   `json:"runId"`
		Run     studyRun `json:"run"`
	}
	if err := json.Unmarshal(first.Body.Bytes(), &ack); err != nil || ack.Format != 1 || ack.Command != command || ack.ID != run.ID || ack.Run.Status != "cancelled" || ack.Run.ArchiveID != "" || ack.Run.InputSHA256 != v.InputSHA256 {
		t.Fatal(ack, err)
	}
	if replay := request(0, "POST", path, command, "", nil); replay.Code != 200 || replay.Body.String() != first.Body.String() {
		t.Fatal("replay changed", replay.Code, replay.Body.String())
	}
	for _, actor := range []int{2, 3} {
		if w := request(actor, "POST", path, command, "", nil); w.Code != 404 {
			t.Fatal("unauthorized cancellation replay", actor, w.Code, w.Body.String())
		}
	}
	if w := request(1, "POST", path, studyCommand(8102), "", nil); w.Code != 200 {
		t.Fatal("editor cancellation", w.Code, w.Body.String())
	}
	study, _ := strconv.ParseInt(v.ID, 10, 64)
	next, err := f.store.EnqueueStudyRun(context.Background(), f.tokens[0].Token, f.project, study, 1, studyCommand(8103))
	if err != nil {
		t.Fatal(err)
	}
	nextPath := fmt.Sprintf("/api/projects/%d/runs/%s/cancel", f.project, next.ID)
	if w := request(0, "POST", nextPath, command, "", nil); w.Code != 409 || !strings.Contains(w.Body.String(), "run_cancel_command_conflict") {
		t.Fatal(w.Code, w.Body.String())
	}
	_ = runClaim(t, f, 8104)
	if w := request(0, "POST", nextPath, studyCommand(8105), "", nil); w.Code != 409 || !strings.Contains(w.Body.String(), "run_already_claimed") {
		t.Fatal(w.Code, w.Body.String())
	}
}
