package main

import (
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestModelDefinitionsProxy(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/model-definitions" || r.Method != "GET" || r.URL.RawQuery != "" {
			t.Errorf("wrong upstream metadata request: %s", r.URL)
		}
		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte(`{"schema_version":1,"definitions":[]}`))
	}))
	defer server.Close()
	previous := juliaBaseURL
	juliaBaseURL = server.URL
	defer func() { juliaBaseURL = previous }()
	rec := httptest.NewRecorder()
	handleModelDefinitions(rec, httptest.NewRequest("GET", "/api/ees/model-definitions?project=private", nil))
	if rec.Code != 200 || rec.Body.String() != `{"schema_version":1,"definitions":[]}` {
		t.Fatalf("unexpected response: %d %s", rec.Code, rec.Body)
	}
	rejected := httptest.NewRecorder()
	handleModelDefinitions(rejected, httptest.NewRequest("POST", "/api/ees/model-definitions", nil))
	if rejected.Code != 405 {
		t.Fatalf("mutation must be rejected: %d", rejected.Code)
	}
}
