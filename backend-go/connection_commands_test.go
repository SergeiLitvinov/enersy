package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestConnectionCommandKey(t *testing.T) {
	for _, tc := range []struct {
		values  []string
		want    string
		invalid bool
	}{
		{nil, "", false},
		{[]string{"AABBCCDD-1234-5678-9012-123456789012"}, "aabbccdd-1234-5678-9012-123456789012", false},
		{[]string{""}, "", true}, {[]string{"123"}, "", true},
		{[]string{"aabbccdd-1234-5678-9012-123456789012", "aabbccdd-1234-5678-9012-123456789012"}, "", true},
		{[]string{"aabbccdd-1234-5678-9012-123456789012, aabbccdd-1234-5678-9012-123456789012"}, "", true},
	} {
		r := httptest.NewRequest(http.MethodPost, "/", nil)
		for _, value := range tc.values {
			r.Header.Add("Idempotency-Key", value)
		}
		key, err := connectionCommandKey(r)
		if key != tc.want || (err != nil) != tc.invalid {
			t.Fatalf("%v: %s / %v", tc.values, key, err)
		}
	}
}

func TestConnectionCommandRouteValidation(t *testing.T) {
	for _, key := range []string{"", "invalid"} {
		r := httptest.NewRequest(http.MethodPost, "/api/ees/connection-commands", nil)
		if key != "" {
			r.Header.Set("Idempotency-Key", key)
		}
		w := httptest.NewRecorder()
		handleConnectionCommands(w, r)
		if w.Code != 400 {
			t.Fatal("unkeyed command dispatched", w.Code)
		}
	}
	w := httptest.NewRecorder()
	handleConnectionCommands(w, httptest.NewRequest(http.MethodGet, "/api/ees/connection-commands", nil))
	if w.Code != 405 || w.Header().Get("Allow") != "POST" {
		t.Fatal("method contract", w.Code)
	}
}

func TestConnectionCommandsPostgres(t *testing.T) {
	database := migrationTestDatabase(t)
	if err := runMigrationsFromSource(database, migrationSourceURL(t)); err != nil {
		t.Fatal(err)
	}
	previous := db
	db = database
	defer func() { db = previous }()
	newScheme := func() (int, int, int) {
		var scheme, a, b int
		if err := database.QueryRow("INSERT INTO circuit_schemes(name) VALUES('Commands') RETURNING id").Scan(&scheme); err != nil {
			t.Fatal(err)
		}
		for _, target := range []*int{&a, &b} {
			if err := database.QueryRow("INSERT INTO scheme_components(scheme_id,component_type_id) SELECT $1,id FROM component_types WHERE code='busbar' RETURNING id", scheme).Scan(target); err != nil {
				t.Fatal(err)
			}
		}
		return scheme, a, b
	}
	scheme, a, b := newScheme()
	request := connectionRequest{scheme, a, b, "right", "left"}
	post := func(req connectionRequest, key string) *httptest.ResponseRecorder {
		data, _ := json.Marshal(req)
		r := httptest.NewRequest(http.MethodPost, "/api/ees/connection-commands", strings.NewReader(string(data)))
		r.Header.Set("Idempotency-Key", key)
		w := httptest.NewRecorder()
		handleConnectionCommands(w, r)
		return w
	}
	idOf := func(w *httptest.ResponseRecorder) int {
		t.Helper()
		var result struct {
			ID        int    `json:"id"`
			Success   bool   `json:"success"`
			CommandID string `json:"commandId"`
		}
		if w.Code != 200 || json.Unmarshal(w.Body.Bytes(), &result) != nil || !result.Success || result.ID <= 0 || !commandUUID.MatchString(result.CommandID) {
			t.Fatalf("invalid ack: %d %s", w.Code, w.Body.String())
		}
		return result.ID
	}
	count := func(table string) int {
		t.Helper()
		var n int
		if err := database.QueryRow("SELECT count(*) FROM " + table).Scan(&n); err != nil {
			t.Fatal(err)
		}
		return n
	}
	key := "11111111-1111-4111-8111-111111111111"
	// Model a lost response by discarding the first body; retries still find its commit.
	first := post(request, key)
	id := idOf(first)
	responses := make(chan *httptest.ResponseRecorder, 8)
	for i := 0; i < 8; i++ {
		go func() { responses <- post(request, key) }()
	}
	for i := 0; i < 8; i++ {
		w := <-responses
		if idOf(w) != id || w.Header().Get("Idempotency-Replayed") != "true" {
			t.Fatal("replay changed command result")
		}
	}
	if count("scheme_connections") != 1 || count("connection_commands") != 1 {
		t.Fatal("retry duplicated connection")
	}
	changed := request
	changed.ToPort = "right"
	if w := post(changed, key); w.Code != 409 {
		t.Fatal("changed payload accepted", w.Code)
	}
	upper := request
	upper.FromPort = "RIGHT"
	upper.ToPort = "LEFT"
	if idOf(post(upper, key)) != id {
		t.Fatal("port normalization changed command")
	}
	// Concurrent first submissions must share a single creation as well.
	concurrentKey := "22222222-2222-4222-8222-222222222222"
	for i := 0; i < 8; i++ {
		go func() { responses <- post(request, concurrentKey) }()
	}
	var concurrentID int
	for i := 0; i < 8; i++ {
		next := idOf(<-responses)
		if i == 0 {
			concurrentID = next
		} else if next != concurrentID {
			t.Fatal("concurrent command duplicated")
		}
	}
	if count("scheme_connections") != 2 || count("connection_commands") != 2 {
		t.Fatal("concurrent creation was not atomic")
	}
	// Deleted endpoints/connection do not turn replay into a second creation.
	if _, err := database.Exec("DELETE FROM scheme_components WHERE id=$1", a); err != nil {
		t.Fatal(err)
	}
	if idOf(post(request, key)) != id || count("scheme_connections") != 0 {
		t.Fatal("replay recreated deleted topology")
	}
	// Same UUID in another scheme is independent (not an authorization guarantee).
	other, c, d := newScheme()
	if idOf(post(connectionRequest{other, c, d, "right", "left"}, key)) == id {
		t.Fatal("scheme scope mixed results")
	}
	// Validation failure rolls back the claim; corrected request may use its key.
	failedKey := "33333333-3333-4333-8333-333333333333"
	if w := post(connectionRequest{other, c, d, "bad", "left"}, failedKey); w.Code != 422 {
		t.Fatal("bad port accepted")
	}
	if count("connection_commands") != 3 {
		t.Fatal("failure persisted command")
	}
	idOf(post(connectionRequest{other, c, d, "right", "left"}, failedKey))
	// Failure storing the acknowledgement must roll back the inserted connection.
	if _, err := database.Exec("ALTER TABLE connection_commands ADD CONSTRAINT reject_new_commands CHECK(false) NOT VALID"); err != nil {
		t.Fatal(err)
	}
	before := count("scheme_connections")
	if w := post(connectionRequest{other, c, d, "right", "left"}, "44444444-4444-4444-8444-444444444444"); w.Code != 500 {
		t.Fatal("ledger failure not reported", w.Code)
	}
	if count("scheme_connections") != before || count("connection_commands") != 4 {
		t.Fatal("ledger failure left partial commit")
	}
}
