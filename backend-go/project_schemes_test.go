package main

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"
	"time"
)

func TestProjectSchemesAndLegacyIsolationPostgres(t *testing.T) {
	database := migrationTestDatabase(t)
	if err := runMigrationsFromSource(database, migrationSourceURL(t)); err != nil {
		t.Fatal(err)
	}
	previous := db
	db = database
	defer func() { db = previous }()
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	sessions := sessionStore{database: database}
	store := projectStore{database: database}
	var accounts [3]int64
	var tokens [3]issuedSession
	for i := range accounts {
		if err := database.QueryRowContext(ctx, `INSERT INTO auth_accounts(display_name) VALUES('Scheme fixture') RETURNING id`).Scan(&accounts[i]); err != nil {
			t.Fatal(err)
		}
		var err error
		tokens[i], err = sessions.Issue(ctx, accounts[i], time.Hour)
		if err != nil {
			t.Fatal(err)
		}
	}
	project, err := store.Create(ctx, tokens[0].Token, "Private project")
	if err != nil {
		t.Fatal(err)
	}
	foreign, err := store.Create(ctx, tokens[1].Token, "Other project")
	if err != nil {
		t.Fatal(err)
	}
	auth := newAuthHTTP(database, "https://frontend.example", true)
	handler := projectsHTTP{auth: auth}
	base := fmt.Sprintf("/api/projects/%d/schemes", project)
	request := func(target http.HandlerFunc, token, method, path, body string) *httptest.ResponseRecorder {
		t.Helper()
		req := httptest.NewRequest(method, path, strings.NewReader(body)).WithContext(ctx)
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("Origin", auth.origin)
		if token != "" {
			req.AddCookie(&http.Cookie{Name: auth.cookieName(), Value: token})
		}
		rec := httptest.NewRecorder()
		target(rec, req)
		return rec
	}
	list := request(handler.ServeHTTP, tokens[0].Token, "GET", base, "")
	if list.Code != 200 || !strings.Contains(list.Body.String(), `"items":[]`) {
		t.Fatal("valid empty project list")
	}
	for _, token := range []string{tokens[1].Token, tokens[2].Token} {
		if rec := request(handler.ServeHTTP, token, "GET", base, ""); rec.Code != 404 {
			t.Fatal("foreign project list accessible")
		}
	}
	rec := request(handler.ServeHTTP, tokens[0].Token, "POST", base, `{"name":"Private scheme","description":"Secret fixture"}`)
	var created struct {
		ID string `json:"id"`
	}
	if rec.Code != 201 || json.Unmarshal(rec.Body.Bytes(), &created) != nil {
		t.Fatal("private scheme creation failed")
	}
	scheme, err := strconv.Atoi(created.ID)
	if err != nil || scheme <= 0 {
		t.Fatal("invalid private ID")
	}
	if rec := request(handler.ServeHTTP, tokens[0].Token, "POST", base, `{"name":"Bad owner","ownerId":"1"}`); rec.Code != 400 {
		t.Fatal("client owner accepted")
	}
	if _, err := store.ChangeMember(ctx, tokens[0].Token, project, accounts[1], 0, "viewer", false); err != nil {
		t.Fatal(err)
	}
	if rec := request(handler.ServeHTTP, tokens[1].Token, "POST", base, `{"name":"Unauthorized"}`); rec.Code != 404 {
		t.Fatal("viewer writes schema")
	}
	if _, err := store.ChangeMember(ctx, tokens[0].Token, project, accounts[1], 1, "editor", false); err != nil {
		t.Fatal(err)
	}
	if rec := request(handler.ServeHTTP, tokens[1].Token, "POST", base, `{"name":"Editor scheme"}`); rec.Code != 201 {
		t.Fatal("editor cannot create")
	}
	// Equipment is inserted by a trusted fixture; its protected write API is a later step.
	var first, second, connection int
	for _, id := range []*int{&first, &second} {
		if err := database.QueryRowContext(ctx, `INSERT INTO scheme_components(scheme_id,component_type_id,pos_x,pos_y,rotation,custom_name) SELECT $1,id,0,0,0,'Private bus' FROM component_types WHERE code='busbar' RETURNING id`, scheme).Scan(id); err != nil {
			t.Fatal(err)
		}
	}
	if err := database.QueryRowContext(ctx, `INSERT INTO scheme_connections(scheme_id,from_component_id,to_component_id,from_port,to_port) VALUES($1,$2,$3,'right','left') RETURNING id`, scheme, first, second).Scan(&connection); err != nil {
		t.Fatal(err)
	}
	if _, err := database.ExecContext(ctx, `INSERT INTO scheme_component_params(scheme_component_id,param_key,param_value) VALUES($1,'voltage_nom','110')`, first); err != nil {
		t.Fatal(err)
	}
	path := base + "/" + created.ID
	rec = request(handler.ServeHTTP, tokens[1].Token, "GET", path, "")
	var snapshot map[string]any
	if rec.Code != 200 || json.Unmarshal(rec.Body.Bytes(), &snapshot) != nil || snapshot["id"] != created.ID || snapshot["projectId"] != strconv.FormatInt(project, 10) {
		t.Fatal("protected graph invalid")
	}
	if _, exists := snapshot["owner_id"]; exists {
		t.Fatal("demo owner leaked into private domain")
	}
	components := snapshot["components"].([]any)
	connections := snapshot["connections"].([]any)
	if len(components) != 2 || len(connections) != 1 {
		t.Fatal("graph snapshot incomplete")
	}
	if _, ok := components[0].(map[string]any)["id"].(string); !ok {
		t.Fatal("component ID not string")
	}
	if _, ok := connections[0].(map[string]any)["from"].(string); !ok {
		t.Fatal("endpoint ID not string")
	}
	if rec := request(handler.ServeHTTP, tokens[1].Token, "GET", fmt.Sprintf("/api/projects/%d/schemes/%d", foreign, scheme), ""); rec.Code != 404 {
		t.Fatal("foreign parent authorized unrelated scheme")
	}
	if rec := request(handler.ServeHTTP, tokens[2].Token, "GET", path, ""); rec.Code != 404 {
		t.Fatal("foreign user reads graph")
	}
	// Old public routes must not bypass private project rights, even with a valid owner cookie.
	legacyPath := fmt.Sprintf("/api/ees/schemes/%d", scheme)
	for _, method := range []string{"GET", "PUT", "DELETE"} {
		if rec := request(handleSchemeByID, tokens[0].Token, method, legacyPath, `{"name":"Corruption","description":""}`); rec.Code != 404 {
			t.Fatalf("legacy %s bypass: %d", method, rec.Code)
		}
	}
	if rec := request(handleSchemes, "", "GET", "/api/ees/schemes", ""); rec.Code != 200 || strings.Contains(rec.Body.String(), "Private scheme") {
		t.Fatal("legacy list leaked private name")
	}
	var typeID int
	if err := database.QueryRowContext(ctx, `SELECT id FROM component_types WHERE code='busbar'`).Scan(&typeID); err != nil {
		t.Fatal(err)
	}
	if _, _, _, err := createComponent(ctx, database, createComponentRequest{SchemeID: scheme, TypeID: typeID, Name: "Bad write"}); err == nil {
		t.Fatal("legacy component creation in private scheme")
	}
	if _, err := mutateComponentRevision(ctx, database, first, 1, func(tx *sql.Tx) error {
		_, err := tx.ExecContext(ctx, `DELETE FROM scheme_components WHERE id=$1`, first)
		return err
	}, true); !errors.Is(err, sql.ErrNoRows) {
		t.Fatal("legacy component mutation in private scheme")
	}
	for _, target := range []http.HandlerFunc{handleConnections, handleConnectionCommands} {
		req := httptest.NewRequest("POST", "/api/ees/connections", strings.NewReader(fmt.Sprintf(`{"schemeId":%d,"from":%d,"to":%d,"fromPort":"right","toPort":"left"}`, scheme, first, second))).WithContext(ctx)
		req.Header.Set("Idempotency-Key", "a1111111-1111-4111-8111-111111111111")
		rec := httptest.NewRecorder()
		target(rec, req)
		if rec.Code != 404 {
			t.Fatal("legacy connection or replay route bypass")
		}
	}
	if rec := request(handleConnectionByID, "", "DELETE", fmt.Sprintf("/api/ees/connections/%d", connection), ""); rec.Code != 404 {
		t.Fatal("legacy connection delete bypass")
	}
	if _, err := readCalculationInput(ctx, database, scheme); !errors.Is(err, sql.ErrNoRows) {
		t.Fatal("legacy calculation bypass")
	}
	// A queued creation must recheck a writer demoted while it waits.
	blocker, err := database.BeginTx(ctx, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer blocker.Rollback()
	var blockerPID int
	if err := blocker.QueryRowContext(ctx, `SELECT pg_backend_pid() FROM projects WHERE id=$1 FOR UPDATE`, project).Scan(&blockerPID); err != nil {
		t.Fatal(err)
	}
	waiting := make(chan error, 1)
	go func() {
		_, err := store.CreateScheme(ctx, tokens[1].Token, project, "Must not commit", "")
		waiting <- err
	}()
	blocked := false
	deadline := time.Now().Add(4 * time.Second)
	for time.Now().Before(deadline) {
		if err := database.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid)))`, blockerPID).Scan(&blocked); err != nil {
			t.Fatal(err)
		}
		if blocked {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	if !blocked {
		t.Fatal("scheme creation did not wait for membership lock")
	}
	if _, err := blocker.ExecContext(ctx, `UPDATE project_members SET role='viewer' WHERE project_id=$1 AND account_id=$2`, project, accounts[1]); err != nil {
		t.Fatal(err)
	}
	if _, err := blocker.ExecContext(ctx, `UPDATE projects SET membership_revision=membership_revision+1 WHERE id=$1`, project); err != nil {
		t.Fatal(err)
	}
	if err := blocker.Commit(); err != nil {
		t.Fatal(err)
	}
	if err := <-waiting; !errors.Is(err, errProjectUnavailable) {
		t.Fatalf("demoted writer created a scheme: %v", err)
	}
	if _, err := store.ChangeMember(ctx, tokens[0].Token, project, accounts[1], 3, "", true); err != nil {
		t.Fatal(err)
	}
	if rec := request(handler.ServeHTTP, tokens[1].Token, "GET", path, ""); rec.Code != 404 {
		t.Fatal("removed member reads graph")
	}
	if err := sessions.RevokeAll(ctx, tokens[0].Token); err != nil {
		t.Fatal(err)
	}
	if rec := request(handler.ServeHTTP, tokens[0].Token, "GET", path, ""); rec.Code != 404 {
		t.Fatal("revoked session reads graph")
	}
}
