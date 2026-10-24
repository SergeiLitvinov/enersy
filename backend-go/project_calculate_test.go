package main

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func TestProjectCalculationPostgres(t *testing.T) {
	database := migrationTestDatabase(t)
	if err := runMigrationsFromSource(database, migrationSourceURL(t)); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	store := projectStore{database: database}
	sessions := sessionStore{database: database}
	var accounts [3]int64
	var tokens [3]issuedSession
	for i := range accounts {
		if err := database.QueryRowContext(ctx, `INSERT INTO auth_accounts(display_name) VALUES('Calculation fixture') RETURNING id`).Scan(&accounts[i]); err != nil {
			t.Fatal(err)
		}
		var err error
		tokens[i], err = sessions.Issue(ctx, accounts[i], time.Hour)
		if err != nil {
			t.Fatal(err)
		}
	}
	project, err := store.Create(ctx, tokens[0].Token, "Calculation")
	if err != nil {
		t.Fatal(err)
	}
	scheme, err := store.CreateScheme(ctx, tokens[0].Token, project, "Calculation", "")
	if err != nil {
		t.Fatal(err)
	}
	foreign, err := store.Create(ctx, tokens[2].Token, "Foreign")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := store.ChangeMember(ctx, tokens[0].Token, project, accounts[1], 0, "editor", false); err != nil {
		t.Fatal(err)
	}
	var typeID int
	if err := database.QueryRowContext(ctx, `SELECT id FROM component_types WHERE code='busbar'`).Scan(&typeID); err != nil {
		t.Fatal(err)
	}
	component, _, _, err := store.CreateComponent(ctx, tokens[0].Token, project, createComponentRequest{SchemeID: int(scheme), TypeID: typeID, Name: "Bus"})
	if err != nil {
		t.Fatal(err)
	}
	type workerRequest struct {
		body    []byte
		headers http.Header
		release chan struct{}
	}
	requests := make(chan workerRequest, 4)
	var count atomic.Int32
	const workerReply = `{"success":true,"value":9007199254740993,"voltage":1.0000000000000002}`
	worker := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		count.Add(1)
		body, err := io.ReadAll(r.Body)
		if err != nil {
			t.Error(err)
			return
		}
		release := make(chan struct{})
		requests <- workerRequest{body, r.Header.Clone(), release}
		select {
		case <-release:
		case <-r.Context().Done():
			return
		}
		w.WriteHeader(202)
		_, _ = io.WriteString(w, workerReply)
	}))
	defer worker.Close()
	auth := newAuthHTTP(database, "https://frontend.example", true)
	handler := projectsHTTP{auth: auth, workerURL: worker.URL}
	path := fmt.Sprintf("/api/projects/%d/schemes/%d/calculate?modelGroup=balanced&method=newton", project, scheme)
	request := func(token, path, tag, body string) *httptest.ResponseRecorder {
		r := httptest.NewRequest("POST", path, strings.NewReader(body)).WithContext(ctx)
		r.Header.Set("Origin", auth.origin)
		if token != "" {
			r.AddCookie(&http.Cookie{Name: auth.cookieName(), Value: token})
		}
		if tag != "" {
			r.Header.Set("If-Match", tag)
		}
		w := httptest.NewRecorder()
		handler.ServeHTTP(w, r)
		return w
	}
	for _, tc := range []struct {
		token, path, tag, body string
		status                 int
	}{
		{"", path, `"1"`, "", 401},
		{tokens[2].Token, path, `"1"`, "", 404},
		{tokens[0].Token, fmt.Sprintf("/api/projects/%d/schemes/%d/calculate?modelGroup=balanced&method=newton", foreign, scheme), `"1"`, "", 404},
		{tokens[0].Token, path, "", "", 428},
		{tokens[0].Token, path, `"0"`, "", 412},
		{tokens[0].Token, strings.Split(path, "?")[0], `"1"`, "", 400},
		{tokens[0].Token, path + "&method=other", `"1"`, "", 400},
		{tokens[0].Token, path, `"1"`, "{}", 400},
		{tokens[0].Token, path, `"1"`, `{"operatingLimits":[{"component_id":2147483647,"terminal":1,"min_kv":9,"max_kv":11}]}`, 400},
	} {
		if w := request(tc.token, tc.path, tc.tag, tc.body); w.Code != tc.status {
			t.Fatalf("status %d want %d: %s", w.Code, tc.status, w.Body.String())
		}
	}
	if count.Load() != 0 {
		t.Fatal("denied requests reached worker")
	}
	start := func(token string) <-chan *httptest.ResponseRecorder {
		result := make(chan *httptest.ResponseRecorder, 1)
		go func() { result <- request(token, path, `"1"`, "") }()
		return result
	}
	receive := func() workerRequest {
		select {
		case value := <-requests:
			return value
		case <-ctx.Done():
			t.Fatal("worker did not receive request")
			return workerRequest{}
		}
	}
	result := start(tokens[0].Token)
	first := receive()
	if first.headers.Get("Cookie") != "" || first.headers.Get("Authorization") != "" || strings.Contains(string(first.body), tokens[0].Token) {
		t.Fatal("worker received credentials")
	}
	var payload struct {
		Components []calculationComponent `json:"components"`
	}
	if err := json.Unmarshal(first.body, &payload); err != nil || len(payload.Components) != 1 || payload.Components[0].X != 0 {
		t.Fatal("invalid captured input")
	}
	// A writer must finish while the worker is blocked: no graph transaction is held.
	if _, err := database.ExecContext(ctx, `UPDATE scheme_components SET pos_x=123 WHERE id=$1`, component); err != nil {
		t.Fatal(err)
	}
	close(first.release)
	w := <-result
	digest := sha256.Sum256(first.body)
	if w.Code != 202 || w.Body.String() != workerReply || w.Header().Get("X-Enersy-Input-SHA256") != hex.EncodeToString(digest[:]) || w.Header().Get("X-Enersy-Topology-Revision") != "1" || w.Header().Get("Cache-Control") != "no-store" {
		t.Fatalf("snapshot response incorrect: %d %s %v", w.Code, w.Body.String(), w.Header())
	}
	result = start(tokens[0].Token)
	second := receive()
	if string(first.body) == string(second.body) {
		t.Fatal("next request did not capture edited graph")
	}
	close(second.release)
	if w := <-result; w.Code != 202 {
		t.Fatal("second calculation failed")
	}
	result = start(tokens[1].Token)
	third := receive()
	if _, err := store.ChangeMember(ctx, tokens[0].Token, project, accounts[1], 1, "", true); err != nil {
		t.Fatal(err)
	}
	close(third.release)
	if w := <-result; w.Code != 404 || strings.Contains(w.Body.String(), "9007199254740993") || w.Header().Get("X-Enersy-Input-SHA256") != "" {
		t.Fatal("removed member received private result")
	}
	if w := request(tokens[1].Token, path, `"1"`, ""); w.Code != 404 || count.Load() != 3 {
		t.Fatal("removed member invoked worker")
	}
}
