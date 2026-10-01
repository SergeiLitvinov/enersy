package main

import (
	"database/sql"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestConnectionsPostgres(t *testing.T) {
	dsn := os.Getenv("TEST_DATABASE_URL")
	if dsn == "" {
		t.Skip("Set TEST_DATABASE_URL for PostgreSQL integration")
	}
	admin, err := sql.Open("postgres", dsn)
	if err != nil {
		t.Fatal(err)
	}
	defer admin.Close()
	schema := fmt.Sprintf("enersy_connection_test_%d", time.Now().UnixNano())
	if _, err = admin.Exec(`CREATE SCHEMA "` + schema + `"`); err != nil {
		t.Fatal(err)
	}
	defer admin.Exec(`DROP SCHEMA "` + schema + `" CASCADE`)
	database, err := sql.Open("postgres", dsn+" search_path="+schema)
	if err != nil {
		t.Fatal(err)
	}
	defer database.Close()
	for _, name := range []string{"20260612001_init.up.sql", "20260612002_equipment_models.up.sql", "20260930001_component_model_snapshot.up.sql", "20260930002_connection_integrity.up.sql", "20260930002_connection_integrity.up.sql"} {
		data, err := os.ReadFile(filepath.Join("..", "database", "migrations", name))
		if err != nil {
			t.Fatal(err)
		}
		if _, err = database.Exec(string(data)); err != nil {
			t.Fatal(name, err)
		}
	}
	previous := db
	db = database
	defer func() { db = previous }()
	var scheme, otherScheme int
	if err = database.QueryRow("INSERT INTO circuit_schemes(name,description) VALUES('Network fixture','') RETURNING id").Scan(&scheme); err != nil {
		t.Fatal(err)
	}
	if err = database.QueryRow("INSERT INTO circuit_schemes(name) VALUES('Other fixture') RETURNING id").Scan(&otherScheme); err != nil {
		t.Fatal(err)
	}
	component := func(code string, schemeID int) int {
		var id int
		if err := database.QueryRow("INSERT INTO scheme_components(scheme_id,component_type_id) SELECT $1,id FROM component_types WHERE code=$2 RETURNING id", schemeID, code).Scan(&id); err != nil {
			t.Fatal(err)
		}
		return id
	}
	a, b, c := component("busbar", scheme), component("busbar", scheme), component("busbar", scheme)
	line1, line2 := component("transmission_line", scheme), component("transmission_line", scheme)
	other := component("busbar", otherScheme)
	post := func(req connectionRequest, status int) {
		data, err := json.Marshal(req)
		if err != nil {
			t.Fatal(err)
		}
		rec := httptest.NewRecorder()
		handleConnections(rec, httptest.NewRequest(http.MethodPost, "/api/ees/connections", strings.NewReader(string(data))))
		if rec.Code != status {
			t.Fatalf("%+v: status %d expected %d: %s", req, rec.Code, status, rec.Body.String())
		}
	}
	// A ring and two parallel physical branches must remain constructible.
	for _, req := range []connectionRequest{
		{scheme, a, b, "right", "left"}, {scheme, b, c, "right", "left"}, {scheme, c, a, "right", "left"},
		{scheme, a, line1, "left", "left"}, {scheme, line1, b, "right", "left"},
		{scheme, a, line2, "left", "left"}, {scheme, line2, b, "right", "left"},
	} {
		post(req, 200)
	}
	post(connectionRequest{scheme, a, other, "left", "right"}, 422)
	post(connectionRequest{scheme, a, 999999, "left", "right"}, 404)
	post(connectionRequest{scheme, a, b, "does-not-exist", "right"}, 422)
	post(connectionRequest{scheme, a, a, "left", "left"}, 422)
	var mechanicalType, mechanical int
	if err = database.QueryRow("INSERT INTO component_types(code,name,category) VALUES('mechanical-fixture','Shaft','test') RETURNING id").Scan(&mechanicalType); err != nil {
		t.Fatal(err)
	}
	if _, err = database.Exec("INSERT INTO component_type_ports VALUES($1,'shaft','mechanical')", mechanicalType); err != nil {
		t.Fatal(err)
	}
	if err = database.QueryRow("INSERT INTO scheme_components(scheme_id,component_type_id) VALUES($1,$2) RETURNING id", scheme, mechanicalType).Scan(&mechanical); err != nil {
		t.Fatal(err)
	}
	post(connectionRequest{scheme, a, mechanical, "left", "shaft"}, 422)
	// Direct SQL writes must also enforce ownership and ports.
	for _, req := range []connectionRequest{{scheme, a, other, "left", "right"}, {scheme, a, b, "bad", "right"}, {0, a, b, "left", "right"}, {scheme, a, mechanical, "left", "shaft"}} {
		_, err := database.Exec("INSERT INTO scheme_connections(scheme_id,from_component_id,to_component_id,from_port,to_port) VALUES($1,$2,$3,$4,$5)", req.SchemeID, req.From, req.To, req.FromPort, req.ToPort)
		if err == nil {
			t.Fatalf("invalid SQL write accepted: %+v", req)
		}
	}
	var count int
	if err = database.QueryRow("SELECT count(*) FROM scheme_connections").Scan(&count); err != nil || count != 7 {
		t.Fatalf("unexpected persisted connections: %d %v", count, err)
	}
	rec := httptest.NewRecorder()
	handleConnections(rec, httptest.NewRequest(http.MethodGet, "/api/ees/connections", nil))
	if rec.Code != 405 || rec.Header().Get("Allow") != "POST" {
		t.Fatal("method contract", rec.Code)
	}
	// A mismatched move must not invalidate an existing connection silently.
	if _, err = database.Exec("UPDATE scheme_components SET scheme_id=$1 WHERE id=$2", otherScheme, a); err == nil {
		t.Fatal("connected object moved into another scheme")
	}
	// A pre-migration bad port is preserved and reported, never silently deleted.
	if _, err = database.Exec("DROP TRIGGER connection_ports_check ON scheme_connections"); err != nil {
		t.Fatal(err)
	}
	if _, err = database.Exec("INSERT INTO scheme_connections(scheme_id,from_component_id,to_component_id,from_port,to_port) VALUES($1,$2,$3,'legacy-invalid','right')", scheme, a, b); err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(filepath.Join("..", "database", "migrations", "20260930002_connection_integrity.up.sql"))
	if err != nil {
		t.Fatal(err)
	}
	if _, err = database.Exec(string(data)); err != nil {
		t.Fatal(err)
	}
	if err = database.QueryRow("SELECT count(*) FROM invalid_scheme_connections WHERE 'unknown_port'=ANY(reasons)").Scan(&count); err != nil || count != 1 {
		t.Fatalf("legacy audit: %d %v", count, err)
	}
	if err = database.QueryRow("SELECT count(*) FROM scheme_connections").Scan(&count); err != nil || count != 8 {
		t.Fatal("legacy connection removed", err)
	}
	rec = httptest.NewRecorder()
	handleSchemeByID(rec, httptest.NewRequest(http.MethodGet, fmt.Sprintf("/api/ees/schemes/%d", scheme), nil))
	var loaded struct {
		Connections []struct {
			ValidationErrors []string `json:"validationErrors"`
		} `json:"connections"`
	}
	if rec.Code != 200 {
		t.Fatal("reload", rec.Code, rec.Body.String())
	}
	if err = json.Unmarshal(rec.Body.Bytes(), &loaded); err != nil {
		t.Fatal(err)
	}
	invalid := 0
	for _, c := range loaded.Connections {
		for _, reason := range c.ValidationErrors {
			if reason == "unknown_port" {
				invalid++
			}
		}
	}
	if len(loaded.Connections) != 8 || invalid != 1 {
		t.Fatal("missing persisted diagnostics", len(loaded.Connections), invalid)
	}
}
