package main

import (
	"context"
	"database/sql"
	"fmt"
	"os"
	"strings"
	"testing"
)

func TestEditorDraftPhases(t *testing.T) {
	data, err := os.ReadFile("../tests/fixtures/editor-draft-v2.json")
	if err != nil {
		t.Fatal(err)
	}
	payload, err := decodeEditorDraft(data)
	if err != nil || payload.FormatVersion != 2 || len(payload.Graph) != 6 {
		t.Fatalf("v2 rejected: %v", err)
	}
	if len(payload.Graph[2].Intent.ExpectedTopologyRevision) != 0 || string(payload.Graph[3].Intent.ExpectedTopologyRevision) != `"9007199254740994"` {
		t.Fatal("v2 changed missing/precise CAS")
	}
	good := `{"formatVersion":2,"components":[],"graph":[{"phase":"unprepared","intent":{"kind":"delete-connection","id":"7"},"reason":""}]}`
	for _, bad := range []string{
		strings.Replace(good, `"unprepared"`, `"unknown"`, 1),
		strings.Replace(good, `"phase":"unprepared",`, ``, 1),
		strings.Replace(good, `"unprepared"`, `null`, 1),
		strings.Replace(good, `"unprepared"`, `1`, 1),
		strings.Replace(good, `"phase"`, `"Phase"`, 1),
		strings.Replace(good, `"phase":"unprepared"`, `"phase":"unprepared","phase":"prepared"`, 1),
		strings.Replace(good, `"id":"7"`, `"id":"7","expectedTopologyRevision":"0"`, 1),
		strings.Replace(good, `"id":"7"`, `"id":"7","expectedTopologyRevision":null`, 1),
		strings.Replace(good, `"unprepared"`, `"prepared"`, 1),
		strings.Replace(good, `"formatVersion":2`, `"formatVersion":1`, 1),
		strings.Replace(good, `"formatVersion":2`, `"formatVersion":3`, 1),
		strings.Replace(string(data), `22222222-2222-4222-8222-222222222222`, `11111111-1111-4111-8111-111111111111`, 1),
	} {
		if _, err := decodeEditorDraft([]byte(bad)); err == nil {
			t.Fatalf("accepted malformed phase: %s", bad)
		}
	}
	prepared := strings.Replace(good, `"unprepared"`, `"prepared"`, 1)
	prepared = strings.Replace(prepared, `"id":"7"`, `"id":"7","expectedTopologyRevision":"0"`, 1)
	if _, err := decodeEditorDraft([]byte(prepared)); err != nil {
		t.Fatal(err)
	}
}

// The v1 database stores both supported editor payload formats unchanged.
func checkEditorDraftPhaseMigration(ctx context.Context, t *testing.T, db *sql.DB, account int64, scheme int64) {
	t.Helper()
	v2, err := os.ReadFile("../tests/fixtures/editor-draft-v2.json")
	if err != nil {
		t.Fatal(err)
	}
	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback()
	insert := `INSERT INTO project_editor_drafts(account_id,scheme_id,workspace_id,revision,payload) VALUES($1,$2,$3,11,$4::jsonb)`
	for i, body := range []string{draftFixture, string(v2)} {
		workspace := fmt.Sprintf("00000000-0000-0000-0000-%012d", i+1)
		if _, err = tx.ExecContext(ctx, insert, account, scheme, workspace, body); err != nil {
			t.Fatal(err)
		}
	}
	var count int
	if err := tx.QueryRowContext(ctx, `SELECT count(*) FROM project_editor_drafts WHERE account_id=$1 AND scheme_id=$2 AND revision=11`, account, scheme).Scan(&count); err != nil || count != 2 {
		t.Fatal("supported drafts were not retained", count, err)
	}
}
