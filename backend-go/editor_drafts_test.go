package main

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"
)

const draftFixture = `{"formatVersion":1,"components":[{"componentId":"7","base":{"id":"7","typeId":"2","type":"load","equipmentModelId":null,"revision":"9007199254740993","name":"Private load","x":0,"y":10,"rotation":90,"params":{"p":"10"}},"intents":[{"kind":"parameter","key":"p","value":"11"},{"kind":"pose","values":{"x":12}},{"kind":"delete"}],"reason":"Lost acknowledgement"}],"graph":[{"intent":{"kind":"create-connection","commandId":"10000000-0000-0000-0000-000000000001","from":"7","to":"8","fromPort":"top","toPort":"left","expectedTopologyRevision":"9007199254740994"},"reason":"Unconfirmed command"}]}`
const emptyDraftFixture = `{"formatVersion":1,"components":[],"graph":[]}`

// The TypeScript codec consumes this same fixture, including every intent kind,
// historical BIGINT CAS and a parameter key that must not alter JS prototypes.
func TestEditorDraftSharedWireFixture(t *testing.T) {
	data, err := os.ReadFile("../tests/fixtures/editor-draft-v1.json")
	if err != nil {
		t.Fatal(err)
	}
	payload, err := decodeEditorDraft(data)
	if err != nil {
		t.Fatal(err)
	}
	if payload.Components[0].Base.Revision != "9007199254740993" || payload.Components[0].Base.Params["__proto__"] != "паспорт" ||
		string(payload.Graph[1].Intent.ExpectedTopologyRevision) != `"9007199254740994"` || string(payload.Graph[2].Intent.ExpectedTopologyRevision) != `"0"` {
		t.Fatal("shared recovery fixture lost original values or CAS")
	}
}

func TestEditorDraftPayload(t *testing.T) {
	payload, err := decodeEditorDraft([]byte(draftFixture))
	if err != nil || payload.Components[0].Base.Revision != "9007199254740993" || string(payload.Graph[0].Intent.ExpectedTopologyRevision) != `"9007199254740994"` {
		t.Fatal("valid draft/precise revisions rejected")
	}
	for _, invalid := range []string{
		strings.Replace(draftFixture, `"formatVersion":1`, `"FormatVersion":1`, 1),
		strings.Replace(draftFixture, `"value":"11"`, `"value":"\ud800"`, 1),
		strings.Replace(draftFixture, `"value":"11"`, `"value":"\udc00"`, 1),
		strings.Replace(draftFixture, `"formatVersion":1`, `"formatVersion":1,"formatVersion":1`, 1),
		strings.Replace(draftFixture, `"values":{"x":12}`, `"values":{"x":12,"x":13}`, 1),
		strings.Replace(draftFixture, `"rotation":90`, `"rotation":2147483648`, 1),
		strings.Replace(draftFixture, `"formatVersion":1`, `"formatVersion":2`, 1),
		strings.Replace(draftFixture, `"formatVersion":1`, `"formatVersion":1,"ownerId":"2"`, 1),
		strings.Replace(draftFixture, `"componentId":"7"`, `"componentId":"8"`, 1),
		strings.Replace(draftFixture, `"typeId":"2"`, `"typeId":2`, 1),
		strings.Replace(draftFixture, `"revision":"9007199254740993"`, `"revision":"9223372036854775808"`, 1),
		strings.Replace(draftFixture, `"x":0`, `"x":1e50`, 1),
		strings.Replace(draftFixture, `"values":{"x":12}`, `"values":{"x":null}`, 1),
		strings.Replace(draftFixture, `"kind":"delete"`, `"kind":"delete","value":"hidden"`, 1),
		strings.Replace(draftFixture, `"expectedTopologyRevision":"9007199254740994"`, `"expectedTopologyRevision":"01"`, 1),
		strings.Replace(draftFixture, `,"expectedTopologyRevision":"9007199254740994"`, ``, 1),
		strings.Replace(draftFixture, `"commandId":"10000000-0000-0000-0000-000000000001"`, `"commandId":"no-uuid"`, 1),
		strings.Replace(draftFixture, `"from":"7"`, `"from":"2147483648"`, 1),
		strings.Replace(draftFixture, `"params":{"p":"10"}`, `"params":null`, 1),
		strings.Replace(draftFixture, `"value":"11"`, `"value":null`, 1),
		`{"formatVersion":1,"components":null,"graph":[]}`, draftFixture + `{}`, strings.Repeat(" ", editorDraftMaxBytes+1),
	} {
		if _, err := decodeEditorDraft([]byte(invalid)); err == nil {
			t.Fatal("invalid draft accepted")
		}
	}
	if _, err := decodeEditorDraft([]byte(emptyDraftFixture)); err != nil {
		t.Fatal(err)
	}
	for _, value := range []string{`\ud83d\ude00`, `\\ud800`} {
		if _, err := decodeEditorDraft([]byte(strings.Replace(draftFixture, `"value":"11"`, `"value":"`+value+`"`, 1))); err != nil {
			t.Fatal("valid Unicode/literal escape rejected", err)
		}
	}
	if unambiguousDraftJSON([]byte(strings.Repeat("[", 20) + "1" + strings.Repeat("]", 20))) {
		t.Fatal("unbounded draft nesting accepted")
	}
	for _, graph := range []string{
		`{"intent":{"kind":"create-component","typeId":"2","name":"Load","x":0,"y":0,"rotation":0,"params":{}},"reason":""}`,
		`{"intent":{"kind":"delete-connection","id":"1","expectedTopologyRevision":"0"},"reason":""}`,
	} {
		if _, err := decodeEditorDraft([]byte(`{"formatVersion":1,"components":[],"graph":[` + graph + `]}`)); err != nil {
			t.Fatal("valid graph intention rejected", err)
		}
	}
}

