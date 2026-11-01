package main

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"
)

func TestApplicationCreateEquipmentPostgres(t *testing.T) {
	f := newStudyFixture(t)
	ctx, cancel := context.WithTimeout(context.Background(), 25*time.Second)
	defer cancel()
	service := applicationService{database: f.store.database}
	var typeID int
	if err := f.store.database.QueryRowContext(ctx, `SELECT id FROM component_types WHERE code='busbar'`).Scan(&typeID); err != nil {
		t.Fatal(err)
	}
	command := createEquipmentCommand{ProjectID: f.project, CommandID: studyCommand(700), ExpectedTopologyRevision: f.topology,
		Equipment: createComponentRequest{SchemeID: f.scheme, TypeID: typeID, Name: "Новая шина", Params: map[string]string{"voltage_nom": "110.00"}}}
	const calls = 8
	var wg sync.WaitGroup
	results := make(chan createEquipmentReceipt, calls)
	failures := make(chan error, calls)
	for range calls {
		wg.Go(func() {
			receipt, err := service.CreateEquipment(ctx, f.tokens[0].Token, command)
			results <- receipt
			failures <- err
		})
	}
	wg.Wait()
	close(results)
	close(failures)
	for err := range failures {
		if err != nil {
			t.Fatal(err)
		}
	}
	var first createEquipmentReceipt
	var accepted int
	for receipt := range results {
		if !receipt.Replayed {
			accepted++
			first = receipt
		}
		if receipt.Deleted || receipt.ID <= 0 || receipt.Params["voltage_nom"] != "110.00" || receipt.TopologyRevision != f.topology+1 {
			t.Fatalf("invalid creation receipt: %+v", receipt)
		}
	}
	if accepted != 1 {
		t.Fatal("concurrent replay created multiple objects", accepted)
	}
	var components, receipts int
	if err := f.store.database.QueryRowContext(ctx, `SELECT (SELECT count(*) FROM scheme_components WHERE scheme_id=$1), (SELECT count(*) FROM project_application_commands)`, f.scheme).Scan(&components, &receipts); err != nil || components != 3 || receipts != 1 {
		t.Fatal("duplicate object or receipt", components, receipts, err)
	}
	second, err := (sessionStore{database: f.store.database}).Issue(ctx, f.tokens[0].Identity.AccountID, time.Hour)
	if err != nil {
		t.Fatal(err)
	}
	// Reconstruct the application service: neither the new session nor a new
	// instance carries an in-memory retry cache. Original stale CAS is accepted.
	replay, err := (applicationService{database: f.store.database}).CreateEquipment(ctx, second.Token, command)
	if err != nil || !replay.Replayed || replay.ID != first.ID || !reflect.DeepEqual(first.Params, replay.Params) {
		t.Fatal("persisted replay failed", replay, err)
	}
	changed := command
	changed.Equipment.Params = map[string]string{"voltage_nom": "220"}
	if _, err := service.CreateEquipment(ctx, second.Token, changed); !errors.Is(err, errApplicationCommandConflict) {
		t.Fatal("changed intent reused ID", err)
	}
	if _, err := service.CreateEquipment(ctx, f.tokens[1].Token, command); !errors.Is(err, errApplicationCommandConflict) {
		t.Fatal("another author replayed command", err)
	}
	for _, token := range []string{f.tokens[2].Token, f.tokens[3].Token, ""} {
		if got, err := service.CreateEquipment(ctx, token, command); !errors.Is(err, sql.ErrNoRows) || got.ID != 0 {
			t.Fatal("unauthorized replay returned a receipt", got, err)
		}
	}
	stale := command
	stale.CommandID = studyCommand(701)
	if _, err := service.CreateEquipment(ctx, second.Token, stale); !errors.Is(err, errTopologyConflict) {
		t.Fatal("stale topology created object", err)
	}
	if _, err := f.store.MutateComponent(ctx, second.Token, f.project, f.scheme, first.ID, first.Revision, func(tx *sql.Tx) error {
		_, err := tx.ExecContext(ctx, `DELETE FROM scheme_components WHERE id=$1`, first.ID)
		return err
	}, true); err != nil {
		t.Fatal(err)
	}
	replay, err = service.CreateEquipment(ctx, second.Token, command)
	if err != nil || !replay.Replayed || !replay.Deleted || replay.ID != first.ID {
		t.Fatal("deleted object was recreated", replay, err)
	}
	for _, query := range []string{`DELETE FROM project_application_commands`, `UPDATE project_application_commands SET receipt='{}'`} {
		if _, err := f.store.database.ExecContext(ctx, query); err == nil {
			t.Fatal("receipt history is mutable")
		}
	}
	// Reject receipt INSERT after creating the component. The entire command,
	// including topology/parameters, must roll back rather than leave an orphan.
	if _, err := f.store.database.ExecContext(ctx, `CREATE FUNCTION reject_receipt_fixture() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'fixture receipt rejection'; END; $$;
 CREATE TRIGGER reject_receipt_fixture BEFORE INSERT ON project_application_commands FOR EACH ROW EXECUTE FUNCTION reject_receipt_fixture()`); err != nil {
		t.Fatal(err)
	}
	failed := command
	failed.CommandID = studyCommand(702)
	failed.ExpectedTopologyRevision = replay.TopologyRevision
	if _, err := service.CreateEquipment(ctx, second.Token, failed); err == nil {
		t.Fatal("receipt failure was swallowed")
	}
	var topology int64
	if err := f.store.database.QueryRowContext(ctx, `SELECT topology_revision,(SELECT count(*) FROM scheme_components WHERE scheme_id=$1) FROM circuit_schemes WHERE id=$1`, f.scheme).Scan(&topology, &components); err != nil || topology != replay.TopologyRevision || components != 2 {
		t.Fatal("receipt failure partially committed graph", topology, components, err)
	}
	if _, err := f.store.database.ExecContext(ctx, `DROP TRIGGER reject_receipt_fixture ON project_application_commands`); err != nil {
		t.Fatal(err)
	}
	editorCommand := command
	editorCommand.CommandID = studyCommand(703)
	editorCommand.ExpectedTopologyRevision = topology
	if _, err := service.CreateEquipment(ctx, f.tokens[1].Token, editorCommand); err != nil {
		t.Fatal("editor cannot create protected equipment", err)
	}
	if _, err := f.store.ChangeMember(ctx, second.Token, f.project, f.tokens[1].Identity.AccountID, 2, "", true); err != nil {
		t.Fatal(err)
	}
	if got, err := service.CreateEquipment(ctx, f.tokens[1].Token, editorCommand); !errors.Is(err, sql.ErrNoRows) || got.ID != 0 {
		t.Fatal("removed member replayed a receipt", got, err)
	}
	if err := (sessionStore{database: f.store.database}).Revoke(ctx, second.Token, f.tokens[0].Identity.SessionID); err != nil {
		t.Fatal(err)
	}
	if _, err := service.CreateEquipment(ctx, f.tokens[0].Token, command); !errors.Is(err, sql.ErrNoRows) {
		t.Fatal("revoked session replayed receipt", err)
	}
	if _, err := service.CreateEquipment(ctx, second.Token, command); err != nil {
		t.Fatal("revocation affected another session", err)
	}
	if _, err := f.store.database.ExecContext(ctx, `DELETE FROM circuit_schemes WHERE id=$1`, f.scheme); err != nil {
		t.Fatal("scope deletion could not remove owned receipts", err)
	}
	if err := f.store.database.QueryRowContext(ctx, `SELECT count(*) FROM project_application_commands`).Scan(&receipts); err != nil || receipts != 0 {
		t.Fatal("deleted scope retained receipts", receipts, err)
	}
	otherScheme, err := f.store.CreateScheme(ctx, second.Token, f.project, "Project deletion fixture", "")
	if err != nil {
		t.Fatal(err)
	}
	otherCommand := command
	otherCommand.CommandID = studyCommand(704)
	otherCommand.ExpectedTopologyRevision = 0
	otherCommand.Equipment.SchemeID = int(otherScheme)
	if _, err := service.CreateEquipment(ctx, second.Token, otherCommand); err != nil {
		t.Fatal(err)
	}
	// Existing project deletion requires removing its diagrams first. The new
	// receipt FK must not turn this into an implicit deletion of graph data.
	if _, err := f.store.database.ExecContext(ctx, `DELETE FROM projects WHERE id=$1`, f.project); err == nil {
		t.Fatal("project deletion silently removed an existing diagram")
	}
	if err := f.store.database.QueryRowContext(ctx, `SELECT count(*) FROM project_application_commands`).Scan(&receipts); err != nil || receipts != 1 {
		t.Fatal("refused project deletion changed receipts", receipts, err)
	}
	if _, err := f.store.database.ExecContext(ctx, `DELETE FROM circuit_schemes WHERE id=$1;`, otherScheme); err != nil {
		t.Fatal(err)
	}
	if _, err := f.store.database.ExecContext(ctx, `DELETE FROM projects WHERE id=$1`, f.project); err != nil {
		t.Fatal("empty project could not be removed", err)
	}
	if err := f.store.database.QueryRowContext(ctx, `SELECT count(*) FROM project_application_commands`).Scan(&receipts); err != nil || receipts != 0 {
		t.Fatal("deleted project retained receipts", receipts, err)
	}
}

