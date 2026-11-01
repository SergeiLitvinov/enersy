package main

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strconv"
	"strings"
	"testing"
	"time"
)

func TestApplicationOperationCatalogPostgres(t *testing.T) {
	f := newStudyFixture(t)
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	service := applicationService{database: f.store.database}
	scope := readSchemeCommand{ProjectID: f.project, SchemeID: f.scheme}
	read := func(token string, expected *applicationIdentity) applicationOperationCatalog {
		t.Helper()
		input := scope
		input.ExpectedIdentity = expected
		catalog, err := service.ReadOperations(ctx, token, input)
		if err != nil || catalog.FormatVersion != 1 || catalog.ProjectID != strconv.FormatInt(f.project, 10) || catalog.SchemeID != strconv.Itoa(f.scheme) {
			t.Fatal("invalid scoped catalog", catalog, err)
		}
		return catalog
	}
	for _, actor := range []int{0, 1, 2} {
		catalog := read(f.tokens[actor].Token, &applicationIdentity{f.tokens[actor].Identity.AccountID, f.tokens[actor].Identity.SessionID})
		want := 2
		if actor == 2 {
			want = 1
		}
		if len(catalog.Operations) != want || catalog.Operations[0].ID != operationReadScheme || !catalog.Operations[0].ReadOnly {
			t.Fatal("catalog does not reflect actual role", catalog)
		}
		for _, operation := range catalog.Operations {
			if operation.ReturnsEngineeringResult || operation.InputSchema["additionalProperties"] != false {
				t.Fatal("catalog promises physical results or arbitrary arguments", operation)
			}
		}
	}
	for _, token := range []string{f.tokens[3].Token, "", "invalid"} {
		if catalog, err := service.ReadOperations(ctx, token, scope); !errors.Is(err, errProjectUnavailable) || !reflect.DeepEqual(catalog, applicationOperationCatalog{}) {
			t.Fatal("foreign discovery exposed operations", catalog, err)
		}
	}
	second, err := (sessionStore{database: f.store.database}).Issue(ctx, f.tokens[0].Identity.AccountID, time.Hour)
	if err != nil {
		t.Fatal(err)
	}
	read(second.Token, nil)
	mismatch := scope
	mismatch.ExpectedIdentity = &applicationIdentity{f.tokens[0].Identity.AccountID, f.tokens[0].Identity.SessionID}
	if _, err := service.ReadOperations(ctx, second.Token, mismatch); !errors.Is(err, errApplicationSessionChanged) {
		t.Fatal("discovery ignored expected session", err)
	}
	other, err := f.store.Create(ctx, f.tokens[0].Token, "Other authorized project")
	if err != nil {
		t.Fatal(err)
	}
	for _, wrong := range []readSchemeCommand{{ProjectID: other, SchemeID: f.scheme}, {SchemeID: f.scheme}, {ProjectID: f.project}} {
		if got, err := service.ReadOperations(ctx, f.tokens[0].Token, wrong); !errors.Is(err, errProjectUnavailable) || got.Operations != nil {
			t.Fatal("scope mismatch discovered commands", got, err)
		}
	}
	// A caller may mutate its returned JSON Schema. It cannot poison the next
	// session's registry, add a tool or change the actual write permission.
	mutated := read(f.tokens[0].Token, nil)
	mutated.Operations[0].InputSchema["properties"].(map[string]any)["sql"] = map[string]any{"type": "string"}
	mutated.Operations[1].HTTP.Headers["If-Match"] = operationHeader{Argument: "fake", Encoding: "raw-string"}
	clean := read(f.tokens[0].Token, nil)
	if len(clean.Operations[0].InputSchema["properties"].(map[string]any)) != 0 || clean.Operations[1].HTTP.Headers["If-Match"].Encoding != "strong-etag" {
		t.Fatal("caller changed the shared registry")
	}
	if _, err := f.store.ChangeMember(ctx, f.tokens[0].Token, f.project, f.tokens[1].Identity.AccountID, 2, "viewer", false); err != nil {
		t.Fatal(err)
	}
	if len(read(f.tokens[1].Token, nil).Operations) != 1 {
		t.Fatal("downgrade retained a write capability")
	}
	var typeID int
	if err := f.store.database.QueryRowContext(ctx, `SELECT id FROM component_types WHERE code='busbar'`).Scan(&typeID); err != nil {
		t.Fatal(err)
	}
	if _, err := service.CreateEquipment(ctx, f.tokens[1].Token, createEquipmentCommand{ProjectID: f.project, CommandID: studyCommand(950), ExpectedTopologyRevision: f.topology,
		Equipment: createComponentRequest{SchemeID: f.scheme, TypeID: typeID, Name: "Stale discovery"}}); !errors.Is(err, sql.ErrNoRows) {
		t.Fatal("previous discovery granted a later mutation", err)
	}
	if err := (sessionStore{database: f.store.database}).Revoke(ctx, second.Token, f.tokens[0].Identity.SessionID); err != nil {
		t.Fatal(err)
	}
	if got, err := service.ReadOperations(ctx, f.tokens[0].Token, scope); !errors.Is(err, errProjectUnavailable) || got.Operations != nil {
		t.Fatal("revoked session discovered operations", got, err)
	}
	read(second.Token, nil)
}

