package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"math"
	"net/http"
	"net/http/httptest"
	"os"
	"strconv"
	"testing"
	"time"
)

// Use only a disposable PostgreSQL schema and an explicitly selected worker.
// This proves the real response survives storage, not a new physical benchmark.
func TestCalculationArchiveWorkerPostgres(t *testing.T) {
	worker := os.Getenv("TEST_JULIA_URL")
	if worker == "" {
		t.Skip("Set TEST_JULIA_URL for real-worker archive acceptance")
	}
	database := migrationTestDatabase(t)
	if err := runMigrationsFromSource(database, migrationSourceURL(t)); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 45*time.Second)
	defer cancel()
	var account int64
	if err := database.QueryRowContext(ctx, `INSERT INTO auth_accounts(display_name) VALUES('Archive worker fixture') RETURNING id`).Scan(&account); err != nil {
		t.Fatal(err)
	}
	token, err := (sessionStore{database: database}).Issue(ctx, account, time.Hour)
	if err != nil {
		t.Fatal(err)
	}
	store := projectStore{database: database}
	project, err := store.Create(ctx, token.Token, "Worker archive")
	if err != nil {
		t.Fatal(err)
	}
	scheme, err := store.CreateScheme(ctx, token.Token, project, "Source–line–load", "")
	if err != nil {
		t.Fatal(err)
	}
	components := []struct {
		code   string
		params map[string]string
	}{
		{"generator", map[string]string{"p": "10", "e": "10", "r": "0.1", "x": "0.5", "voltage_nom": "10"}},
		{"transmission_line", map[string]string{"length": "1", "r0": "0.1", "x0": "0.5", "voltage_nom": "10"}},
		{"load", map[string]string{"p": "10", "q": "3", "voltage_nom": "10"}},
	}
	var ids [3]int64
	for i, c := range components {
		if i == 0 {
			doc := passportFixture()
			doc.Parameters = map[string]passportParameter{"p": {Value: "9", Unit: "МВт"}, "e": {Value: "10", Unit: "кВ"}, "r": {Value: "0.1", Unit: "Ом"}, "x": {Value: "0.5", Unit: "Ом"}, "voltage_nom": {Value: "10", Unit: "кВ"}}
			source, err := store.SavePassport(ctx, token.Token, project, "11111111-0000-4000-8000-000000000001", nil, doc)
			if err != nil {
				t.Fatal(err)
			}
			version, _ := strconv.ParseInt(source.ID, 10, 64)
			var typeID int
			if err := database.QueryRowContext(ctx, `SELECT id FROM component_types WHERE code='generator'`).Scan(&typeID); err != nil {
				t.Fatal(err)
			}
			id, _, _, err := store.CreateComponent(ctx, token.Token, project, createComponentRequest{SchemeID: int(scheme), TypeID: typeID, Name: "Source", Y: 100, ProjectPassportVersionID: &version, Params: map[string]string{"p": "10"}})
			if err != nil {
				t.Fatal(err)
			}
			ids[i] = int64(id)
			continue
		}
		if err := database.QueryRowContext(ctx, `INSERT INTO scheme_components(scheme_id,component_type_id,pos_x,pos_y,rotation)
 SELECT $1,id,$2,100,0 FROM component_types WHERE code=$3 RETURNING id`, scheme, i*100, c.code).Scan(&ids[i]); err != nil {
			t.Fatal(err)
		}
		for key, value := range c.params {
			if _, err := database.ExecContext(ctx, `INSERT INTO scheme_component_params(scheme_component_id,param_key,param_value) VALUES($1,$2,$3)`, ids[i], key, value); err != nil {
				t.Fatal(err)
			}
		}
	}
	if _, err := database.ExecContext(ctx, `INSERT INTO scheme_connections(scheme_id,from_component_id,to_component_id,from_port,to_port)
 VALUES($1,$2,$3,'bottom','left'),($1,$3,$4,'right','top')`, scheme, ids[0], ids[1], ids[2]); err != nil {
		t.Fatal(err)
	}
	var revision int64
	if err := database.QueryRowContext(ctx, `SELECT topology_revision FROM circuit_schemes WHERE id=$1`, scheme).Scan(&revision); err != nil {
		t.Fatal(err)
	}
	auth := newAuthHTTP(database, "http://localhost:4174", false)
	handler := projectsHTTP{auth: auth, workerURL: worker}
	path := fmt.Sprintf("/api/projects/%d/schemes/%d/archive-calculation?modelGroup=three-phase&method=newton-raphson", project, scheme)
	request := httptest.NewRequest("POST", path, nil)
	request.Header.Set("Origin", auth.origin)
	request.Header.Set("If-Match", `"`+strconv.FormatInt(revision, 10)+`"`)
	request.AddCookie(&http.Cookie{Name: auth.cookieName(), Value: token.Token})
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if response.Code != 200 {
		t.Fatalf("real-worker archive %d: %s", response.Code, response.Body.String())
	}
	id, err := strconv.ParseInt(response.Header().Get("X-Enersy-Archive-Id"), 10, 64)
	if err != nil {
		t.Fatal("missing archive", err)
	}
	var result struct {
		Success  bool              `json:"success"`
		Branches []json.RawMessage `json:"branches"`
		Balance  struct {
			P float64 `json:"residual_p_mw"`
			Q float64 `json:"residual_q_mvar"`
		} `json:"balance"`
	}
	if json.Unmarshal(response.Body.Bytes(), &result) != nil || !result.Success || len(result.Branches) != 2 || math.Abs(result.Balance.P) > 1e-6 || math.Abs(result.Balance.Q) > 1e-6 {
		t.Fatal("unexpected real response", response.Body.String())
	}
	metadata, input, saved, err := store.CalculationArchive(ctx, token.Token, project, id)
	if err != nil || !bytes.Equal(saved, response.Body.Bytes()) || metadata.TopologyRevision != strconv.FormatInt(revision, 10) || metadata.InputSHA256 != response.Header().Get("X-Enersy-Input-SHA256") {
		t.Fatal("real response was changed in storage", err)
	}
	var provenance calculationProvenance
	if json.Unmarshal(metadata.provenance, &provenance) != nil || len(provenance.Components) != 3 || provenance.Components[0].Passport == nil ||
		provenance.Components[0].Passport.Document.Parameters["p"].Value != "9" || metadata.ProvenanceSHA256 != archiveDigest(metadata.provenance) {
		t.Fatal("real calculation lost passport evidence")
	}
	var snapshot struct {
		Components []calculationComponent `json:"components"`
	}
	if err := json.Unmarshal(input, &snapshot); err != nil || len(snapshot.Components) != 3 || snapshot.Components[2].Params["p"] != "10" {
		t.Fatal("missing captured parameters", err)
	}
	if _, err := database.ExecContext(ctx, `UPDATE scheme_component_params SET param_value='999' WHERE scheme_component_id=$1 AND param_key='p'`, ids[2]); err != nil {
		t.Fatal(err)
	}
	_, laterInput, laterResult, err := store.CalculationArchive(ctx, token.Token, project, id)
	if err != nil || !bytes.Equal(input, laterInput) || !bytes.Equal(saved, laterResult) {
		t.Fatal("later parameter edit changed archived calculation", err)
	}
	t.Logf("real worker: archive %d, exact input %d bytes, exact result %d bytes, residual P=%g MW Q=%g Mvar", id, len(input), len(saved), result.Balance.P, result.Balance.Q)
}
