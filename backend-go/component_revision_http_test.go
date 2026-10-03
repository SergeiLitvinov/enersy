package main

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"sync"
	"testing"
)

func TestExpectedComponentRevision(t *testing.T) {
	for _, tc := range []struct {
		tag      string
		status   int
		revision int64
	}{
		{"", 428, 0}, {`"1"`, 200, 1}, {`"9223372036854775807"`, 200, 9223372036854775807},
		{"1", 400, 0}, {`W/"1"`, 400, 0}, {"*", 400, 0}, {`"1", "2"`, 400, 0},
		{`"0"`, 400, 0}, {`"-1"`, 400, 0}, {`"01"`, 400, 0}, {`"+1"`, 400, 0},
		{`"1.0"`, 400, 0}, {`"9223372036854775808"`, 400, 0},
	} {
		t.Run(tc.tag, func(t *testing.T) {
			r := httptest.NewRequest(http.MethodPut, "/", nil)
			if tc.tag != "" {
				r.Header.Set("If-Match", tc.tag)
			}
			w := httptest.NewRecorder()
			revision, ok := expectedComponentRevision(w, r)
			if w.Code != tc.status || revision != tc.revision || ok != (tc.status == 200) {
				t.Fatalf("status=%d revision=%d ok=%v", w.Code, revision, ok)
			}
		})
	}
	request := httptest.NewRequest(http.MethodPut, "/", nil)
	request.Header.Add("If-Match", `"1"`)
	request.Header.Add("If-Match", `"2"`)
	if _, ok := expectedComponentRevision(httptest.NewRecorder(), request); ok {
		t.Fatal("accepted multiple headers")
	}
}

func TestComponentRevisionCORS(t *testing.T) {
	called := false
	handler := enableCORS(func(w http.ResponseWriter, r *http.Request) { called = true; componentMutationReply(w, 12, nil) })
	r := httptest.NewRequest("OPTIONS", "/api/ees/components/1", nil)
	r.Header.Set("Access-Control-Request-Headers", "content-type,if-match")
	w := httptest.NewRecorder()
	handler(w, r)
	if called || w.Code != 200 || !strings.Contains(w.Header().Get("Access-Control-Allow-Headers"), "If-Match") {
		t.Fatal(w.Code, w.Header(), called)
	}
	w = httptest.NewRecorder()
	handler(w, httptest.NewRequest("PUT", "/api/ees/components/1", nil))
	if !called || w.Header().Get("Access-Control-Expose-Headers") != "ETag" || w.Header().Get("ETag") != `"12"` {
		t.Fatal(w.Header(), called)
	}
}

