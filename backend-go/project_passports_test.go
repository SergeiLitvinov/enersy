package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"
)

func passportFixture() passportDocument {
	return passportDocument{FormatVersion: 1, ComponentTypeCode: "generator", Name: "User source", Manufacturer: "Fixture", Source: "User-supplied test data", License: "Test fixture only", Parameters: map[string]passportParameter{"p": {Value: "10.00", Unit: "МВт"}}}
}
func TestPassportDocumentValidation(t *testing.T) {
	for _, tc := range []struct {
		name   string
		mutate func(*passportDocument)
	}{
		{"version", func(d *passportDocument) { d.FormatVersion = 2 }},
		{"source", func(d *passportDocument) { d.Source = " " }},
		{"license", func(d *passportDocument) { d.License = "" }},
		{"name", func(d *passportDocument) { d.Name = "" }},
		{"empty parameters", func(d *passportDocument) { d.Parameters = nil }},
		{"invalid UTF8", func(d *passportDocument) { d.Source = string([]byte{0xff}) }},
		{"NUL", func(d *passportDocument) { d.Parameters["p"] = passportParameter{Value: "1\x00", Unit: "МВт"} }},
	} {
		t.Run(tc.name, func(t *testing.T) {
			d := passportFixture()
			tc.mutate(&d)
			if validatePassportDocument(d) == nil {
				t.Fatal("accepted malformed document")
			}
		})
	}
	if err := validatePassportDocument(passportFixture()); err != nil {
		t.Fatal(err)
	}
}

