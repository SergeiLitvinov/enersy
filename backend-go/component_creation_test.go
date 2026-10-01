package main

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"math"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestComponentCreationValidation(t *testing.T) {
	valid := createComponentRequest{SchemeID: 1, TypeID: 1, Name: "Источник", Params: map[string]string{"p": ""}}
	if err := validateComponentCreation(valid); err != nil {
		t.Fatal(err)
	}
	for _, mutate := range []func(*createComponentRequest){
		func(r *createComponentRequest) { r.TypeID = -1 },
		func(r *createComponentRequest) { r.Name = strings.Repeat("я", 101) },
		func(r *createComponentRequest) { r.X = math.Inf(1) },
		func(r *createComponentRequest) { r.Params = map[string]string{strings.Repeat("я", 51): "1"} },
		func(r *createComponentRequest) { id := 0; r.EquipmentModelID = &id },
	} {
		req := valid
		mutate(&req)
		if validateComponentCreation(req) == nil {
			t.Fatalf("accepted invalid request: %+v", req)
		}
	}
}

// Integration tests own a unique schema. They never touch application tables.
func TestComponentCreationPostgres(t *testing.T) {
	dsn := os.Getenv("TEST_DATABASE_URL")
	if dsn == "" {
		t.Skip("Set TEST_DATABASE_URL for PostgreSQL integration tests")
	}
	admin, err := sql.Open("postgres", dsn)
	if err != nil {
		t.Fatal(err)
	}
	defer admin.Close()
	schema := fmt.Sprintf("enersy_test_%d", time.Now().UnixNano())
	if _, err = admin.Exec(`CREATE SCHEMA "` + schema + `"`); err != nil {
		t.Fatal(err)
	}
	defer admin.Exec(`DROP SCHEMA "` + schema + `" CASCADE`)
	database, err := sql.Open("postgres", dsn+" search_path="+schema)
	if err != nil {
		t.Fatal(err)
	}
	defer database.Close()
	for _, name := range []string{"20260612001_init.up.sql", "20260612002_equipment_models.up.sql", "20260930001_component_model_snapshot.up.sql", "20260930001_component_model_snapshot.up.sql", "20260930002_connection_integrity.up.sql"} {
		data, err := os.ReadFile(filepath.Join("..", "database", "migrations", name))
		if err != nil {
			t.Fatal(err)
		}
		if _, err = database.Exec(string(data)); err != nil {
			t.Fatalf("%s: %v", name, err)
		}
	}
	var schemeID, typeID, modelID, otherType int
	if err = database.QueryRow("INSERT INTO circuit_schemes(name,description) VALUES('Integration fixture','') RETURNING id").Scan(&schemeID); err != nil {
		t.Fatal(err)
	}
	if err = database.QueryRow("SELECT id FROM component_types WHERE code='generator'").Scan(&typeID); err != nil {
		t.Fatal(err)
	}
	if err = database.QueryRow("SELECT id FROM component_types WHERE code='transformer'").Scan(&otherType); err != nil {
		t.Fatal(err)
	}
	if err = database.QueryRow("SELECT id FROM equipment_models WHERE component_type_id=$1 ORDER BY id LIMIT 1", typeID).Scan(&modelID); err != nil {
		t.Fatal(err)
	}
	req := createComponentRequest{SchemeID: schemeID, TypeID: typeID, Name: "Источник", EquipmentModelID: &modelID, Params: map[string]string{"p": "12.5"}}
	id, params, err := createComponent(context.Background(), database, req)
	if err != nil {
		t.Fatal(err)
	}
	if params["p"] != "12.5" || len(params) < 2 {
		t.Fatalf("passport snapshot not copied: %v", params)
	}
	var savedModel int
	if err = database.QueryRow("SELECT equipment_model_id FROM scheme_components WHERE id=$1", id).Scan(&savedModel); err != nil || savedModel != modelID {
		t.Fatalf("model reference: %d %v", savedModel, err)
	}
	// Changing the catalogue does not silently rewrite an existing instance.
	if _, err = database.Exec("UPDATE equipment_model_params SET param_value='999' WHERE equipment_model_id=$1 AND param_key='voltage_nom'", modelID); err != nil {
		t.Fatal(err)
	}
	var voltage string
	if err = database.QueryRow("SELECT param_value FROM scheme_component_params WHERE scheme_component_id=$1 AND param_key='voltage_nom'", id).Scan(&voltage); err != nil || voltage != params["voltage_nom"] {
		t.Fatal("snapshot changed", err)
	}
	wrong := req
	wrong.TypeID = otherType
	if _, _, err = createComponent(context.Background(), database, wrong); err == nil {
		t.Fatal("wrong model type accepted")
	}
	// Force a failure AFTER insertion of the component and an earlier parameter.
	if _, err = database.Exec("ALTER TABLE scheme_component_params ADD CONSTRAINT test_reject_value CHECK(param_value <> 'reject-new-param')"); err != nil {
		t.Fatal(err)
	}
	failed := req
	failed.Params = map[string]string{"a_first": "ok", "z_fail": "reject-new-param"}
	if _, _, err = createComponent(context.Background(), database, failed); err == nil {
		t.Fatal("forced write failure accepted")
	}
	var count int
	if err = database.QueryRow("SELECT count(*) FROM scheme_components").Scan(&count); err != nil || count != 1 {
		t.Fatalf("partial component survived: %d %v", count, err)
	}
	if err = database.QueryRow("SELECT count(*) FROM scheme_component_params WHERE param_key='a_first'").Scan(&count); err != nil || count != 0 {
		t.Fatalf("partial parameter survived: %d %v", count, err)
	}
	// The real reload endpoint must preserve parameters, passport provenance and wire IDs.
	var wireID int
	if err = database.QueryRow("INSERT INTO scheme_connections(scheme_id,from_component_id,to_component_id,from_port,to_port) VALUES($1,$2,$2,'top','bottom') RETURNING id", schemeID, id).Scan(&wireID); err != nil {
		t.Fatal(err)
	}
	previous := db
	db = database
	defer func() { db = previous }()
	rec := httptest.NewRecorder()
	handleSchemeByID(rec, httptest.NewRequest(http.MethodGet, fmt.Sprintf("/api/ees/schemes/%d", schemeID), nil))
	if rec.Code != 200 {
		t.Fatal(rec.Body.String())
	}
	var response struct {
		Components []struct {
			Params  map[string]string `json:"params"`
			ModelID int               `json:"equipmentModelId"`
		} `json:"components"`
		Connections []struct {
			ID int `json:"id"`
		} `json:"connections"`
	}
	if err = json.Unmarshal(rec.Body.Bytes(), &response); err != nil || len(response.Components) != 1 || response.Components[0].ModelID != modelID || response.Components[0].Params["p"] != "12.5" {
		t.Fatalf("reload loses data: %s %v", rec.Body.String(), err)
	}
	if len(response.Connections) != 1 || response.Connections[0].ID != wireID {
		t.Fatalf("wire ID lost: %s", rec.Body.String())
	}
}
