package main

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"reflect"
	"testing"
	"time"
)

func TestLegacySchemeNullableMetadataPostgres(t *testing.T) {
	database := migrationTestDatabase(t)
	if err := runMigrationsFromSource(database, migrationSourceURL(t)); err != nil {
		t.Fatal(err)
	}
	previous := db
	db = database
	defer func() { db = previous }()
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	var nullID, completeID, blankID, defaultID int
	for _, fixture := range []struct {
		query string
		id    *int
	}{
		{`INSERT INTO circuit_schemes(name,description,created_at,updated_at,owner_id) VALUES('Null metadata',NULL,NULL,NULL,NULL) RETURNING id`, &nullID},
		{`INSERT INTO circuit_schemes(name,description,created_at,updated_at,owner_id) VALUES('Complete','Описание','2001-01-02 03:04:05','2002-02-03 04:05:06',17) RETURNING id`, &completeID},
		{`INSERT INTO circuit_schemes(name,description) VALUES('Blank','') RETURNING id`, &blankID},
		{`INSERT INTO circuit_schemes(name) VALUES('Default metadata') RETURNING id`, &defaultID},
	} {
		if err := database.QueryRowContext(ctx, fixture.query).Scan(fixture.id); err != nil {
			t.Fatal(err)
		}
	}
	var account, project, private int
	if err := database.QueryRowContext(ctx, `INSERT INTO auth_accounts(display_name) VALUES('Private fixture') RETURNING id`).Scan(&account); err != nil {
		t.Fatal(err)
	}
	if err := database.QueryRowContext(ctx, `INSERT INTO projects(name,owner_account_id) VALUES('Private fixture',$1) RETURNING id`, account).Scan(&project); err != nil {
		t.Fatal(err)
	}
	if err := database.QueryRowContext(ctx, `INSERT INTO circuit_schemes(name,project_id) VALUES('Private NULL description',$1) RETURNING id`, project).Scan(&private); err != nil {
		t.Fatal(err)
	}
	list := httptest.NewRecorder()
	handleSchemes(list, httptest.NewRequest(http.MethodGet, "/api/ees/schemes", nil))
	if list.Code != http.StatusOK {
		t.Fatalf("nullable metadata blocked list: %d %s", list.Code, list.Body.String())
	}
	var rows []map[string]any
	if err := json.Unmarshal(list.Body.Bytes(), &rows); err != nil || len(rows) != 4 {
		t.Fatalf("list must retain all four public schemes only: %s %v", list.Body.String(), err)
	}
	byID := map[int]map[string]any{}
	for _, row := range rows {
		id := int(row["id"].(float64))
		if id == private {
			t.Fatal("private scheme leaked into legacy list")
		}
		byID[id] = row
		detail := httptest.NewRecorder()
		handleSchemeByID(detail, httptest.NewRequest(http.MethodGet, fmt.Sprintf("/api/ees/schemes/%d", id), nil))
		var snapshot map[string]any
		if detail.Code != http.StatusOK || json.Unmarshal(detail.Body.Bytes(), &snapshot) != nil {
			t.Fatalf("nullable metadata blocked snapshot: %d %s", detail.Code, detail.Body.String())
		}
		for _, key := range []string{"id", "name", "description", "created_at", "updated_at", "owner_id"} {
			if !reflect.DeepEqual(row[key], snapshot[key]) {
				t.Errorf("list/snapshot mismatch for scheme %d field %s: %v / %v", id, key, row[key], snapshot[key])
			}
		}
	}
	for _, id := range []int{nullID, blankID, defaultID} {
		if byID[id]["description"] != "" {
			t.Errorf("absent/empty description must be display text, got %v", byID[id])
		}
	}
	for _, key := range []string{"created_at", "updated_at", "owner_id"} {
		value, present := byID[nullID][key]
		if !present || value != nil {
			t.Errorf("unknown %s must remain JSON null: %v", key, byID[nullID])
		}
		if byID[completeID][key] == nil || byID[defaultID][key] == nil {
			t.Errorf("known/default metadata lost for %s", key)
		}
	}
	if byID[completeID]["description"] != "Описание" || byID[completeID]["owner_id"] != float64(17) {
		t.Errorf("known metadata changed: %v", byID[completeID])
	}
	var stillNull bool
	if err := database.QueryRowContext(ctx, `SELECT description IS NULL AND created_at IS NULL AND updated_at IS NULL AND owner_id IS NULL FROM circuit_schemes WHERE id=$1`, nullID).Scan(&stillNull); err != nil || !stillNull {
		t.Fatalf("reading metadata must not rewrite stored values: %t %v", stillNull, err)
	}
	privateDetail := httptest.NewRecorder()
	handleSchemeByID(privateDetail, httptest.NewRequest(http.MethodGet, fmt.Sprintf("/api/ees/schemes/%d", private), nil))
	if privateDetail.Code != http.StatusNotFound {
		t.Fatalf("private snapshot exposed through legacy endpoint: %d", privateDetail.Code)
	}
}
