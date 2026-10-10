package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"
)

func TestProjectMembersHTTPPostgres(t *testing.T) {
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
		if err := database.QueryRowContext(ctx, `INSERT INTO auth_accounts(display_name) VALUES('Member fixture') RETURNING id`).Scan(&accounts[i]); err != nil {
			t.Fatal(err)
		}
		var err error
		tokens[i], err = sessions.Issue(ctx, accounts[i], time.Hour)
		if err != nil {
			t.Fatal(err)
		}
	}
	project, err := store.Create(ctx, tokens[0].Token, "Membership fixture")
	if err != nil {
		t.Fatal(err)
	}
	auth := newAuthHTTP(database, "https://frontend.example", true)
	handler := projectsHTTP{auth: auth}
	base := fmt.Sprintf("/api/projects/%d/members", project)
	request := func(token, method, path, body, revision, origin string) *httptest.ResponseRecorder {
		t.Helper()
		req := httptest.NewRequest(method, path, strings.NewReader(body)).WithContext(ctx)
		if token != "" {
			req.AddCookie(&http.Cookie{Name: auth.cookieName(), Value: token})
		}
		if origin != "" {
			req.Header.Set("Origin", origin)
		}
		if revision != "" {
			req.Header.Set("If-Match", revision)
		}
		req.Header.Set("Content-Type", "application/json")
		rec := httptest.NewRecorder()
		handler.ServeHTTP(rec, req)
		if rec.Header().Get("Cache-Control") != "no-store" {
			t.Fatal("roster response cacheable")
		}
		return rec
	}
	list := func(token string) memberPage {
		t.Helper()
		rec := request(token, "GET", base, "", "", "")
		var page memberPage
		if rec.Code != 200 || json.Unmarshal(rec.Body.Bytes(), &page) != nil || page.Items == nil {
			t.Fatal("invalid roster")
		}
		return page
	}
	page := list(tokens[0].Token)
	if page.OwnerAccountID != strconv.FormatInt(accounts[0], 10) || page.Revision != "0" || len(page.Items) != 0 {
		t.Fatal("initial roster")
	}
	preflight := request(tokens[0].Token, "OPTIONS", base, "", "", auth.origin)
	if preflight.Code != 204 || !strings.Contains(preflight.Header().Get("Access-Control-Allow-Headers"), "If-Match") || !strings.Contains(preflight.Header().Get("Access-Control-Allow-Methods"), "DELETE") {
		t.Fatal("membership CORS preflight prevents browser commands")
	}
	target := fmt.Sprintf("%s/%d", base, accounts[1])
	for _, tc := range []struct {
		token, method, path, body, revision, origin string
		status                                      int
	}{
		{tokens[1].Token, "GET", base, "", "", "", 404},
		{"", "GET", base, "", "", "", 401},
		{tokens[0].Token, "PUT", target, `{"role":"viewer"}`, "", auth.origin, 428},
		{tokens[0].Token, "PUT", target, `{"role":"viewer"}`, `W/"0"`, auth.origin, 400},
		{tokens[0].Token, "PUT", target, `{"role":"viewer"}`, `"0"`, "http://foreign.example", 403},
		{tokens[0].Token, "PUT", target, `{"role":"owner"}`, `"0"`, auth.origin, 400},
		{tokens[0].Token, "PUT", target, `{"role":"viewer","ownerId":"1"}`, `"0"`, auth.origin, 400},
		{tokens[0].Token, "PUT", fmt.Sprintf("%s/%d", base, accounts[0]), `{"role":"viewer"}`, `"0"`, auth.origin, 404},
		{tokens[0].Token, "PUT", target, `{"role":"viewer"}`, `"0"`, auth.origin, 200},
		{tokens[0].Token, "PUT", target, `{"role":"admin"}`, `"0"`, auth.origin, 409},
		{tokens[1].Token, "GET", base, "", "", "", 404},
		{tokens[1].Token, "DELETE", target, "", `"1"`, auth.origin, 404},
		{tokens[0].Token, "PUT", target, `{"role":"admin"}`, `"1"`, auth.origin, 200},
	} {
		if rec := request(tc.token, tc.method, tc.path, tc.body, tc.revision, tc.origin); rec.Code != tc.status {
			t.Fatalf("%s %s: %d want %d", tc.method, tc.path, rec.Code, tc.status)
		}
	}
	page = list(tokens[1].Token)
	if page.Revision != "2" || len(page.Items) != 1 || page.Items[0].Role != "admin" {
		t.Fatal("admin roster")
	}
	// Exactly one concurrent command with the same expected revision can commit.
	var wg sync.WaitGroup
	results := make(chan error, 2)
	start := make(chan struct{})
	for _, role := range []string{"viewer", "editor"} {
		wg.Add(1)
		go func(role string) {
			defer wg.Done()
			<-start
			_, err := store.ChangeMember(ctx, tokens[0].Token, project, accounts[2], 2, role, false)
			results <- err
		}(role)
	}
	close(start)
	wg.Wait()
	close(results)
	success, conflicts := 0, 0
	for err := range results {
		if err == nil {
			success++
		} else if errors.Is(err, errMembershipConflict) {
			conflicts++
		} else {
			t.Fatal(err)
		}
	}
	if success != 1 || conflicts != 1 {
		t.Fatal("concurrent membership overwrote intent")
	}
	firstPage := request(tokens[0].Token, "GET", base+"?limit=1", "", "", "")
	var paged memberPage
	if firstPage.Code != 200 || json.Unmarshal(firstPage.Body.Bytes(), &paged) != nil || len(paged.Items) != 1 || paged.NextAfterID != strconv.FormatInt(accounts[1], 10) || paged.Revision != "3" {
		t.Fatal("membership first page incorrect")
	}
	nextPage := request(tokens[0].Token, "GET", base+"?limit=1&afterId="+paged.NextAfterID, "", "", "")
	if nextPage.Code != 200 || json.Unmarshal(nextPage.Body.Bytes(), &paged) != nil || len(paged.Items) != 1 || paged.Items[0].AccountID != strconv.FormatInt(accounts[2], 10) || paged.Revision != "3" {
		t.Fatal("membership cursor repeated a row")
	}
	canceled, stop := context.WithCancel(ctx)
	stop()
	if _, err := store.ChangeMember(canceled, tokens[0].Token, project, accounts[2], 3, "admin", false); !errors.Is(err, context.Canceled) {
		t.Fatal("canceled membership command committed")
	}
	// A command waiting on the project lock must observe an admin revocation.
	tx, err := database.BeginTx(ctx, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback()
	var blocker int
	if err := tx.QueryRowContext(ctx, `SELECT pg_backend_pid() FROM projects WHERE id=$1 FOR UPDATE`, project).Scan(&blocker); err != nil {
		t.Fatal(err)
	}
	waiting := make(chan error, 1)
	go func() {
		_, err := store.ChangeMember(ctx, tokens[1].Token, project, accounts[2], 4, "admin", false)
		waiting <- err
	}()
	deadline := time.Now().Add(4 * time.Second)
	blocked := false
	for time.Now().Before(deadline) {
		if err := database.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid)))`, blocker).Scan(&blocked); err != nil {
			t.Fatal(err)
		}
		if blocked {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	if !blocked {
		t.Fatal("membership command did not wait on project lock")
	}
	if _, err := tx.ExecContext(ctx, `DELETE FROM project_members WHERE project_id=$1 AND account_id=$2`, project, accounts[1]); err != nil {
		t.Fatal(err)
	}
	if _, err := tx.ExecContext(ctx, `UPDATE projects SET membership_revision=membership_revision+1 WHERE id=$1`, project); err != nil {
		t.Fatal(err)
	}
	if err := tx.Commit(); err != nil {
		t.Fatal(err)
	}
	if err := <-waiting; !errors.Is(err, errProjectUnavailable) {
		t.Fatalf("removed admin command: %v", err)
	}
	if _, err := store.Access(ctx, tokens[1].Token, projectScope, project, projectRead); !errors.Is(err, errProjectUnavailable) {
		t.Fatal("removed member retains access")
	}
	page = list(tokens[0].Token)
	if page.Revision != "4" || len(page.Items) != 1 || page.Items[0].Role == "admin" {
		t.Fatal("unauthorized delayed mutation committed")
	}
	if rec := request(tokens[0].Token, "DELETE", fmt.Sprintf("%s/%d", base, accounts[2]), "", `"4"`, auth.origin); rec.Code != 200 {
		t.Fatal("owner removal failed")
	}
	if len(list(tokens[0].Token).Items) != 0 {
		t.Fatal("removed member remains in roster")
	}
	if err := sessions.RevokeAll(ctx, tokens[0].Token); err != nil {
		t.Fatal(err)
	}
	if rec := request(tokens[0].Token, "GET", base, "", "", ""); rec.Code != 404 {
		t.Fatal("revoked session reads roster")
	}
}
