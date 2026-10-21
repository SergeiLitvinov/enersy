package main

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"
	"time"
)

func TestCalculationArchivesPostgres(t *testing.T) {
	database := migrationTestDatabase(t)
	if err := runMigrationsFromSource(database, migrationSourceURL(t)); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 45*time.Second)
	defer cancel()
	store := projectStore{database: database}
	sessions := sessionStore{database: database}
	var accounts [4]int64
	var tokens [4]issuedSession
	for i := range accounts {
		if err := database.QueryRowContext(ctx, `INSERT INTO auth_accounts(display_name) VALUES('Archive fixture') RETURNING id`).Scan(&accounts[i]); err != nil {
			t.Fatal(err)
		}
		var err error
		tokens[i], err = sessions.Issue(ctx, accounts[i], time.Hour)
		if err != nil {
			t.Fatal(err)
		}
	}
	second, err := sessions.Issue(ctx, accounts[0], time.Hour)
	if err != nil {
		t.Fatal(err)
	}
	project, err := store.Create(ctx, tokens[0].Token, "Archived network")
	if err != nil {
		t.Fatal(err)
	}
	scheme, err := store.CreateScheme(ctx, tokens[0].Token, project, "Original name", "")
	if err != nil {
		t.Fatal(err)
	}
	foreign, err := store.Create(ctx, tokens[2].Token, "Other project")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := store.ChangeMember(ctx, tokens[0].Token, project, accounts[1], 0, "editor", false); err != nil {
		t.Fatal(err)
	}
	if _, err := store.ChangeMember(ctx, tokens[0].Token, project, accounts[3], 1, "viewer", false); err != nil {
		t.Fatal(err)
	}
	// Numeric formatting intentionally includes insignificant trailing digits and
	// an exponent. This is a transport fixture, not a physical reference case.
	result := []byte("{\n\"success\":true,\"node_count\":1,\"nodes\":[{\"node_id\":1,\"voltage\":1.234567890123456700e+1}],\"method_used\":\"three-phase/newton-raphson\",\"version\":\"fixture\"\n}")
	status := 200
	response := result
	var posted []byte
	calls := 0
	var hook func()
	worker := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls++
		posted, _ = io.ReadAll(r.Body)
		if r.Header.Get("Cookie") != "" || r.Header.Get("Authorization") != "" {
			t.Error("worker received session credentials")
		}
		if hook != nil {
			hook()
		}
		w.WriteHeader(status)
		w.Write(response)
	}))
	defer worker.Close()
	auth := newAuthHTTP(database, "http://localhost:4174", false)
	handler := projectsHTTP{auth: auth, workerURL: worker.URL}
	path := fmt.Sprintf("/api/projects/%d/schemes/%d/archive-calculation?modelGroup=three-phase&method=newton-raphson", project, scheme)
	request := func(method, path, token, tag string) *httptest.ResponseRecorder {
		r := httptest.NewRequest(method, path, nil)
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
		token, tag string
		status     int
	}{{"", `"0"`, 401}, {tokens[2].Token, `"0"`, 404}, {tokens[3].Token, `"0"`, 404}, {tokens[0].Token, "", 428}, {tokens[0].Token, `"1"`, 412}} {
		if w := request("POST", path, tc.token, tc.tag); w.Code != tc.status {
			t.Fatalf("denied %d want %d: %s", w.Code, tc.status, w.Body.String())
		}
	}
	if calls != 0 {
		t.Fatal("denied calculation reached worker")
	}
	success := request("POST", path, tokens[1].Token, `"0"`)
	if success.Code != 200 || success.Header().Get("X-Enersy-Archive-Id") == "" || !bytes.Equal(success.Body.Bytes(), result) {
		t.Fatalf("archive: %d %s", success.Code, success.Body.String())
	}
	id := success.Header().Get("X-Enersy-Archive-Id")
	originalInput := append([]byte(nil), posted...)
	base := fmt.Sprintf("/api/projects/%d/calculation-archives", project)
	detail := base + "/" + id
	for _, token := range []string{tokens[0].Token, second.Token, tokens[1].Token, tokens[3].Token} {
		w := request("GET", detail+"/result", token, "")
		if w.Code != 200 || !bytes.Equal(w.Body.Bytes(), result) || w.Header().Get("ETag") != `"`+archiveDigest(result)+`"` || w.Header().Get("Cache-Control") != "no-store" {
			t.Fatalf("exact replay: %d %s", w.Code, w.Body.String())
		}
	}
	w := request("GET", detail+"/input", tokens[0].Token, "")
	if w.Code != 200 || !bytes.Equal(w.Body.Bytes(), originalInput) || success.Header().Get("X-Enersy-Input-SHA256") != archiveDigest(originalInput) {
		t.Fatal("snapshot did not preserve worker request")
	}
	var metadata calculationArchive
	w = request("GET", detail, tokens[0].Token, "")
	if w.Code != 200 || json.Unmarshal(w.Body.Bytes(), &metadata) != nil || metadata.SchemeName != "Original name" || metadata.AuthorAccountID != strconv.FormatInt(accounts[1], 10) {
		t.Fatalf("metadata %s", w.Body.String())
	}
	for _, p := range []string{detail, detail + "/input", detail + "/result", base} {
		if w := request("GET", p, tokens[2].Token, ""); w.Code != 404 {
			t.Fatal("foreign account read archive", w.Code)
		}
	}
	if w := request("GET", fmt.Sprintf("/api/projects/%d/calculation-archives/%s/result", foreign, id), tokens[2].Token, ""); w.Code != 404 {
		t.Fatal("foreign project disclosed archive")
	}
	if _, err := database.ExecContext(ctx, `UPDATE project_calculation_archives SET scheme_name='changed' WHERE id=$1`, id); err == nil {
		t.Fatal("archive can be overwritten")
	}
	if _, err := database.ExecContext(ctx, `UPDATE circuit_schemes SET name='Changed later',topology_revision=topology_revision+1 WHERE id=$1`, scheme); err != nil {
		t.Fatal(err)
	}
	if w := request("GET", detail+"/result", second.Token, ""); !bytes.Equal(w.Body.Bytes(), result) {
		t.Fatal("live scheme edit changed historical result")
	}
	// A second save exercises keyset paging without returning large payloads.
	if w := request("POST", path, tokens[0].Token, `"1"`); w.Code != 200 {
		t.Fatal(w.Code, w.Body.String())
	}
	var page calculationArchivePage
	w = request("GET", base+"?limit=1", tokens[3].Token, "")
	if w.Code != 200 || json.Unmarshal(w.Body.Bytes(), &page) != nil || len(page.Items) != 1 || page.NextBeforeID == "" || strings.Contains(w.Body.String(), "nodes") {
		t.Fatal("invalid bounded page", w.Body.String())
	}
	w = request("GET", base+"?limit=1&beforeId="+page.NextBeforeID, tokens[3].Token, "")
	page = calculationArchivePage{}
	if json.Unmarshal(w.Body.Bytes(), &page) != nil || len(page.Items) != 1 || page.Items[0].ID != id || page.NextBeforeID != "" {
		t.Fatal("invalid next page", w.Body.String())
	}
	for _, query := range []string{"?limit=0", "?limit=101", "?beforeId=-1", "?limit=1&limit=2", "?unknown=1"} {
		if w := request("GET", base+query, tokens[0].Token, ""); w.Code != 400 {
			t.Fatal("invalid page accepted", query)
		}
	}
	count := func() int {
		var n int
		if err := database.QueryRowContext(ctx, `SELECT count(*) FROM project_calculation_archives WHERE project_id=$1`, project).Scan(&n); err != nil {
			t.Fatal(err)
		}
		return n
	}
	previous := count()
	status = 422
	response = []byte(`{"success":false,"error":"unsupported fixture"}`)
	if w := request("POST", path, tokens[0].Token, `"1"`); w.Code != 422 {
		t.Fatal("worker error status lost", w.Code)
	}
	status = 200
	response = []byte(`{"success":true}`)
	if w := request("POST", path, tokens[0].Token, `"1"`); w.Code != 502 {
		t.Fatal("incomplete result archived", w.Code)
	}
	response = result
	// Revoke an editor while the worker is computing: no output or archive may
	// be exposed after membership removal. Same for a revoked session.
	hook = func() {
		if _, err := store.ChangeMember(ctx, tokens[0].Token, project, accounts[1], 2, "", true); err != nil {
			t.Fatal(err)
		}
	}
	if w := request("POST", path, tokens[1].Token, `"1"`); w.Code != 404 {
		t.Fatal("revoked member received result", w.Code)
	}
	hook = func() {
		if err := sessions.Revoke(ctx, tokens[0].Token, second.Identity.SessionID); err != nil {
			t.Fatal(err)
		}
	}
	if w := request("POST", path, second.Token, `"1"`); w.Code != 404 {
		t.Fatal("revoked session received result", w.Code)
	}
	hook = nil
	if count() != previous {
		t.Fatal("failed or unauthorized calculation left an archive")
	}
	// Populate the quota using exact existing records; the next successful
	// worker response must not masquerade as an archived result.
	if _, err := database.ExecContext(ctx, `INSERT INTO project_calculation_archives
 (project_id,scheme_id,scheme_name,author_account_id,topology_revision,model_group,method,input_body,result_body,input_sha256,result_sha256)
 SELECT a.project_id,a.scheme_id,a.scheme_name,a.author_account_id,a.topology_revision,a.model_group,a.method,a.input_body,a.result_body,a.input_sha256,a.result_sha256
 FROM project_calculation_archives a CROSS JOIN generate_series(1,98) WHERE a.id=$1`, id); err != nil {
		t.Fatal(err)
	}
	if w := request("POST", path, tokens[0].Token, `"1"`); w.Code != 409 || w.Header().Get("X-Enersy-Archive-Id") != "" || count() != 100 {
		t.Fatal("archive quota not enforced", w.Code, w.Body.String())
	}
	if _, err := database.ExecContext(ctx, `DELETE FROM circuit_schemes WHERE id=$1`, scheme); err != nil {
		t.Fatal(err)
	}
	if w := request("GET", detail+"/input", tokens[0].Token, ""); w.Code != 200 || !bytes.Equal(w.Body.Bytes(), originalInput) {
		t.Fatal("scheme deletion erased snapshot", w.Code)
	}
	if _, err := store.ChangeMember(ctx, tokens[0].Token, project, accounts[3], 3, "", true); err != nil {
		t.Fatal(err)
	}
	if w := request("GET", detail+"/result", tokens[3].Token, ""); w.Code != 404 {
		t.Fatal("removed viewer read archive", w.Code)
	}
	// DB deletion of the owning project is deliberate removal of its archive.
	if _, err := database.ExecContext(ctx, `DELETE FROM projects WHERE id=$1`, project); err != nil {
		t.Fatal(err)
	}
	if count() != 0 {
		t.Fatal("project deletion left an orphan archive")
	}
}

func TestCalculationArchiveValidation(t *testing.T) {
	// All these return before opening a DB transaction.
	store := projectStore{database: (*sql.DB)(nil)}
	for _, body := range []string{`null`, `[]`, `{"success":false}`, `{"success":true,"node_count":1,"nodes":[{}],"version":"x","method_used":"wrong"}`} {
		if _, err := store.SaveCalculationArchive(context.Background(), "", 1, 1, calculationInput{}, "three-phase", "newton-raphson", []byte(`{}`), []byte(body)); err != errArchiveResult {
			t.Fatal("invalid archive accepted", err)
		}
	}
}