func TestApplicationCreateEquipmentHTTPPostgres(t *testing.T) {
	f := newStudyFixture(t)
	auth := newAuthHTTP(f.store.database, "https://frontend.example", true)
	var typeID string
	if err := f.store.database.QueryRow(`SELECT id::text FROM component_types WHERE code='busbar'`).Scan(&typeID); err != nil {
		t.Fatal(err)
	}
	body := fmt.Sprintf(`{"typeId":%q,"name":"Шина","params":{},"equipmentModelId":null}`, typeID)
	request := func(key, tag, input string) *httptest.ResponseRecorder {
		r := httptest.NewRequest(http.MethodPost, fmt.Sprintf("/api/projects/%d/schemes/%d/components", f.project, f.scheme), strings.NewReader(input))
		r.Header.Set("Content-Type", "application/json")
		r.Header.Set("Origin", auth.origin)
		if key != "" {
			r.Header.Set("Idempotency-Key", key)
		}
		if tag != "" {
			r.Header.Set("If-Match", tag)
		}
		r.AddCookie(&http.Cookie{Name: auth.cookieName(), Value: f.tokens[0].Token})
		w := httptest.NewRecorder()
		(projectsHTTP{auth: auth}).ServeHTTP(w, r)
		return w
	}
	key := studyCommand(800)
	tag := fmt.Sprintf(`"%d"`, f.topology)
	if got := request(key, "", body); got.Code != 428 {
		t.Fatal("missing CAS accepted", got.Code, got.Body)
	}
	if got := request("invalid", tag, body); got.Code != 400 {
		t.Fatal("invalid key accepted", got.Code)
	}
	first := request(key, tag, body)
	if first.Code != 201 || !strings.Contains(first.Body.String(), `"deleted":false`) || !strings.Contains(first.Body.String(), `"commandId":"`+key+`"`) {
		t.Fatal("command failed", first.Code, first.Body)
	}
	replay := request(key, tag, body)
	if replay.Code != 201 || replay.Header().Get("Idempotency-Replayed") != "true" || first.Body.String() != replay.Body.String() {
		t.Fatal("HTTP replay differs", replay.Code, replay.Body)
	}
	if got := request(key, tag, strings.Replace(body, "Шина", "Другая шина", 1)); got.Code != 409 {
		t.Fatal("changed payload did not conflict", got.Code, got.Body)
	}
	if got := request(studyCommand(801), tag, body); got.Code != 412 {
		t.Fatal("stale topology did not conflict", got.Code, got.Body)
	}
	second, err := (sessionStore{database: f.store.database}).Issue(context.Background(), f.tokens[0].Identity.AccountID, time.Hour)
	if err != nil {
		t.Fatal(err)
	}
	bound := func(actor string, identity sessionIdentity) *httptest.ResponseRecorder {
		r := httptest.NewRequest(http.MethodPost, fmt.Sprintf("/api/projects/%d/schemes/%d/components", f.project, f.scheme), strings.NewReader(body))
		r.Header.Set("Content-Type", "application/json")
		r.Header.Set("Origin", auth.origin)
		r.Header.Set("Idempotency-Key", studyCommand(802))
		r.Header.Set("If-Match", fmt.Sprintf(`"%d"`, f.topology+1))
		r.Header.Set("X-Enersy-Account-Id", strconv.FormatInt(identity.AccountID, 10))
		r.Header.Set("X-Enersy-Session-Id", strconv.FormatInt(identity.SessionID, 10))
		r.AddCookie(&http.Cookie{Name: auth.cookieName(), Value: actor})
		w := httptest.NewRecorder()
		(projectsHTTP{auth: auth}).ServeHTTP(w, r)
		return w
	}
	for _, actor := range []string{second.Token, f.tokens[1].Token} {
		if got := bound(actor, f.tokens[0].Identity); got.Code != 409 || !strings.Contains(got.Body.String(), "command_session_changed") {
			t.Fatal("changed cookie executed the old session's command", got.Code, got.Body)
		}
	}
	if got := bound(f.tokens[0].Token, f.tokens[0].Identity); got.Code != 201 {
		t.Fatal("matching identity failed", got.Code, got.Body)
	}
	if got := bound(second.Token, second.Identity); got.Code != 201 || got.Header().Get("Idempotency-Replayed") != "true" {
		t.Fatal("transport identity changed the engineering intent hash", got.Code, got.Body)
	}

}