func TestApplicationOperationCatalogHTTPPostgres(t *testing.T) {
	f := newStudyFixture(t)
	auth := newAuthHTTP(f.store.database, "https://frontend.example", true)
	base := fmt.Sprintf("/api/projects/%d/schemes/%d", f.project, f.scheme)
	request := func(token, method, path string, body any, headers map[string]string) *httptest.ResponseRecorder {
		t.Helper()
		encoded, err := json.Marshal(body)
		if err != nil {
			t.Fatal(err)
		}
		r := httptest.NewRequest(method, path, strings.NewReader(string(encoded)))
		r.AddCookie(&http.Cookie{Name: auth.cookieName(), Value: token})
		r.Header.Set("Origin", auth.origin)
		r.Header.Set("Content-Type", "application/json")
		for key, value := range headers {
			r.Header.Set(key, value)
		}
		w := httptest.NewRecorder()
		(projectsHTTP{auth: auth}).ServeHTTP(w, r)
		if w.Header().Get("Cache-Control") != "no-store" {
			t.Fatal("scoped response may be cached")
		}
		return w
	}
	response := request(f.tokens[0].Token, "GET", base+"/operations", nil, nil)
	var catalog applicationOperationCatalog
	if response.Code != 200 || json.Unmarshal(response.Body.Bytes(), &catalog) != nil || len(catalog.Operations) != 2 {
		t.Fatal("HTTP catalog failed", response.Code, response.Body)
	}
	for _, token := range f.tokens {
		if strings.Contains(response.Body.String(), token.Token) {
			t.Fatal("discovery leaked a session token")
		}
	}
	// A real client follows the catalog's transport description. No separate
	// graph, write implementation or generic SQL/invoke endpoint is introduced.
	read := catalog.Operations[0]
	graph := request(f.tokens[0].Token, read.HTTP.Method, read.HTTP.Path, nil, map[string]string{"X-Enersy-Account-Id": strconv.FormatInt(f.tokens[0].Identity.AccountID, 10), "X-Enersy-Session-Id": strconv.FormatInt(f.tokens[0].Identity.SessionID, 10)})
	var snapshot schemeGraph[string]
	if graph.Code != 200 || json.Unmarshal(graph.Body.Bytes(), &snapshot) != nil || snapshot.ID != catalog.SchemeID || len(snapshot.Components) != 2 {
		t.Fatal("advertised read is not executable", graph.Code, graph.Body)
	}
	var typeID string
	if err := f.store.database.QueryRow(`SELECT id::text FROM component_types WHERE code='busbar'`).Scan(&typeID); err != nil {
		t.Fatal(err)
	}
	write := catalog.Operations[1]
	arguments := map[string]any{"commandId": studyCommand(951), "expectedTopologyRevision": snapshot.TopologyRevision,
		"equipment": map[string]any{"typeId": typeID, "name": "Catalog-driven creation", "x": 0, "y": 0, "rotation": 0, "params": map[string]string{}}}
	headers := map[string]string{}
	for header, mapping := range write.HTTP.Headers {
		value := arguments[mapping.Argument].(string)
		switch mapping.Encoding {
		case "raw-string":
		case "strong-etag":
			value = strconv.Quote(value)
		default:
			t.Fatal("unknown encoding", mapping)
		}
		headers[header] = value
	}
	created := request(f.tokens[0].Token, write.HTTP.Method, write.HTTP.Path, arguments[write.HTTP.BodyArgument], headers)
	replayed := request(f.tokens[0].Token, write.HTTP.Method, write.HTTP.Path, arguments[write.HTTP.BodyArgument], headers)
	if created.Code != 201 || replayed.Code != 201 || created.Body.String() != replayed.Body.String() || replayed.Header().Get("Idempotency-Replayed") != "true" {
		t.Fatal("advertised durable command failed", created.Code, created.Body, replayed.Code, replayed.Body)
	}
	for _, tc := range []struct {
		path, method string
		headers      map[string]string
		status       int
	}{
		{base + "/operations", "POST", nil, 405}, {base + "/operations/unknown", "GET", nil, 404},
		{base + "/operations?actor=1", "GET", nil, 404},
		{base + "/operations", "GET", map[string]string{"X-Enersy-Account-Id": "1"}, 400},
		{base, "GET", map[string]string{"X-Enersy-Account-Id": "1"}, 400},
		{base, "GET", map[string]string{"X-Enersy-Account-Id": "9007199254740993", "X-Enersy-Session-Id": "9007199254740994"}, 409},
		{base + "/operations", "GET", map[string]string{"X-Enersy-Account-Id": "9007199254740993", "X-Enersy-Session-Id": "9007199254740994"}, 409},
	} {
		if got := request(f.tokens[0].Token, tc.method, tc.path, nil, tc.headers); got.Code != tc.status {
			t.Fatal("invalid discovery admitted", tc, got.Code, got.Body)
		}
	}
	if got := request(f.tokens[3].Token, "GET", base+"/operations", nil, nil); got.Code != 404 {
		t.Fatal("foreign discovery available", got.Code)
	}
}
