package main

import (
	"context"
	"database/sql"
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

// Exercise old constraint -> upgrade, preservation, and a downgrade that refuses
// v2 without deleting or reinterpreting any user data. All changes roll back.
func checkEditorDraftPhaseMigration(ctx context.Context, t *testing.T, db *sql.DB, account int64, scheme int64) {
	t.Helper()
	up, err := os.ReadFile("../database/migrations/20261018001_editor_draft_phases.up.sql")
	if err != nil {
		t.Fatal(err)
	}
	down, err := os.ReadFile("../database/migrations/20261018001_editor_draft_phases.down.sql")
	if err != nil {
		t.Fatal(err)
	}
	v2, err := os.ReadFile("../tests/fixtures/editor-draft-v2.json")
	if err != nil {
		t.Fatal(err)
	}
	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback()
	insert := `INSERT INTO project_editor_drafts(account_id,scheme_id,workspace_id,revision,payload)
      VALUES($1,$2,$3,11,$4::jsonb)`
	if _, err = tx.ExecContext(ctx, insert, account, scheme, "00000000-0000-0000-0000-000000000001", draftFixture); err != nil {
		t.Fatal(err)
	}
	readRows := func() string {
		t.Helper()
		var value string
		if err := tx.QueryRowContext(ctx, `SELECT jsonb_agg(to_jsonb(d) ORDER BY workspace_id)::text FROM project_editor_drafts d WHERE account_id=$1 AND scheme_id=$2`, account, scheme).Scan(&value); err != nil {
			t.Fatal(err)
		}
		return value
	}
	before := readRows()
	if _, err = tx.ExecContext(ctx, string(down)); err != nil {
		t.Fatal(err)
	}
	if _, err = tx.ExecContext(ctx, "SAVEPOINT old_format"); err != nil {
		t.Fatal(err)
	}
	if _, err = tx.ExecContext(ctx, insert, account, scheme, "00000000-0000-0000-0000-000000000002", string(v2)); err == nil {
		t.Fatal("old format accepted v2")
	}
	if _, err = tx.ExecContext(ctx, "ROLLBACK TO SAVEPOINT old_format"); err != nil {
		t.Fatal(err)
	}
	if _, err = tx.ExecContext(ctx, string(up)); err != nil {
		t.Fatal(err)
	}
	if readRows() != before {
		t.Fatal("upgrade changed existing v1 payload or metadata")
	}
	if _, err = tx.ExecContext(ctx, insert, account, scheme, "00000000-0000-0000-0000-000000000002", string(v2)); err != nil {
		t.Fatal(err)
	}
	before = readRows()
	if _, err = tx.ExecContext(ctx, "SAVEPOINT before_downgrade"); err != nil {
		t.Fatal(err)
	}
	if _, err = tx.ExecContext(ctx, string(down)); err == nil {
		t.Fatal("downgrade accepted surviving v2 data")
	}
	if _, err = tx.ExecContext(ctx, "ROLLBACK TO SAVEPOINT before_downgrade"); err != nil {
		t.Fatal(err)
	}
	if readRows() != before {
		t.Fatal("refused downgrade changed journal data")
	}
}
