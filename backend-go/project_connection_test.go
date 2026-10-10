package main

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"
)

func TestProjectConnectionsPostgres(t *testing.T) {
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
		if err := database.QueryRowContext(ctx, `INSERT INTO auth_accounts(display_name) VALUES('Connection fixture') RETURNING id`).Scan(&accounts[i]); err != nil {
			t.Fatal(err)
		}
		var err error
		tokens[i], err = sessions.Issue(ctx, accounts[i], time.Hour)
		if err != nil {
			t.Fatal(err)
		}
	}
	project, err := store.Create(ctx, tokens[0].Token, "Connections")
	if err != nil {
		t.Fatal(err)
	}
	scheme, err := store.CreateScheme(ctx, tokens[0].Token, project, "Connections", "")
	if err != nil {
		t.Fatal(err)
	}
	sibling, err := store.CreateScheme(ctx, tokens[0].Token, project, "Sibling", "")
	if err != nil {
		t.Fatal(err)
	}
	var typeID int
	if err := database.QueryRowContext(ctx, `SELECT id FROM component_types WHERE code='busbar'`).Scan(&typeID); err != nil {
		t.Fatal(err)
	}
	ids := make([]int, 3)
	for i := range ids {
		parent := int(scheme)
		if i == 2 {
			parent = int(sibling)
		}
		var err error
		ids[i], _, _, err = store.CreateComponent(ctx, tokens[0].Token, project, createComponentRequest{SchemeID: parent, TypeID: typeID, Name: "Bus"})
		if err != nil {
			t.Fatal(err)
		}
	}
	if _, err := store.ChangeMember(ctx, tokens[0].Token, project, accounts[1], 0, "editor", false); err != nil {
		t.Fatal(err)
	}
	if _, err := store.ChangeMember(ctx, tokens[0].Token, project, accounts[2], 1, "viewer", false); err != nil {
		t.Fatal(err)
	}
	auth := newAuthHTTP(database, "https://frontend.example", true)
	handler := projectsHTTP{auth: auth}
	base := fmt.Sprintf("/api/projects/%d/schemes/%d", project, scheme)
	path := base + "/connection-commands"
	body := fmt.Sprintf(`{"from":"%d","to":"%d","fromPort":"right","toPort":"left"}`, ids[0], ids[1])
	key := "a1111111-1111-4111-8111-111111111111"
	request := func(token, method, path, body, key, tag string) *httptest.ResponseRecorder {
		t.Helper()
		req := httptest.NewRequest(method, path, strings.NewReader(body)).WithContext(ctx)
		req.Header.Set("Origin", auth.origin)
		req.Header.Set("Content-Type", "application/json")
		if token != "" {
			req.AddCookie(&http.Cookie{Name: auth.cookieName(), Value: token})
		}
		if key != "" {
			req.Header.Set("Idempotency-Key", key)
		}
		if tag != "" {
			req.Header.Set("If-Match", tag)
		}
		rec := httptest.NewRecorder()
		handler.ServeHTTP(rec, req)
		return rec
	}
	for _, tc := range []struct {
		token, body, key, tag string
		status                int
	}{
		{tokens[0].Token, body, key, "", 428},
		{tokens[0].Token, body, "", `"2"`, 400},
		{tokens[2].Token, body, key, `"2"`, 404},
		{tokens[0].Token, body, key, `"1"`, 412},
		{tokens[0].Token, fmt.Sprintf(`{"from":"%d","to":"%d","fromPort":"right","toPort":"left"}`, ids[0], ids[2]), key, `"2"`, 404},
		{tokens[0].Token, fmt.Sprintf(`{"from":"%d","to":"%d","fromPort":"unknown","toPort":"left"}`, ids[0], ids[1]), key, `"2"`, 422},
	} {
		if rec := request(tc.token, "POST", path, tc.body, tc.key, tc.tag); rec.Code != tc.status {
			t.Fatalf("command: %d want %d", rec.Code, tc.status)
		}
	}
	start := make(chan struct{})
	results := make(chan *httptest.ResponseRecorder, 2)
	var wg sync.WaitGroup
	for _, token := range []string{tokens[0].Token, tokens[1].Token} {
		wg.Add(1)
		go func(token string) {
			defer wg.Done()
			<-start
			results <- request(token, "POST", path, body, key, `"2"`)
		}(token)
	}
	close(start)
	wg.Wait()
	close(results)
	created, replayed := 0, 0
	var ack struct {
		ID       string `json:"id"`
		Revision string `json:"topologyRevision"`
		Deleted  bool   `json:"deleted"`
	}
	for rec := range results {
		var value struct {
			ID       string `json:"id"`
			Revision string `json:"topologyRevision"`
			Deleted  bool   `json:"deleted"`
		}
		if json.Unmarshal(rec.Body.Bytes(), &value) != nil {
			t.Fatal("invalid command reply")
		}
		if ack.ID != "" && ack.ID != value.ID {
			t.Fatal("duplicate connection IDs")
		}
		ack = value
		if rec.Code == 201 {
			created++
		} else if rec.Code == 200 && rec.Header().Get("Idempotency-Replayed") == "true" {
			replayed++
		} else {
			t.Fatalf("command status %d", rec.Code)
		}
	}
	if created != 1 || replayed != 1 || ack.Revision != "3" || ack.Deleted {
		t.Fatal("same-key concurrent command incorrect")
	}
	changed := fmt.Sprintf(`{"from":"%d","to":"%d","fromPort":"left","toPort":"left"}`, ids[0], ids[1])
	if rec := request(tokens[0].Token, "POST", path, changed, key, `"2"`); rec.Code != 409 {
		t.Fatal("changed payload reused journal key")
	}
	var count int
	if err := database.QueryRowContext(ctx, `SELECT count(*) FROM connection_commands WHERE scheme_id=$1`, scheme).Scan(&count); err != nil || count != 1 {
		t.Fatal("command journal duplicate")
	}
	deletePath := base + "/connections/" + ack.ID
	if rec := request(tokens[0].Token, "DELETE", deletePath, "", "", `"2"`); rec.Code != 412 {
		t.Fatal("stale topology deletes connection")
	}
	if rec := request(tokens[2].Token, "DELETE", deletePath, "", "", `"3"`); rec.Code != 404 {
		t.Fatal("viewer deletes connection")
	}
	if rec := request(tokens[1].Token, "DELETE", deletePath, "", "", `"3"`); rec.Code != 200 {
		t.Fatal("editor deletion failed")
	}
	rec := request(tokens[0].Token, "POST", path, body, key, `"2"`)
	if rec.Code != 200 || json.Unmarshal(rec.Body.Bytes(), &ack) != nil || !ack.Deleted || ack.Revision != "4" {
		t.Fatal("replay resurrected deleted connection")
	}
	if err := database.QueryRowContext(ctx, `SELECT count(*) FROM scheme_connections WHERE scheme_id=$1`, scheme).Scan(&count); err != nil || count != 0 {
		t.Fatal("deleted connection recreated")
	}
	// Pose/parameter edits use component revisions, not the topology counter.
	if _, err := store.MutateComponent(ctx, tokens[0].Token, project, int(scheme), ids[0], 1, func(tx *sql.Tx) error {
		_, err := tx.ExecContext(ctx, `UPDATE scheme_components SET pos_x=12 WHERE id=$1`, ids[0])
		return err
	}, false); err != nil {
		t.Fatal(err)
	}
	var topology int64
	if err := database.QueryRowContext(ctx, `SELECT topology_revision FROM circuit_schemes WHERE id=$1`, scheme).Scan(&topology); err != nil || topology != 4 {
		t.Fatal("geometry changed topology revision")
	}
	// An editor removed before obtaining the project lock cannot replay a journal entry.
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
	go func() { waiting <- request(tokens[1].Token, "POST", path, body, key, `"2"`) }()
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
		t.Fatal("replay did not wait on membership lock")
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
	if rec := <-waiting; rec.Code != 404 || strings.Contains(rec.Body.String(), ack.ID+`"`) {
		t.Fatal("removed editor reads command acknowledgement")
	}
	if err := sessions.RevokeAll(ctx, tokens[0].Token); err != nil {
		t.Fatal(err)
	}
	if rec := request(tokens[0].Token, "POST", path, body, key, `"2"`); rec.Code != 404 {
		t.Fatal("revoked session replays command")
	}
}
