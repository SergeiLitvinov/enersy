package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/cookiejar"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestPasswordProfile(t *testing.T) {
	encoded, err := hashPassword("A test password phrase")
	if err != nil {
		t.Fatal(err)
	}
	if !verifyPassword("A test password phrase", encoded) || verifyPassword("A different password", encoded) {
		t.Fatal("password verifier did not discriminate")
	}
	for _, invalid := range []string{"", strings.Replace(encoded, "m=65536", "m=999999999", 1), strings.Replace(encoded, "v=19", "v=0", 1), encoded + "$extra", strings.Repeat("x", 257)} {
		if verifyPassword("A test password phrase", invalid) {
			t.Fatal("unsupported hash profile accepted")
		}
	}
}

func TestAuthIdentityPrecision(t *testing.T) {
	response := httptest.NewRecorder()
	authIdentityJSON(response, sessionIdentity{AccountID: 9223372036854775807, SessionID: 9007199254740993})
	if !strings.Contains(response.Body.String(), `"accountId":"9223372036854775807"`) || !strings.Contains(response.Body.String(), `"sessionId":"9007199254740993"`) {
		t.Fatal("BIGINT identity lost precision")
	}
}

func TestAuthHTTPPostgres(t *testing.T) {
	database := migrationTestDatabase(t)
	if err := runMigrationsFromSource(database, migrationSourceURL(t)); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
	defer cancel()
	const password = "Test-only account passphrase"
	var output bytes.Buffer
	provisionJSON, _ := json.Marshal(map[string]string{"displayName": "Alice", "login": " Alice ", "password": password})
	if err := provisionAccount(ctx, database, bytes.NewReader(provisionJSON), &output); err != nil {
		t.Fatal(err)
	}
	if strings.Contains(output.String(), password) {
		t.Fatal("provision output exposed a password")
	}
	credentials := credentialStore{database: database}
	bob, err := credentials.Provision(ctx, "Bob", "bob", password)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := credentials.Provision(ctx, "Duplicate", "ALICE", password); !errors.Is(err, errLoginUnavailable) {
		t.Fatalf("duplicate login accepted: %v", err)
	}
	var count int
	if err := database.QueryRowContext(ctx, `SELECT count(*) FROM auth_accounts`).Scan(&count); err != nil || count != 2 {
		t.Fatal("duplicate provisioning left an account")
	}
	var hashes int
	if err := database.QueryRowContext(ctx, `SELECT count(DISTINCT password_hash) FROM auth_local_credentials`).Scan(&hashes); err != nil || hashes != 2 {
		t.Fatal("password salts were not independent")
	}
	canceled, stop := context.WithCancel(ctx)
	stop()
	if _, err := credentials.Authenticate(canceled, "alice", password); !errors.Is(err, context.Canceled) {
		t.Fatal("credential lookup ignored cancellation")
	}
	origin := "https://frontend.example"
	handler := newAuthHTTP(database, origin, true)
	server := httptest.NewTLSServer(handler)
	defer server.Close()
	origin = server.URL
	handler.origin = origin
	client := func() *http.Client {
		value := *server.Client()
		jar, err := cookiejar.New(nil)
		if err != nil {
			t.Fatal(err)
		}
		value.Jar = jar
		return &value
	}
	first, second, other := client(), client(), client()
	request := func(client *http.Client, method, path, body, requestOrigin, contentType string) (int, string, http.Header) {
		t.Helper()
		req, err := http.NewRequestWithContext(ctx, method, server.URL+path, strings.NewReader(body))
		if err != nil {
			t.Fatal(err)
		}
		if requestOrigin != "" {
			req.Header.Set("Origin", requestOrigin)
		}
		if contentType != "" {
			req.Header.Set("Content-Type", contentType)
		}
		response, err := client.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		defer response.Body.Close()
		content, err := io.ReadAll(response.Body)
		if err != nil {
			t.Fatal(err)
		}
		if response.Header.Get("Cache-Control") != "no-store" {
			t.Fatal("auth response is cacheable")
		}
		if strings.Contains(string(content), password) {
			t.Fatal("auth response exposed a password")
		}
		return response.StatusCode, string(content), response.Header
	}
	login := func(client *http.Client, name string) string {
		t.Helper()
		body, _ := json.Marshal(map[string]string{"login": name, "password": password})
		code, content, headers := request(client, "POST", "/api/auth/login", string(body), origin, "application/json")
		if code != 200 {
			t.Fatalf("login failed: %d", code)
		}
		cookieResponse := &http.Response{Header: headers}
		cookies := cookieResponse.Cookies()
		if len(cookies) != 1 || cookies[0].Name != "__Host-enersy_session" || !cookies[0].Secure || !cookies[0].HttpOnly || cookies[0].SameSite != http.SameSiteStrictMode || cookies[0].Path != "/" || cookies[0].MaxAge <= 0 {
			t.Fatal("session cookie policy incorrect")
		}
		if strings.Contains(content, cookies[0].Value) {
			t.Fatal("session token exposed in JSON")
		}
		var identity struct {
			SessionID string `json:"sessionId"`
		}
		if err := json.Unmarshal([]byte(content), &identity); err != nil || identity.SessionID == "" {
			t.Fatal("login did not return a string identity")
		}
		return identity.SessionID
	}
	firstID, secondID := login(first, "alice"), login(second, "ALICE")
	login(other, "bob")
	if firstID == secondID {
		t.Fatal("two logins share a session")
	}
	session := func(client *http.Client, want int) {
		t.Helper()
		code, _, _ := request(client, "GET", "/api/auth/session", "", "", "")
		if code != want {
			t.Fatalf("session status=%d expected=%d", code, want)
		}
	}
	for _, value := range []*http.Client{first, second, other} {
		session(value, 200)
	}
	code, _, _ := request(first, "POST", "/api/auth/logout", "", origin, "")
	if code != 204 {
		t.Fatal("logout failed")
	}
	session(first, 401)
	session(second, 200)
	session(other, 200)
	login(first, "alice")
	code, _, _ = request(second, "POST", "/api/auth/logout-all", "", origin, "")
	if code != 204 {
		t.Fatal("bulk logout failed")
	}
	session(first, 401)
	session(second, 401)
	session(other, 200)
	unknownCode, unknownBody, _ := request(client(), "POST", "/api/auth/login", `{"login":"nobody","password":"Wrong password"}`, origin, "application/json")
	wrongCode, wrongBody, _ := request(client(), "POST", "/api/auth/login", `{"login":"alice","password":"Wrong password"}`, origin, "application/json")
	if unknownCode != 401 || wrongCode != 401 || unknownBody != wrongBody {
		t.Fatal("credential rejection reveals account existence")
	}
	for _, test := range []struct {
		method, path, body, origin, contentType string
		want                                    int
	}{
		{"GET", "/api/auth/login", "", "", "", 405},
		{"POST", "/api/auth/login", `{}`, "", "application/json", 403},
		{"POST", "/api/auth/login", `{}`, "https://foreign.example", "application/json", 403},
		{"POST", "/api/auth/login", `{}`, origin, "text/plain", 415},
		{"POST", "/api/auth/login", `{"login":"alice","password":"x","accountId":"1"}`, origin, "application/json", 400},
		{"POST", "/api/auth/login", `{}{}`, origin, "application/json", 400},
		{"POST", "/api/auth/login", `{"login":"alice","password":"` + strings.Repeat("x", 17000) + `"}`, origin, "application/json", 413},
		{"GET", "/api/auth/session", "", "https://foreign.example", "", 403},
	} {
		code, _, _ := request(client(), test.method, test.path, test.body, test.origin, test.contentType)
		if code != test.want {
			t.Fatalf("request boundary %s %s status=%d expected=%d", test.method, test.path, code, test.want)
		}
	}
	handler.loginSlots <- struct{}{}
	handler.loginSlots <- struct{}{}
	code, _, _ = request(client(), "POST", "/api/auth/login", `{}`, origin, "application/json")
	if code != 400 {
		t.Fatal("body validation incorrectly reserves KDF admission")
	}
	code, _, _ = request(client(), "POST", "/api/auth/login", `{"login":"alice","password":"Anything"}`, origin, "application/json")
	<-handler.loginSlots
	<-handler.loginSlots
	if code != 429 {
		t.Fatal("login admission did not bound hashing")
	}
	code, _, headers := request(client(), "OPTIONS", "/api/auth/login", "", origin, "")
	if code != 204 || headers.Get("Access-Control-Allow-Origin") != origin || headers.Get("Access-Control-Allow-Credentials") != "true" {
		t.Fatal("credential preflight incorrect")
	}
	if _, err := database.ExecContext(ctx, `UPDATE auth_accounts SET disabled_at=statement_timestamp() WHERE id=$1`, bob); err != nil {
		t.Fatal(err)
	}
	session(other, 401)
	if id, err := credentials.Authenticate(ctx, "bob", password); id != 0 || !errors.Is(err, errCredentials) {
		t.Fatal("disabled account authenticated")
	}
	for _, value := range []string{"", "*", "https://frontend.example/path", "https://user@frontend.example", "https://frontend.example?x=1"} {
		rec := httptest.NewRecorder()
		newAuthHTTP(database, value, true).ServeHTTP(rec, httptest.NewRequest("GET", "/api/auth/session", nil))
		if rec.Code != 503 {
			t.Fatal("unsafe auth origin enabled")
		}
	}
}
