package main

import (
	"context"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"
)

func TestMCPExternalClientPostgres(t *testing.T) {
	clientBinary := os.Getenv("TEST_MCP_CLIENT_BINARY")
	if clientBinary == "" {
		t.Skip("requires optional MCP SDK client binary")
	}
	f := newStudyFixture(t)
	auth := newAuthHTTP(f.store.database, "http://localhost", false)
	api := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.HasPrefix(r.URL.Path, "/api/auth/") {
			auth.ServeHTTP(w, r)
		} else {
			(projectsHTTP{auth: auth}).ServeHTTP(w, r)
		}
	}))
	defer api.Close()
	var typeID string
	if err := f.store.database.QueryRow(`SELECT id::text FROM component_types WHERE code='busbar'`).Scan(&typeID); err != nil {
		t.Fatal(err)
	}
	check := func(actor int, mode string, write bool) {
		t.Helper()
		path := filepath.Join(t.TempDir(), "session")
		if err := os.WriteFile(path, []byte(f.tokens[actor].Token), 0600); err != nil {
			t.Fatal(err)
		}
		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()
		command := exec.CommandContext(ctx, clientBinary, "-test.run=^TestExternalAPIAcceptance$", "-test.v")
		command.Env = append(os.Environ(), "ENERSY_MCP_API_ORIGIN="+api.URL, "ENERSY_MCP_AUTH_ORIGIN=http://localhost", "ENERSY_MCP_COOKIE_NAME=enersy_session",
			"ENERSY_MCP_SESSION_FILE="+path, "ENERSY_MCP_PROJECT_ID="+strconv.FormatInt(f.project, 10), "ENERSY_MCP_SCHEME_ID="+strconv.Itoa(f.scheme),
			"ENERSY_MCP_ALLOW_WRITE="+strconv.FormatBool(write), "TEST_MCP_MODE="+mode, "TEST_MCP_TYPE_ID="+typeID)
		if output, err := command.CombinedOutput(); err != nil {
			t.Fatalf("MCP acceptance failed (%s): %v\n%s", mode, err, output)
		}
	}
	check(0, "read", false)
	check(2, "read", true) // write opt-in never grants a viewer permission.
	check(0, "write", true)
	check(3, "denied", true)
	if err := (sessionStore{database: f.store.database}).Revoke(context.Background(), f.tokens[0].Token, f.tokens[0].Identity.SessionID); err != nil {
		t.Fatal(err)
	}
	check(0, "denied", true)
	var components, receipts int
	if err := f.store.database.QueryRow(`SELECT (SELECT count(*) FROM scheme_components WHERE scheme_id=$1),(SELECT count(*) FROM project_application_commands WHERE scheme_id=$1)`, f.scheme).Scan(&components, &receipts); err != nil {
		t.Fatal(err)
	}
	if components != 3 || receipts != 1 {
		t.Fatal("MCP wrote duplicate data or receipts", components, receipts)
	}
}