func TestComponentRevisionHTTPPostgres(t *testing.T) {
	database := migrationTestDatabase(t)
	for _, name := range []string{"20260612001_init.up.sql", "20260612002_equipment_models.up.sql", "20260930001_component_model_snapshot.up.sql", "20260930002_connection_integrity.up.sql", "20261003001_component_revision.up.sql"} {
		executeFixture(t, database, filepath.Join("..", "database", "migrations", name))
	}
	var scheme, component int
	if err := database.QueryRow(`INSERT INTO circuit_schemes(name,description) VALUES('HTTP revision','') RETURNING id`).Scan(&scheme); err != nil {
		t.Fatal(err)
	}
	if err := database.QueryRow(`INSERT INTO scheme_components(scheme_id,component_type_id,pos_x,pos_y,rotation,custom_name)
	 VALUES($1,(SELECT id FROM component_types WHERE code='busbar'),0,0,0,'Bus') RETURNING id`, scheme).Scan(&component); err != nil {
		t.Fatal(err)
	}
	// The actual public routes are used, with a test-only schema connection.
	previous := db
	db = database
	t.Cleanup(func() { db = previous })
	request := func(method, tag, body string, params bool) *httptest.ResponseRecorder {
		path := fmt.Sprintf("/api/ees/components/%d", component)
		if params {
			path += "/params"
		}
		r := httptest.NewRequest(method, path, strings.NewReader(body))
		if tag != "" {
			r.Header.Set("If-Match", tag)
		}
		w := httptest.NewRecorder()
		handleComponentByIDOrParams(w, r)
		return w
	}
	pose := `{"x":10,"y":20,"rotation":90,"name":"Bus"}`
	for _, tc := range []struct {
		method, tag, body string
		params            bool
		status            int
	}{
		{"PUT", "", pose, false, 428}, {"DELETE", "", "", false, 428}, {"POST", "", `{"key":"p","value":"1"}`, true, 428},
		{"PUT", `"1"`, `{}`, false, 400}, {"PUT", `"1"`, pose + `{}`, false, 400},
		{"PUT", `"1"`, `{"x":1e100,"y":0,"rotation":0,"name":"Bus"}`, false, 400},
		{"POST", `"1"`, `{"key":"p","value":null}`, true, 400}, {"GET", `"1"`, "", false, 405},
		{"POST", `"1"`, `{"key":"p","value":"` + strings.Repeat("x", 1<<20) + `"}`, true, 413},
	} {
		if w := request(tc.method, tc.tag, tc.body, tc.params); w.Code != tc.status {
			t.Fatalf("%+v: %d %s", tc, w.Code, w.Body.String())
		}
	}
	// Two independently loaded clients race through the public route.
	start := make(chan struct{})
	responses := make(chan *httptest.ResponseRecorder, 2)
	var wg sync.WaitGroup
	for i := 0; i < 2; i++ {
		wg.Add(1)
		go func() { defer wg.Done(); <-start; responses <- request("PUT", `"1"`, pose, false) }()
	}
	close(start)
	wg.Wait()
	close(responses)
	statuses := map[int]int{}
	for w := range responses {
		statuses[w.Code]++
		if w.Code == 200 && w.Header().Get("ETag") != `"2"` {
			t.Fatal(w.Header())
		}
	}
	if statuses[200] != 1 || statuses[412] != 1 {
		t.Fatalf("race: %v", statuses)
	}
	if w := request("POST", `"1"`, `{"key":"p","value":"5"}`, true); w.Code != 412 {
		t.Fatal(w.Code)
	}
	var count int
	if err := database.QueryRow(`SELECT count(*) FROM scheme_component_params WHERE scheme_component_id=$1`, component).Scan(&count); err != nil || count != 0 {
		t.Fatalf("stale inserted: %d %v", count, err)
	}
	if w := request("POST", `"2"`, `{"key":"p","value":""}`, true); w.Code != 200 || w.Header().Get("ETag") != `"3"` {
		t.Fatal(w.Code, w.Body.String())
	}
	if w := request("POST", `"3"`, `{"key":"p","value":""}`, true); w.Code != 200 || w.Header().Get("ETag") != `"3"` {
		t.Fatal("no-op", w.Code, w.Body.String())
	}
	w := httptest.NewRecorder()
	handleSchemeByID(w, httptest.NewRequest("GET", fmt.Sprintf("/api/ees/schemes/%d", scheme), nil))
	var loaded struct {
		Components []struct {
			Revision string `json:"revision"`
		} `json:"components"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &loaded); err != nil || w.Code != 200 || len(loaded.Components) != 1 || loaded.Components[0].Revision != "3" {
		t.Fatal(w.Code, w.Body.String(), err)
	}
	if w := request("DELETE", `"2"`, "", false); w.Code != 412 {
		t.Fatal(w.Code)
	}
	if w := request("DELETE", `"3"`, "", false); w.Code != 200 {
		t.Fatal(w.Code, w.Body.String())
	}
	if w := request("DELETE", `"3"`, "", false); w.Code != 404 {
		t.Fatal(w.Code, w.Body.String())
	}
	// Creation returns the version after all parameter inserts, not a guessed 1.
	var typeID int
	if err := database.QueryRow(`SELECT id FROM component_types WHERE code='busbar'`).Scan(&typeID); err != nil {
		t.Fatal(err)
	}
	w = httptest.NewRecorder()
	body := fmt.Sprintf(`{"schemeId":%d,"typeId":%d,"x":0,"y":0,"rotation":0,"name":"New","params":{"voltage":"110"}}`, scheme, typeID)
	handleComponents(w, httptest.NewRequest("POST", "/api/ees/components", strings.NewReader(body)))
	var created struct {
		ID       int    `json:"id"`
		Revision string `json:"revision"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &created); err != nil || w.Code != 200 || created.ID <= 0 || created.Revision != "2" {
		t.Fatal(w.Code, w.Body.String(), err)
	}
	var saved string
	if err := database.QueryRow(`SELECT revision::text FROM scheme_components WHERE id=$1`, created.ID).Scan(&saved); err != nil || saved != created.Revision {
		t.Fatal(saved, err)
	}
	// Exact decimal tokens above JavaScript's safe-integer limit round-trip.
	if err := database.QueryRow(`INSERT INTO scheme_components(scheme_id,component_type_id,pos_x,pos_y,rotation,custom_name,revision)
	 VALUES($1,$2,0,0,0,'Large version',9007199254740993) RETURNING id`, scheme, typeID).Scan(&component); err != nil {
		t.Fatal(err)
	}
	if w := request("PUT", `"9007199254740993"`, pose, false); w.Code != 200 || w.Header().Get("ETag") != `"9007199254740994"` || !strings.Contains(w.Body.String(), `"revision":"9007199254740994"`) {
		t.Fatal(w.Code, w.Body.String())
	}
}
