package main

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"
)

func TestProjectComponentHTTPPostgres(t *testing.T) {
	database := migrationTestDatabase(t)
	if err := runMigrationsFromSource(database, migrationSourceURL(t)); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	sessions := sessionStore{database: database}
	store := projectStore{database: database}
	var accounts [3]int64
	var tokens [3]issuedSession
	for i := range accounts {
		if err := database.QueryRowContext(ctx, `INSERT INTO auth_accounts(display_name) VALUES('Component fixture') RETURNING id`).Scan(&accounts[i]); err != nil {
			t.Fatal(err)
		}
		var err error
		tokens[i], err = sessions.Issue(ctx, accounts[i], time.Hour)
		if err != nil {
			t.Fatal(err)
		}
	}
	project, err := store.Create(ctx, tokens[0].Token, "Equipment fixture")
	if err != nil {
		t.Fatal(err)
	}
	scheme, err := store.CreateScheme(ctx, tokens[0].Token, project, "Equipment", "")
	if err != nil {
		t.Fatal(err)
	}
	sibling, err := store.CreateScheme(ctx, tokens[0].Token, project, "Sibling", "")
	if err != nil {
		t.Fatal(err)
	}
	foreign, err := store.Create(ctx, tokens[2].Token, "Foreign")
	if err != nil {
		t.Fatal(err)
	}
	var typeID, modelID int
	if err := database.QueryRowContext(ctx, `SELECT id FROM component_types WHERE code='busbar'`).Scan(&typeID); err != nil {
		t.Fatal(err)
	}
	if err := database.QueryRowContext(ctx, `SELECT id FROM equipment_models WHERE component_type_id=$1 ORDER BY id LIMIT 1`, typeID).Scan(&modelID); err != nil {
		t.Fatal(err)
	}
	auth := newAuthHTTP(database, "https://frontend.example", true)
	handler := projectsHTTP{auth: auth}
	base := fmt.Sprintf("/api/projects/%d/schemes/%d/components", project, scheme)
	request := func(token, method, path, body, tag string) *httptest.ResponseRecorder {
		t.Helper()
		req := httptest.NewRequest(method, path, strings.NewReader(body)).WithContext(ctx)
		req.Header.Set("Origin", auth.origin)
		req.Header.Set("Content-Type", "application/json")
		if tag != "" {
			req.Header.Set("If-Match", tag)
		}
		if token != "" {
			req.AddCookie(&http.Cookie{Name: auth.cookieName(), Value: token})
		}
		rec := httptest.NewRecorder()
		handler.ServeHTTP(rec, req)
		if rec.Header().Get("Cache-Control") != "no-store" {
			t.Fatal("private write cacheable")
		}
		return rec
	}
	createBody := fmt.Sprintf(`{"typeId":"%d","equipmentModelId":"%d","name":"Private bus","params":{"voltage_nom":"220"}}`, typeID, modelID)
	largeCursor := request(tokens[0].Token, "GET", fmt.Sprintf("/api/projects/%d/schemes?afterId=9223372036854775807", project), "", "")
	if largeCursor.Code != 200 || !strings.Contains(largeCursor.Body.String(), `"items":[]`) {
		t.Fatal("BIGINT scheme cursor overflowed INTEGER column")
	}
	rec := request(tokens[0].Token, "POST", base, createBody, "")
	var created struct {
		ID       string            `json:"id"`
		Revision string            `json:"revision"`
		Params   map[string]string `json:"params"`
		Model    string            `json:"equipmentModelId"`
	}
	if rec.Code != 201 || json.Unmarshal(rec.Body.Bytes(), &created) != nil || created.ID == "" || created.Params["voltage_nom"] != "220" || created.Model != strconv.Itoa(modelID) {
		t.Fatal("passport creation failed")
	}
	id, err := strconv.Atoi(created.ID)
	if err != nil {
		t.Fatal(err)
	}
	path := base + "/" + created.ID
	tag := `"` + created.Revision + `"`
	if rec.Header().Get("ETag") != tag {
		t.Fatal("creation revision tag incorrect")
	}
	if _, err := store.ChangeMember(ctx, tokens[0].Token, project, accounts[1], 0, "viewer", false); err != nil {
		t.Fatal(err)
	}
	patch := `{"pose":{"x":10},"params":{"voltage_nom":"230"}}`
	for _, tc := range []struct {
		token, method, path, body, tag string
		status                         int
	}{
		{tokens[2].Token, "POST", base, createBody, "", 404},
		{tokens[1].Token, "POST", base, createBody, "", 404},
		{tokens[1].Token, "PATCH", path, patch, tag, 404},
		{tokens[0].Token, "PATCH", fmt.Sprintf("/api/projects/%d/schemes/%d/components/%d", foreign, scheme, id), patch, tag, 404},
		{tokens[0].Token, "PATCH", fmt.Sprintf("/api/projects/%d/schemes/%d/components/%d", project, sibling, id), patch, tag, 404},
		{tokens[0].Token, "PATCH", path, patch, "", 428},
		{tokens[0].Token, "PATCH", base + "/9007199254740993", patch, tag, 404},
		{tokens[0].Token, "POST", base, `{"typeId":"9007199254740993","name":"Bad type"}`, "", 400},
		{tokens[0].Token, "POST", base, fmt.Sprintf(`{"typeId":"%d","name":"Bad","schemeId":1}`, typeID), "", 400},
	} {
		if rec := request(tc.token, tc.method, tc.path, tc.body, tc.tag); rec.Code != tc.status {
			t.Fatalf("%s: %d want %d", tc.method, rec.Code, tc.status)
		}
	}
	if _, err := store.ChangeMember(ctx, tokens[0].Token, project, accounts[1], 1, "editor", false); err != nil {
		t.Fatal(err)
	}
	// Two actual HTTP handlers loaded one revision; exactly one may commit.
	start := make(chan struct{})
	results := make(chan *httptest.ResponseRecorder, 2)
	var wg sync.WaitGroup
	for _, token := range []string{tokens[0].Token, tokens[1].Token} {
		wg.Add(1)
		go func(token string) { defer wg.Done(); <-start; results <- request(token, "PATCH", path, patch, tag) }(token)
	}
	close(start)
	wg.Wait()
	close(results)
	success, conflicts := 0, 0
	var revision string
	for rec := range results {
		if rec.Code == 200 {
			success++
			var ack struct {
				Revision string `json:"revision"`
			}
			if json.Unmarshal(rec.Body.Bytes(), &ack) != nil {
				t.Fatal("invalid patch ack")
			}
			revision = ack.Revision
		} else if rec.Code == 412 {
			conflicts++
		} else {
			t.Fatalf("unexpected patch status: %d", rec.Code)
		}
	}
	if success != 1 || conflicts != 1 {
		t.Fatal("parallel patch overwrote revision")
	}
	var x float64
	var voltage string
	if err := database.QueryRowContext(ctx, `SELECT sc.pos_x,p.param_value FROM scheme_components sc JOIN scheme_component_params p ON p.scheme_component_id=sc.id WHERE sc.id=$1 AND p.param_key='voltage_nom'`, id).Scan(&x, &voltage); err != nil || x != 10 || voltage != "230" {
		t.Fatal("patch incomplete")
	}
	// Failure in the second part rolls back geometry and trigger-owned revision.
	if _, err := database.ExecContext(ctx, `CREATE FUNCTION reject_project_parameter() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.param_key='reject' THEN RAISE EXCEPTION 'fixture'; END IF; RETURN NEW; END; $$;
 CREATE TRIGGER reject_project_parameter BEFORE INSERT ON scheme_component_params FOR EACH ROW EXECUTE FUNCTION reject_project_parameter();`); err != nil {
		t.Fatal(err)
	}
	rec = request(tokens[1].Token, "PATCH", path, `{"pose":{"x":99},"params":{"reject":"1"}}`, `"`+revision+`"`)
	if rec.Code != 500 {
		t.Fatal("injected partial patch did not fail")
	}
	var after string
	if err := database.QueryRowContext(ctx, `SELECT pos_x,revision::text FROM scheme_components WHERE id=$1`, id).Scan(&x, &after); err != nil || x != 10 || after != revision {
		t.Fatal("failed patch leaked geometry or revision")
	}
	// Owner removal wins before a queued editor obtains the project lock.
	blocker, err := database.BeginTx(ctx, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer blocker.Rollback()
	var pid int
	if err := blocker.QueryRowContext(ctx, `SELECT pg_backend_pid() FROM projects WHERE id=$1 FOR UPDATE`, project).Scan(&pid); err != nil {
		t.Fatal(err)
	}
	waiting := make(chan *httptest.ResponseRecorder, 1)
	go func() { waiting <- request(tokens[1].Token, "PATCH", path, `{"pose":{"x":88}}`, `"`+revision+`"`) }()
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
		t.Fatal("editor did not wait on project lock")
	}
	if _, err := blocker.ExecContext(ctx, `DELETE FROM project_members WHERE project_id=$1 AND account_id=$2`, project, accounts[1]); err != nil {
		t.Fatal(err)
	}
	if _, err := blocker.ExecContext(ctx, `UPDATE projects SET membership_revision=membership_revision+1 WHERE id=$1`, project); err != nil {
		t.Fatal(err)
	}
	if err := blocker.Commit(); err != nil {
		t.Fatal(err)
	}
	if rec := <-waiting; rec.Code != 404 {
		t.Fatal("removed waiting editor committed")
	}
	if rec := request(tokens[0].Token, "DELETE", path, "", `"`+revision+`"`); rec.Code != 200 {
		t.Fatal("owner delete failed")
	}
	var count int
	if err := database.QueryRowContext(ctx, `SELECT count(*) FROM scheme_components WHERE id=$1`, id).Scan(&count); err != nil || count != 0 {
		t.Fatal("component not deleted")
	}
}