func TestEditorDraftsPostgres(t *testing.T) {
	database := migrationTestDatabase(t)
	if err := runMigrationsFromSource(database, migrationSourceURL(t)); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 40*time.Second)
	defer cancel()
	sessions := sessionStore{database: database}
	store := projectStore{database: database}
	var accounts [3]int64
	var tokens [3]issuedSession
	for i := range accounts {
		if err := database.QueryRowContext(ctx, `INSERT INTO auth_accounts(display_name) VALUES('Private draft fixture') RETURNING id`).Scan(&accounts[i]); err != nil {
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
	project, err := store.Create(ctx, tokens[0].Token, "Draft project")
	if err != nil {
		t.Fatal(err)
	}
	scheme, err := store.CreateScheme(ctx, tokens[0].Token, project, "Draft scheme", "")
	if err != nil {
		t.Fatal(err)
	}
	foreign, err := store.Create(ctx, tokens[1].Token, "Other project")
	if err != nil {
		t.Fatal(err)
	}
	foreignScheme, err := store.CreateScheme(ctx, tokens[1].Token, foreign, "Other scheme", "")
	if err != nil {
		t.Fatal(err)
	}
	checkEditorDraftPhaseMigration(t, ctx, database, accounts[2], scheme)
	for _, invalid := range []string{`{}`, `{"formatVersion":"1"}`, `[]`} {
		if _, err := database.ExecContext(ctx, `INSERT INTO project_editor_drafts(account_id,scheme_id,workspace_id,revision,payload)
 VALUES($1,$2,'00000000-0000-0000-0000-000000000001',1,$3::jsonb)`, accounts[2], scheme, invalid); err == nil {
			t.Fatal("database accepted invalid draft envelope")
		}
	}
	if _, err := database.ExecContext(ctx, `INSERT INTO project_members(project_id,account_id,role) VALUES($1,$2,'editor')`, project, accounts[1]); err != nil {
		t.Fatal(err)
	}
	auth := newAuthHTTP(database, "https://frontend.example", true)
	handler := projectsHTTP{auth: auth}
	base := fmt.Sprintf("/api/projects/%d/schemes/%d/drafts", project, scheme)
	workspace := "10000000-0000-0000-0000-000000000001"
	request := func(token, method, path, body, match string) *httptest.ResponseRecorder {
		req := httptest.NewRequest(method, path, strings.NewReader(body)).WithContext(ctx)
		if token != "" {
			req.AddCookie(&http.Cookie{Name: auth.cookieName(), Value: token})
		}
		if method != "GET" {
			req.Header.Set("Origin", auth.origin)
		}
		req.Header.Set("Content-Type", "application/json")
		if match != "" {
			req.Header.Set("If-Match", match)
		}
		rec := httptest.NewRecorder()
		handler.ServeHTTP(rec, req)
		return rec
	}
	check := func(token, method, path, body, match string, want int) *httptest.ResponseRecorder {
		t.Helper()
		rec := request(token, method, path, body, match)
		if rec.Code != want || rec.Header().Get("Cache-Control") != "no-store" {
			t.Fatalf("draft response %s %d expected %d: %s", method, rec.Code, want, rec.Body.String())
		}
		return rec
	}
	path := base + "/" + workspace
	check(tokens[0].Token, "PUT", path, draftFixture, `"0"`, 200)
	read := check(second.Token, "GET", path, "", "", 200)
	var draft editorDraftView
	if json.Unmarshal(read.Body.Bytes(), &draft) != nil || draft.Revision != "1" || read.Header().Get("ETag") != `"1"` || !strings.Contains(string(draft.Payload), "Private load") {
		t.Fatal("owner draft lost payload/revision")
	}
	check(tokens[1].Token, "GET", path, "", "", 404) // Shared editor cannot read owner's journal.
	check(tokens[1].Token, "DELETE", path, "", `"1"`, 404)
	check(tokens[1].Token, "PUT", path, emptyDraftFixture, `"0"`, 200) // Same UUID, separate account namespace.
	read = check(tokens[1].Token, "GET", path, "", "", 200)
	if strings.Contains(read.Body.String(), "Private load") {
		t.Fatal("private owner payload leaked")
	}
	list := check(tokens[0].Token, "GET", base, "", "", 200)
	if strings.Contains(list.Body.String(), "payload") || strings.Contains(list.Body.String(), "Private load") {
		t.Fatal("list exposes journal bodies")
	}
	for _, boundary := range []struct {
		token, method, path, body, match string
		status                           int
	}{
		{tokens[2].Token, "GET", path, "", "", 404}, {"", "GET", path, "", "", 401},
		{tokens[0].Token, "GET", fmt.Sprintf("/api/projects/%d/schemes/%d/drafts/%s", foreign, scheme, workspace), "", "", 404},
		{tokens[0].Token, "GET", fmt.Sprintf("/api/projects/%d/schemes/%d/drafts/%s", project, foreignScheme, workspace), "", "", 404},
		{tokens[0].Token, "PUT", path, emptyDraftFixture, "", 428}, {tokens[0].Token, "PUT", path, emptyDraftFixture, `W/"1"`, 400},
		{tokens[0].Token, "PUT", path, emptyDraftFixture, `"0"`, 412}, {tokens[0].Token, "PUT", path, `{"formatVersion":2}`, `"1"`, 400},
		{tokens[0].Token, "PUT", path, strings.Repeat("x", editorDraftMaxBytes+1), `"1"`, 413},
	} {
		check(boundary.token, boundary.method, boundary.path, boundary.body, boundary.match, boundary.status)
	}
	var topologyBefore, topologyAfter int64
	if err := database.QueryRowContext(ctx, `SELECT topology_revision FROM circuit_schemes WHERE id=$1`, scheme).Scan(&topologyBefore); err != nil {
		t.Fatal(err)
	}
	statuses := make(chan int, 2)
	for i := 0; i < 2; i++ {
		go func() { statuses <- request(tokens[0].Token, "PUT", path, emptyDraftFixture, `"1"`).Code }()
	}
	a, b := <-statuses, <-statuses
	if !((a == 200 && b == 412) || (a == 412 && b == 200)) {
		t.Fatalf("draft lost update: %d/%d", a, b)
	}
	check(tokens[0].Token, "DELETE", path, "", `"2"`, 200)
	check(tokens[0].Token, "GET", path, "", "", 404)
	check(tokens[0].Token, "PUT", path, draftFixture, `"0"`, 404)
	check(tokens[0].Token, "PUT", path, draftFixture, `"3"`, 404)
	var tombstone bool
	if err := database.QueryRowContext(ctx, `SELECT payload IS NULL AND deleted_at IS NOT NULL AND revision=3 FROM project_editor_drafts WHERE account_id=$1 AND scheme_id=$2 AND workspace_id=$3`, accounts[0], scheme, workspace).Scan(&tombstone); err != nil || !tombstone {
		t.Fatal("deleted draft retained private body or lost tombstone")
	}
	if err := database.QueryRowContext(ctx, `SELECT topology_revision FROM circuit_schemes WHERE id=$1`, scheme).Scan(&topologyAfter); err != nil || topologyBefore != topologyAfter {
		t.Fatal("draft changed physical topology")
	}
	if _, err := database.ExecContext(ctx, `UPDATE project_members SET role='viewer' WHERE project_id=$1 AND account_id=$2`, project, accounts[1]); err != nil {
		t.Fatal(err)
	}
	check(tokens[1].Token, "GET", path, "", "", 200)
	check(tokens[1].Token, "PUT", path, emptyDraftFixture, `"1"`, 404)
	check(tokens[1].Token, "DELETE", path, "", `"1"`, 200) // May discard own intentions after demotion.
	otherPath := base + "/20000000-0000-0000-0000-000000000001"
	check(second.Token, "PUT", otherPath, draftFixture, `"0"`, 200)
	if err := sessions.Revoke(ctx, second.Token, tokens[0].Identity.SessionID); err != nil {
		t.Fatal(err)
	}
	check(tokens[0].Token, "GET", otherPath, "", "", 404)
	check(second.Token, "GET", otherPath, "", "", 200)
	// Revoked member waiting for a project lock must not store a journal.
	if _, err := database.ExecContext(ctx, `UPDATE project_members SET role='editor' WHERE project_id=$1 AND account_id=$2`, project, accounts[1]); err != nil {
		t.Fatal(err)
	}
	tx, err := database.BeginTx(ctx, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback()
	var lock, pid int
	if err := tx.QueryRowContext(ctx, `SELECT id FROM projects WHERE id=$1 FOR UPDATE`, project).Scan(&lock); err != nil {
		t.Fatal(err)
	}
	if err := tx.QueryRowContext(ctx, `SELECT pg_backend_pid()`).Scan(&pid); err != nil {
		t.Fatal(err)
	}
	waiting := make(chan int, 1)
	go func() { waiting <- request(tokens[1].Token, "PUT", otherPath, emptyDraftFixture, `"0"`).Code }()
	blocked := false
	deadline := time.Now().Add(4 * time.Second)
	for time.Now().Before(deadline) {
		if err := database.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid)))`, pid).Scan(&blocked); err != nil {
			t.Fatal(err)
		}
		if blocked {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	if !blocked {
		t.Fatal("draft write did not wait on membership lock")
	}
	if _, err := tx.ExecContext(ctx, `DELETE FROM project_members WHERE project_id=$1 AND account_id=$2`, project, accounts[1]); err != nil {
		t.Fatal(err)
	}
	if err := tx.Commit(); err != nil {
		t.Fatal(err)
	}
	if status := <-waiting; status != 404 {
		t.Fatalf("removed editor wrote draft: %d", status)
	}
	check(tokens[1].Token, "GET", otherPath, "", "", 404)
	// Account-wide quotas apply across schemes and serialize concurrent creation.
	if _, err := database.ExecContext(ctx, `INSERT INTO project_editor_drafts(account_id,scheme_id,workspace_id,revision,payload)
 SELECT $1,$2,('30000000-0000-0000-0000-' || lpad(n::text,12,'0'))::uuid,1,$3::jsonb FROM generate_series(1,30) n`, accounts[0], scheme, emptyDraftFixture); err != nil {
		t.Fatal(err)
	}
	quotaScheme, err := store.CreateScheme(ctx, second.Token, project, "Independent draft context", "")
	if err != nil {
		t.Fatal(err)
	}
	for i := 1; i <= 2; i++ {
		quotaPath := fmt.Sprintf("%s/40000000-0000-0000-0000-%012d", base, i)
		if i == 2 {
			quotaPath = fmt.Sprintf("/api/projects/%d/schemes/%d/drafts/40000000-0000-0000-0000-000000000002", project, quotaScheme)
		}
		go func(path string) { statuses <- request(second.Token, "PUT", path, emptyDraftFixture, `"0"`).Code }(quotaPath)
	}
	a, b = <-statuses, <-statuses
	if !((a == 200 && b == 409) || (a == 409 && b == 200)) {
		t.Fatalf("concurrent account quota bypass: %d/%d", a, b)
	}
	check(second.Token, "PUT", otherPath, emptyDraftFixture, `"1"`, 200) // Existing journals remain editable at quota.
	if _, err := database.ExecContext(ctx, `INSERT INTO project_editor_drafts(account_id,scheme_id,workspace_id,revision,deleted_at)
 SELECT $1,$2,('50000000-0000-0000-0000-' || lpad(n::text,12,'0'))::uuid,1,now() FROM generate_series(1,223) n`, accounts[0], scheme); err != nil {
		t.Fatal(err)
	}
	check(second.Token, "DELETE", otherPath, "", `"2"`, 200)
	check(second.Token, "PUT", base+"/60000000-0000-0000-0000-000000000001", emptyDraftFixture, `"0"`, 409)
	canceled, stop := context.WithCancel(ctx)
	stop()
	if _, err := store.ReadEditorDrafts(canceled, second.Token, project, int(scheme), ""); err == nil {
		t.Fatal("draft read ignored cancellation")
	}
	if _, err := database.ExecContext(ctx, `UPDATE auth_sessions SET issued_at=now()-interval '2 hours',expires_at=now()-interval '1 hour' WHERE id=$1`, second.Identity.SessionID); err != nil {
		t.Fatal(err)
	}
	check(second.Token, "GET", base, "", "", 404)
	check(tokens[1].Token, "GET", fmt.Sprintf("/api/projects/%d/schemes/%d/drafts", foreign, foreignScheme), "", "", 200)
	fresh, err := sessions.Issue(ctx, accounts[0], time.Hour)
	if err != nil {
		t.Fatal(err)
	}
	check(fresh.Token, "GET", base, "", "", 200)
	if _, err := database.ExecContext(ctx, `UPDATE auth_accounts SET disabled_at=now() WHERE id=$1`, accounts[0]); err != nil {
		t.Fatal(err)
	}
	check(fresh.Token, "GET", base, "", "", 404)
}
