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

func TestStudyRunsHTTPPostgres(t *testing.T) {
	f := newStudyFixture(t)
	v, err := f.store.SaveStudy(context.Background(), f.tokens[0].Token, f.project, f.scheme, 0, 0, f.topology, studyCommand(2701), f.doc)
	if err != nil {
		t.Fatal(err)
	}
	auth := newAuthHTTP(f.store.database, "https://frontend.example", true)
	handler := projectsHTTP{auth: auth}
	path := fmt.Sprintf("/api/projects/%d/studies/%s/versions/1/runs", f.project, v.ID)
	request := func(actor int, method, target, key, body string, headers ...http.Header) *httptest.ResponseRecorder {
		t.Helper()
		r := httptest.NewRequest(method, target, strings.NewReader(body))
		r.Header.Set("Origin", auth.origin)
		r.Header.Set("Idempotency-Key", key)
		r.Header.Set("X-Enersy-Account-Id", strconv.FormatInt(f.tokens[actor].Identity.AccountID, 10))
		r.Header.Set("X-Enersy-Session-Id", strconv.FormatInt(f.tokens[actor].Identity.SessionID, 10))
		for _, h := range headers {
			for k, values := range h {
				r.Header[k] = values
			}
		}
		r.AddCookie(&http.Cookie{Name: auth.cookieName(), Value: f.tokens[actor].Token})
		w := httptest.NewRecorder()
		handler.ServeHTTP(w, r)
		return w
	}
	first := request(0, "POST", path, studyCommand(2702), "")
	preflight := request(0, "OPTIONS", path, "", "")
	if preflight.Code != 204 || !strings.Contains(preflight.Header().Get("Access-Control-Allow-Headers"), "X-Enersy-Account-Id") ||
		!strings.Contains(preflight.Header().Get("Access-Control-Allow-Headers"), "X-Enersy-Session-Id") ||
		!strings.Contains(preflight.Header().Get("Access-Control-Expose-Headers"), "Location") {
		t.Fatal("Run identity headers or acknowledgement inaccessible to the configured browser origin", preflight.Code, preflight.Header())
	}
	if first.Code != 202 || first.Header().Get("Location") == "" {
		t.Fatal(first.Code, first.Body.String())
	}
	var envelope struct {
		FormatVersion int      `json:"formatVersion"`
		RunID         string   `json:"runId"`
		Run           studyRun `json:"run"`
	}
	if err = json.Unmarshal(first.Body.Bytes(), &envelope); err != nil || envelope.FormatVersion != 1 || envelope.RunID != envelope.Run.ID || envelope.Run.InputSHA256 != v.InputSHA256 {
		t.Fatal(envelope, err)
	}
	location := first.Header().Get("Location")
	if retry := request(0, "POST", path, studyCommand(2702), ""); retry.Code != 202 || retry.Header().Get("Location") != location {
		t.Fatal("duplicate command", retry.Code, retry.Body.String())
	}
	if read := request(2, "GET", location, "", ""); read.Code != 200 || read.Header().Get("Cache-Control") != "no-store" {
		t.Fatal("viewer read", read.Code, read.Body.String())
	}
	if read := request(3, "GET", location, "", ""); read.Code != 404 {
		t.Fatal("outsider read", read.Code)
	}
	if denied := request(2, "POST", path, studyCommand(2702), ""); denied.Code != 404 {
		t.Fatal("viewer replay", denied.Code)
	}
	changed := strings.Replace(path, "/versions/1/", "/versions/2/", 1)
	if conflict := request(0, "POST", changed, studyCommand(2702), ""); conflict.Code != 409 {
		t.Fatal("retargeted command", conflict.Code)
	}
	for _, tc := range []struct {
		method, path, key, body string
		status                  int
		headers                 http.Header
	}{
		{"POST", path, "", "", 400, nil},
		{"POST", path, studyCommand(2703), "{}", 400, nil},
		{"POST", path + "?method=direct", studyCommand(2703), "", 400, nil},
		{"PUT", path, "", "", 405, nil},
		{"POST", location, studyCommand(2703), "", 405, nil},
		{"POST", path, studyCommand(2703), "", 400, http.Header{"X-Enersy-Session-Id": {}}},
		{"POST", path, studyCommand(2703), "", 409, http.Header{"X-Enersy-Session-Id": {strconv.FormatInt(f.tokens[1].Identity.SessionID, 10)}}},
		{"POST", path, studyCommand(2703), "", 403, http.Header{"Origin": {"https://untrusted.example"}}},
	} {
		w := request(0, tc.method, tc.path, tc.key, tc.body, tc.headers)
		if w.Code != tc.status {
			t.Fatalf("%s %s got %d: %s", tc.method, tc.path, w.Code, w.Body.String())
		}
	}
	var count int
	if err = f.store.database.QueryRow(`SELECT count(*) FROM project_study_runs`).Scan(&count); err != nil || count != 1 {
		t.Fatal("rejected request created a Run", count, err)
	}
	second := request(0, "POST", path, studyCommand(2704), "")
	if second.Code != 202 {
		t.Fatal(second.Code, second.Body.String())
	}
	var accepted struct {
		RunID string `json:"runId"`
	}
	if err = json.Unmarshal(second.Body.Bytes(), &accepted); err != nil {
		t.Fatal(err)
	}
	page := request(2, "GET", path+"?limit=1", "", "")
	var history studyRunPage
	if err = json.Unmarshal(page.Body.Bytes(), &history); page.Code != 200 || err != nil || len(history.Items) != 1 || history.Items[0].ID != accepted.RunID || history.NextBeforeID != accepted.RunID {
		t.Fatal("history page", page.Code, page.Body.String(), err)
	}
	older := request(2, "GET", path+"?limit=1&beforeId="+history.NextBeforeID, "", "")
	if err = json.Unmarshal(older.Body.Bytes(), &history); older.Code != 200 || err != nil || len(history.Items) != 1 || history.Items[0].ID != envelope.RunID {
		t.Fatal("history cursor", older.Code, older.Body.String(), err)
	}
	if denied := request(3, "GET", path, "", ""); denied.Code != 404 {
		t.Fatal("foreign history", denied.Code)
	}
	for _, query := range []string{"?method=direct", "?limit=0", "?limit=51", "?beforeId=0", "?beforeId=1&beforeId=2"} {
		if invalid := request(0, "GET", path+query, "", ""); invalid.Code != 400 {
			t.Fatal("invalid page", query, invalid.Code)
		}
	}
	if missing := request(0, "GET", changed, "", ""); missing.Code != 404 {
		t.Fatal("missing version history", missing.Code)
	}
}
