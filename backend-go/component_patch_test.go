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

func TestComponentPatchValidation(t *testing.T) {
	for _, body := range []string{
		`{}`, `{"pose":{}}`, `{"params":{}}`, `{"pose":null,"params":{"p":"1"}}`,
		`{"pose":{"x":null}}`, `{"pose":{"x": null }}`, `{"pose":{"x":"0"}}`,
		`{"pose":{"x":1e100}}`, `{"pose":{"rotation":1.5}}`, `{"pose":{"rotation":2147483648}}`,
		`{"pose":{"name":""}}`, `{"pose":{"name":"\u0000"}}`, `{"pose":{"unknown":1}}`,
		`{"params":null}`, `{"params":{"p":null}}`, `{"params":{"p":10}}`, `{"params":{"":"1"}}`,
	} {
		var request componentPatchRequest
		if err := json.Unmarshal([]byte(body), &request); err != nil {
			t.Fatal(err)
		}
		if _, err := parseComponentPatch(request); err == nil {
			t.Fatalf("accepted %s", body)
		}
	}
	var request componentPatchRequest
	json.Unmarshal([]byte(`{"pose":{"x":0,"rotation":0},"params":{"p":""}}`), &request)
	patch, err := parseComponentPatch(request)
	if err != nil || patch.X == nil || *patch.X != 0 || patch.Rotation == nil || *patch.Rotation != 0 || patch.Y != nil || patch.Params["p"] != "" {
		t.Fatalf("zero/empty patch: %+v %v", patch, err)
	}
}

func TestComponentPatchHTTPPostgres(t *testing.T) {
	database := migrationTestDatabase(t)
	for _, name := range []string{"20260612001_init.up.sql", "20260612002_equipment_models.up.sql", "20260930001_component_model_snapshot.up.sql", "20260930002_connection_integrity.up.sql", "20261003001_component_revision.up.sql"} {
		executeFixture(t, database, filepath.Join("..", "database", "migrations", name))
	}
	var scheme, component int
	if err := database.QueryRow(`INSERT INTO circuit_schemes(name,description) VALUES('Patch fixture','') RETURNING id`).Scan(&scheme); err != nil {
		t.Fatal(err)
	}
	if err := database.QueryRow(`INSERT INTO scheme_components(scheme_id,component_type_id,pos_x,pos_y,rotation,custom_name)
	 VALUES($1,(SELECT id FROM component_types WHERE code='busbar'),100,200,90,'Server name') RETURNING id`, scheme).Scan(&component); err != nil {
		t.Fatal(err)
	}
	previous := db
	db = database
	t.Cleanup(func() { db = previous })
	request := func(tag, body string) *httptest.ResponseRecorder {
		r := httptest.NewRequest("PATCH", fmt.Sprintf("/api/ees/components/%d", component), strings.NewReader(body))
		if tag != "" {
			r.Header.Set("If-Match", tag)
		}
		w := httptest.NewRecorder()
		handleComponentByIDOrParams(w, r)
		return w
	}
	read := func() (int64, float64, float64, int, string) {
		t.Helper()
		var revision int64
		var x, y float64
		var rotation int
		var name string
		if err := database.QueryRow(`SELECT revision,pos_x,pos_y,rotation,custom_name FROM scheme_components WHERE id=$1`, component).Scan(&revision, &x, &y, &rotation, &name); err != nil {
			t.Fatal(err)
		}
		return revision, x, y, rotation, name
	}
	if w := request("", `{"pose":{"x":20}}`); w.Code != 428 {
		t.Fatal(w.Code)
	}
	if w := request(`"1"`, `{"pose":{"x":20},"params":{"p":null}}`); w.Code != 400 {
		t.Fatal(w.Code, w.Body.String())
	}
	if w := request(`"1"`, `{"pose":{"x":20},"params":{"p":"10","q":""}}`); w.Code != 200 || w.Header().Get("ETag") != `"4"` {
		t.Fatal(w.Code, w.Body.String())
	}
	revision, x, y, rotation, name := read()
	if revision != 4 || x != 20 || y != 200 || rotation != 90 || name != "Server name" {
		t.Fatalf("unselected fields changed: %d %v %v %d %s", revision, x, y, rotation, name)
	}
	if w := request(`"1"`, `{"pose":{"x":30},"params":{"p":"99"}}`); w.Code != 412 {
		t.Fatal(w.Code)
	}
	var p string
	if err := database.QueryRow(`SELECT param_value FROM scheme_component_params WHERE scheme_component_id=$1 AND param_key='p'`, component).Scan(&p); err != nil || p != "10" {
		t.Fatal(p, err)
	}
	// Failure on the second parameter rolls back the geometry and first parameter.
	if _, err := database.Exec(`CREATE FUNCTION reject_patch_parameter() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
	 IF NEW.param_key='z_fail' THEN RAISE EXCEPTION 'injected failure'; END IF; RETURN NEW; END $$;
	 CREATE TRIGGER reject_patch BEFORE INSERT OR UPDATE ON scheme_component_params FOR EACH ROW EXECUTE FUNCTION reject_patch_parameter()`); err != nil {
		t.Fatal(err)
	}
	w := request(`"4"`, `{"pose":{"x":30},"params":{"a_first":"1","z_fail":"2"}}`)
	if w.Code != 500 || strings.Contains(w.Body.String(), "injected") {
		t.Fatal(w.Code, w.Body.String())
	}
	revision, x, _, _, _ = read()
	var count int
	if err := database.QueryRow(`SELECT count(*) FROM scheme_component_params WHERE scheme_component_id=$1 AND param_key='a_first'`, component).Scan(&count); err != nil || count != 0 || revision != 4 || x != 20 {
		t.Fatalf("partial commit: count=%d revision=%d x=%v err=%v", count, revision, x, err)
	}
	// No-op parameter does not assume revision increments by one.
	if w := request(`"4"`, `{"params":{"p":"10"}}`); w.Code != 200 || w.Header().Get("ETag") != `"4"` {
		t.Fatal(w.Code, w.Body.String())
	}
	start := make(chan struct{})
	responses := make(chan *httptest.ResponseRecorder, 2)
	var wg sync.WaitGroup
	for _, value := range []int{300, 400} {
		wg.Add(1)
		go func(value int) {
			defer wg.Done()
			<-start
			responses <- request(`"4"`, fmt.Sprintf(`{"pose":{"x":%d},"params":{"p":"%d"}}`, value, value))
		}(value)
	}
	close(start)
	wg.Wait()
	close(responses)
	statuses := map[int]int{}
	for response := range responses {
		statuses[response.Code]++
	}
	if statuses[200] != 1 || statuses[412] != 1 {
		t.Fatal(statuses)
	}
	revision, x, y, rotation, name = read()
	if err := database.QueryRow(`SELECT param_value FROM scheme_component_params WHERE scheme_component_id=$1 AND param_key='p'`, component).Scan(&p); err != nil || p != fmt.Sprint(x) || revision != 6 || y != 200 || rotation != 90 || name != "Server name" {
		t.Fatalf("mixed patch: revision=%d x=%v p=%s err=%v", revision, x, p, err)
	}
	// The public CORS preflight permits the new atomic operation.
	w = httptest.NewRecorder()
	enableCORS(handleComponentByIDOrParams)(w, httptest.NewRequest(http.MethodOptions, "/api/ees/components/1", nil))
	if !strings.Contains(w.Header().Get("Access-Control-Allow-Methods"), "PATCH") {
		t.Fatal(w.Header())
	}
}