func TestProjectPassportsPostgres(t *testing.T) {
	database := migrationTestDatabase(t)
	if err := runMigrationsFromSource(database, migrationSourceURL(t)); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 45*time.Second)
	defer cancel()
	sessions := sessionStore{database: database}
	store := projectStore{database: database}
	var accounts [4]int64
	var tokens [4]issuedSession
	for i := range accounts {
		if err := database.QueryRowContext(ctx, `INSERT INTO auth_accounts(display_name) VALUES('Passport fixture') RETURNING id`).Scan(&accounts[i]); err != nil {
			t.Fatal(err)
		}
		var err error
		tokens[i], err = sessions.Issue(ctx, accounts[i], time.Hour)
		if err != nil {
			t.Fatal(err)
		}
	}
	project, err := store.Create(ctx, tokens[0].Token, "Project catalog")
	if err != nil {
		t.Fatal(err)
	}
	foreign, err := store.Create(ctx, tokens[3].Token, "Foreign catalog")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := store.ChangeMember(ctx, tokens[0].Token, project, accounts[1], 0, "editor", false); err != nil {
		t.Fatal(err)
	}
	if _, err := store.ChangeMember(ctx, tokens[0].Token, project, accounts[2], 1, "viewer", false); err != nil {
		t.Fatal(err)
	}
	auth := newAuthHTTP(database, "http://localhost:4174", false)
	handler := projectsHTTP{auth: auth}
	path := fmt.Sprintf("/api/projects/%d/passports", project)
	request := func(method, path, token, command string, doc passportDocument, parent *string) *httptest.ResponseRecorder {
		var body bytes.Buffer
		if method == http.MethodPost {
			if err := json.NewEncoder(&body).Encode(struct {
				Document      passportDocument `json:"document"`
				PredecessorID *string          `json:"predecessorId"`
			}{doc, parent}); err != nil {
				t.Fatal(err)
			}
		}
		r := httptest.NewRequest(method, path, &body)
		r.Header.Set("Origin", auth.origin)
		r.Header.Set("Content-Type", "application/json")
		if token != "" {
			r.AddCookie(&http.Cookie{Name: auth.cookieName(), Value: token})
		}
		if command != "" {
			r.Header.Set("Idempotency-Key", command)
		}
		w := httptest.NewRecorder()
		handler.ServeHTTP(w, r)
		return w
	}
	sequence := 0
	post := func(token string, doc passportDocument, parent *string) *httptest.ResponseRecorder {
		sequence++
		return request(http.MethodPost, path, token, fmt.Sprintf("00000000-0000-4000-8000-%012d", sequence), doc, parent)
	}
	doc := passportFixture()
	for _, tc := range []struct {
		name, body, contentType, command string
		status                           int
	}{
		{"malformed", "{", "application/json", "dddddddd-0000-4000-8000-000000000001", 400},
		{"oversize", "{\"document\":\"" + strings.Repeat("x", 72<<10) + "\"}", "application/json", "dddddddd-0000-4000-8000-000000000001", 413},
		{"trailing oversize", "{}" + strings.Repeat(" ", 72<<10), "application/json", "dddddddd-0000-4000-8000-000000000001", 413},
		{"wrong media", "{}", "text/plain", "dddddddd-0000-4000-8000-000000000001", 415},
		{"missing command", "{}", "application/json", "", 400},
		{"unknown field", "{\"unknown\":true}", "application/json", "dddddddd-0000-4000-8000-000000000001", 400},
	} {
		t.Run(tc.name, func(t *testing.T) {
			r := httptest.NewRequest(http.MethodPost, path, strings.NewReader(tc.body))
			r.Header.Set("Origin", auth.origin)
			r.Header.Set("Content-Type", tc.contentType)
			r.AddCookie(&http.Cookie{Name: auth.cookieName(), Value: tokens[0].Token})
			if tc.command != "" {
				r.Header.Set("Idempotency-Key", tc.command)
			}
			w := httptest.NewRecorder()
			handler.ServeHTTP(w, r)
			if w.Code != tc.status {
				t.Fatalf("status %d, want %d: %s", w.Code, tc.status, w.Body)
			}
		})
	}
	for _, token := range []string{tokens[2].Token, tokens[3].Token} {
		if w := post(token, doc, nil); w.Code != 404 {
			t.Fatalf("unauthorized write: %d %s", w.Code, w.Body)
		}
	}
	if w := post("", doc, nil); w.Code != 401 {
		t.Fatalf("missing session: %d", w.Code)
	}
	for _, param := range []passportParameter{{"10", "MW"}, {"NaN", "МВт"}, {"Inf", "МВт"}, {"broken", "МВт"}, {"0x1p2", "МВт"}} {
		d := passportFixture()
		d.Parameters["p"] = param
		if w := post(tokens[0].Token, d, nil); w.Code != 400 {
			t.Fatalf("invalid parameter accepted: %d %s", w.Code, w.Body)
		}
	}
	unknown := passportFixture()
	unknown.Parameters["unknown"] = passportParameter{"1", ""}
	if w := post(tokens[0].Token, unknown, nil); w.Code != 400 {
		t.Fatal("unknown parameter accepted")
	}
	command := "aaaaaaaa-0000-4000-8000-000000000001"
	w := request(http.MethodPost, path, tokens[0].Token, command, doc, nil)
	if w.Code != 201 {
		t.Fatalf("create: %d %s", w.Code, w.Body)
	}
	var first passportVersion
	if err := json.Unmarshal(w.Body.Bytes(), &first); err != nil {
		t.Fatal(err)
	}
	if first.Status != "draft" || first.Revision != 1 || first.Document.Parameters["p"].Value != "10.00" {
		t.Fatalf("wrong snapshot: %+v", first)
	}
	w = request(http.MethodPost, path, tokens[0].Token, command, doc, nil)
	var replay passportVersion
	json.Unmarshal(w.Body.Bytes(), &replay)
	if w.Code != 201 || replay.ID != first.ID {
		t.Fatalf("replay changed identity: %d %s", w.Code, w.Body)
	}
	changed := passportFixture()
	changed.Parameters["p"] = passportParameter{"25", "МВт"}
	if w := request(http.MethodPost, path, tokens[0].Token, command, changed, nil); w.Code != 409 {
		t.Fatal("changed command payload accepted")
	}
	w = post(tokens[1].Token, changed, &first.ID)
	if w.Code != 201 {
		t.Fatalf("editor revision: %d %s", w.Code, w.Body)
	}
	var second passportVersion
	json.Unmarshal(w.Body.Bytes(), &second)
	if second.Revision != 2 || second.PredecessorID == nil || *second.PredecessorID != first.ID || second.ID == first.ID {
		t.Fatal("version chain lost")
	}
	if w := post(tokens[0].Token, changed, &first.ID); w.Code != 409 {
		t.Fatal("two successors accepted")
	}
	foreignPath := fmt.Sprintf("/api/projects/%d/passports", foreign)
	if w := request(http.MethodPost, foreignPath, tokens[3].Token, "bbbbbbbb-0000-4000-8000-000000000001", doc, &first.ID); w.Code != 404 {
		t.Fatal("foreign predecessor accepted")
	}
	for _, token := range []string{tokens[0].Token, tokens[1].Token, tokens[2].Token} {
		w = request(http.MethodGet, path+"/"+first.ID, token, "", doc, nil)
		var old passportVersion
		json.Unmarshal(w.Body.Bytes(), &old)
		if w.Code != 200 || old.Document.Parameters["p"].Value != "10.00" || old.SHA256 != first.SHA256 {
			t.Fatalf("old version changed: %d %s", w.Code, w.Body)
		}
	}
	if w := request(http.MethodGet, path+"/"+first.ID, tokens[3].Token, "", doc, nil); w.Code != 404 {
		t.Fatal("foreign account read passport")
	}
	w = request(http.MethodGet, path+"?limit=1", tokens[2].Token, "", doc, nil)
	var page struct {
		Items []passportVersion `json:"items"`
		Next  string            `json:"nextAfterId"`
	}
	json.Unmarshal(w.Body.Bytes(), &page)
	if w.Code != 200 || len(page.Items) != 1 || page.Next != first.ID {
		t.Fatalf("pagination: %d %s", w.Code, w.Body)
	}
	if _, err := database.ExecContext(ctx, `UPDATE project_passports SET revision=99 WHERE id=$1`, first.ID); err == nil {
		t.Fatal("SQL update bypassed immutability")
	}
	// Concurrent requests with an identical command must return the same version.
	var group sync.WaitGroup
	results := make(chan string, 2)
	for i := 0; i < 2; i++ {
		group.Add(1)
		go func() {
			defer group.Done()
			v, e := store.SavePassport(ctx, tokens[0].Token, project, "cccccccc-0000-4000-8000-000000000001", nil, doc)
			if e != nil {
				results <- "error:" + e.Error()
			} else {
				results <- v.ID
			}
		}()
	}
	group.Wait()
	close(results)
	previous := ""
	for id := range results {
		if strings.HasPrefix(id, "error:") || (previous != "" && previous != id) {
			t.Fatalf("concurrent command: %s/%s", previous, id)
		}
		previous = id
	}
	// Revocation prevents even replay of a formerly authorized command.
	if _, err := database.ExecContext(ctx, `UPDATE auth_sessions SET revoked_at=now() WHERE account_id=$1`, accounts[1]); err != nil {
		t.Fatal(err)
	}
	if w := request(http.MethodGet, path, tokens[1].Token, "", doc, nil); w.Code != 404 {
		t.Fatalf("revoked session read: %d", w.Code)
	}
	var count int
	if err := database.QueryRowContext(ctx, `SELECT count(*) FROM project_passports WHERE project_id=$1`, project).Scan(&count); err != nil || count != 3 {
		t.Fatalf("unexpected rows %d: %v", count, err)
	}
	if _, err := database.ExecContext(ctx, `INSERT INTO project_passports(project_id,author_account_id,command_id,revision,component_type_code,document,sha256)
 SELECT p.project_id,p.author_account_id,md5('quota-'||g::text)::uuid,1,p.component_type_code,p.document,p.sha256
 FROM project_passports p CROSS JOIN generate_series(1,997) g WHERE p.id=$1`, first.ID); err != nil {
		t.Fatal(err)
	}
	if w := post(tokens[0].Token, doc, nil); w.Code != 409 {
		t.Fatalf("quota not enforced: %d %s", w.Code, w.Body)
	}
	if w := request(http.MethodPost, path, tokens[0].Token, command, doc, nil); w.Code != 201 {
		t.Fatal("quota prevented replay of existing version")
	}
	if _, err := database.ExecContext(ctx, `DELETE FROM projects WHERE id=$1`, project); err != nil {
		t.Fatal(err)
	}
	if err := database.QueryRowContext(ctx, `SELECT count(*) FROM project_passports WHERE project_id=$1`, project).Scan(&count); err != nil || count != 0 {
		t.Fatal("project deletion did not remove private passports")
	}
}
