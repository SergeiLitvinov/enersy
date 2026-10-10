package main

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestProjectsHTTPPostgres(t *testing.T) {
	database := migrationTestDatabase(t)
	if err := runMigrationsFromSource(database, migrationSourceURL(t)); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	sessions := sessionStore{database: database}
	var accounts [3]int64
	var tokens [3]issuedSession
	for i := range accounts {
		if err := database.QueryRowContext(ctx, `INSERT INTO auth_accounts(display_name) VALUES('Project HTTP fixture') RETURNING id`).Scan(&accounts[i]); err != nil {
			t.Fatal(err)
		}
		token, err := sessions.Issue(ctx, accounts[i], time.Hour)
		if err != nil {
			t.Fatal(err)
		}
		tokens[i] = token
	}
	second, err := sessions.Issue(ctx, accounts[0], time.Hour)
	if err != nil {
		t.Fatal(err)
	}
	auth := newAuthHTTP(database, "https://frontend.example", true)
	handler := projectsHTTP{auth: auth}
	request := func(token, method, path, body, origin string) *httptest.ResponseRecorder {
		t.Helper()
		req := httptest.NewRequest(method, path, strings.NewReader(body)).WithContext(ctx)
		if token != "" {
			req.AddCookie(&http.Cookie{Name: auth.cookieName(), Value: token})
		}
		if origin != "" {
			req.Header.Set("Origin", origin)
		}
		if method == "POST" {
			req.Header.Set("Content-Type", "application/json")
		}
		rec := httptest.NewRecorder()
		handler.ServeHTTP(rec, req)
		if rec.Header().Get("Cache-Control") != "no-store" {
			t.Fatal("private project response can be cached")
		}
		return rec
	}
	create := func(token, name string) string {
		t.Helper()
		body, _ := json.Marshal(map[string]string{"name": name})
		rec := request(token, "POST", "/api/projects", string(body), auth.origin)
		var reply struct {
			ID string `json:"id"`
		}
		if rec.Code != 201 || json.Unmarshal(rec.Body.Bytes(), &reply) != nil || reply.ID == "" {
			t.Fatal("project creation failed")
		}
		return reply.ID
	}
	list := func(token, path string) projectPage {
		t.Helper()
		rec := request(token, "GET", path, "", "")
		var page projectPage
		if rec.Code != 200 || json.Unmarshal(rec.Body.Bytes(), &page) != nil || page.Items == nil {
			t.Fatal("project page invalid")
		}
		return page
	}
	first := create(tokens[0].Token, " One ")
	next := create(tokens[0].Token, "Two")
	foreign := create(tokens[1].Token, "Private foreign name")
	page := list(tokens[0].Token, "/api/projects")
	if len(page.Items) != 2 || page.Items[0].ID != first || page.Items[0].Name != "One" || page.Items[0].Role != "owner" || page.Items[1].ID != next {
		t.Fatal("owner project list incorrect")
	}
	if len(list(second.Token, "/api/projects").Items) != 2 {
		t.Fatal("second owner session lost its projects")
	}
	other := list(tokens[1].Token, "/api/projects")
	if len(other.Items) != 1 || other.Items[0].ID != foreign {
		t.Fatal("foreign projects leaked")
	}
	if len(list(tokens[2].Token, "/api/projects").Items) != 0 {
		t.Fatal("empty user sees projects")
	}
	limited := list(tokens[0].Token, "/api/projects?limit=1")
	if len(limited.Items) != 1 || limited.Items[0].ID != first || limited.NextAfterID != first {
		t.Fatal("project page cursor invalid")
	}
	tail := list(tokens[0].Token, "/api/projects?limit=1&afterId="+limited.NextAfterID)
	if len(tail.Items) != 1 || tail.Items[0].ID != next {
		t.Fatal("project cursor repeated or leaked a row")
	}
	if len(list(tokens[0].Token, "/api/projects?afterId="+foreign).Items) != 0 {
		t.Fatal("valid empty cursor page invalid")
	}
	if _, err := database.ExecContext(ctx, `INSERT INTO project_members(project_id,account_id,role) VALUES($1,$2,'viewer')`, first, accounts[1]); err != nil {
		t.Fatal(err)
	}
	shared := list(tokens[1].Token, "/api/projects")
	if len(shared.Items) != 2 || shared.Items[0].ID != first || shared.Items[0].Role != "viewer" {
		t.Fatal("allowed shared project missing")
	}
	if _, err := database.ExecContext(ctx, `DELETE FROM project_members WHERE project_id=$1 AND account_id=$2`, first, accounts[1]); err != nil {
		t.Fatal(err)
	}
	if len(list(tokens[1].Token, "/api/projects").Items) != 1 {
		t.Fatal("revoked membership still visible")
	}
	for _, test := range []struct {
		method, path, body, origin string
		want                       int
	}{
		{"GET", "/api/projects?limit=0", "", "", 400}, {"GET", "/api/projects?limit=101", "", "", 400},
		{"GET", "/api/projects?afterId=-1", "", "", 400}, {"GET", "/api/projects?afterId=9223372036854775808", "", "", 400},
		{"POST", "/api/projects", `{"name":"Fake","ownerId":"2"}`, auth.origin, 400},
		{"POST", "/api/projects", `{"name":"Fake"}`, "https://foreign.example", 403},
		{"POST", "/api/projects", `{"name":"Fake"}`, "", 403},
		{"POST", "/api/projects", `{"name":""}`, auth.origin, 400},
		{"POST", "/api/projects", `{"name":"` + strings.Repeat("x", 17000) + `"}`, auth.origin, 413},
	} {
		if rec := request(tokens[0].Token, test.method, test.path, test.body, test.origin); rec.Code != test.want {
			t.Fatalf("project boundary status=%d expected=%d", rec.Code, test.want)
		}
	}
	if rec := request("", "GET", "/api/projects", "", ""); rec.Code != 401 {
		t.Fatal("anonymous project list allowed")
	}
	if err := sessions.Revoke(ctx, second.Token, tokens[0].Identity.SessionID); err != nil {
		t.Fatal(err)
	}
	if rec := request(tokens[0].Token, "GET", "/api/projects", "", ""); rec.Code != 401 || strings.Contains(rec.Body.String(), "One") {
		t.Fatal("revoked session reads projects")
	}
	if rec := request(tokens[0].Token, "POST", "/api/projects", `{"name":"Denied"}`, auth.origin); rec.Code != 401 {
		t.Fatal("revoked session creates project")
	}
	if len(list(second.Token, "/api/projects").Items) != 2 {
		t.Fatal("independent session invalidated")
	}
	var owner int64
	if err := database.QueryRowContext(ctx, `SELECT owner_account_id FROM projects WHERE id=$1`, first).Scan(&owner); err != nil || owner != accounts[0] {
		t.Fatal("project owner was not taken from session")
	}
	canceled, stop := context.WithCancel(ctx)
	stop()
	if _, err := (projectStore{database: database}).List(canceled, second.Token, 0, 50); !errors.Is(err, context.Canceled) {
		t.Fatal("project list ignored cancellation")
	}
	if _, err := database.ExecContext(ctx, `UPDATE auth_accounts SET disabled_at=statement_timestamp() WHERE id=$1`, accounts[0]); err != nil {
		t.Fatal(err)
	}
	if rec := request(second.Token, "GET", "/api/projects", "", ""); rec.Code != 401 {
		t.Fatal("disabled owner reads projects")
	}
	if _, err := database.ExecContext(ctx, `INSERT INTO projects(id,owner_account_id,name) VALUES(9007199254740993,$1,'Large identifier')`, accounts[1]); err != nil {
		t.Fatal(err)
	}
	large := list(tokens[1].Token, "/api/projects?limit=1&afterId="+foreign)
	if len(large.Items) != 1 || large.Items[0].ID != "9007199254740993" || large.NextAfterID != "9007199254740993" {
		t.Fatal("project BIGINT cursor lost precision")
	}
}
