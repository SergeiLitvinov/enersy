package main

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"
)

type studyTestFixture struct {
	store    projectStore
	project  int64
	scheme   int
	topology int64
	load     int
	tokens   [4]issuedSession
	doc      studyDocument
}

func studyCommand(i int) string { return fmt.Sprintf("11111111-1111-4111-8111-%012x", i) }
func newStudyFixture(t *testing.T) studyTestFixture {
	t.Helper()
	database := migrationTestDatabase(t)
	if err := runMigrationsFromSource(database, migrationSourceURL(t)); err != nil {
		t.Fatal(err)
	}
	f := studyTestFixture{store: projectStore{database: database}}
	ctx := context.Background()
	sessions := sessionStore{database: database}
	for i := range f.tokens {
		var account int64
		if err := database.QueryRow(`INSERT INTO auth_accounts(display_name) VALUES('Study fixture') RETURNING id`).Scan(&account); err != nil {
			t.Fatal(err)
		}
		value, err := sessions.Issue(ctx, account, time.Hour)
		if err != nil {
			t.Fatal(err)
		}
		f.tokens[i] = value
	}
	var err error
	f.project, err = f.store.Create(ctx, f.tokens[0].Token, "Study fixture")
	if err != nil {
		t.Fatal(err)
	}
	for i, role := range []string{"editor", "viewer"} {
		if _, err := f.store.ChangeMember(ctx, f.tokens[0].Token, f.project, f.tokens[i+1].Identity.AccountID, int64(i), role, false); err != nil {
			t.Fatal(err)
		}
	}
	scheme, err := f.store.CreateScheme(ctx, f.tokens[0].Token, f.project, "Study source", "")
	if err != nil {
		t.Fatal(err)
	}
	f.scheme = int(scheme)
	var generator int
	if err = database.QueryRow(`INSERT INTO scheme_components(scheme_id,component_type_id,pos_x,pos_y,rotation) SELECT $1,id,0,0,0 FROM component_types WHERE code='generator' RETURNING id`, scheme).Scan(&generator); err != nil {
		t.Fatal(err)
	}
	if err = database.QueryRow(`INSERT INTO scheme_components(scheme_id,component_type_id,pos_x,pos_y,rotation) SELECT $1,id,100,100,0 FROM component_types WHERE code='load' RETURNING id`, scheme).Scan(&f.load); err != nil {
		t.Fatal(err)
	}
	for component, params := range map[int]map[string]string{generator: {"e": "1", "voltage_nom": "1", "r": "1", "x": "0", "p": "0.2"}, f.load: {"voltage_nom": "1", "p": "0.2", "q": "0"}} {
		for key, value := range params {
			if _, err = database.Exec(`INSERT INTO scheme_component_params(scheme_component_id,param_key,param_value) VALUES($1,$2,$3)`, component, key, value); err != nil {
				t.Fatal(err)
			}
		}
	}
	if _, err = database.Exec(`INSERT INTO scheme_connections(scheme_id,from_component_id,to_component_id,from_port,to_port) VALUES($1,$2,$3,'bottom','top')`, scheme, generator, f.load); err != nil {
		t.Fatal(err)
	}
	if err = database.QueryRow(`SELECT topology_revision FROM circuit_schemes WHERE id=$1`, scheme).Scan(&f.topology); err != nil {
		t.Fatal(err)
	}
	f.doc = studyDocument{1, "AC study", "three-phase", "newton-raphson", "julia", 20000, studyBase{1, 1}, studySolverOptions{1e-12, 50}, []terminalVoltageLimit{{f.load, 1, 0.7, 0.8}}}
	return f
}

func TestStudyDocumentExplicitContract(t *testing.T) {
	valid := studyDocument{1, "AC", "three-phase", "newton-raphson", "julia", 20000, studyBase{100, 10}, studySolverOptions{1e-8, 50}, []terminalVoltageLimit{}}
	if err := validateStudyDocument(valid); err != nil {
		t.Fatal(err)
	}
	for _, change := range []func(*studyDocument){func(d *studyDocument) { d.Base.Power = 0 }, func(d *studyDocument) { d.Base.Voltage = math.Inf(1) }, func(d *studyDocument) { d.Solver.Tolerance = math.NaN() }, func(d *studyDocument) { d.Solver.MaxIterations = 0 }, func(d *studyDocument) { d.ComputeBackend = "unknown" }, func(d *studyDocument) { d.Limits = nil }, func(d *studyDocument) { d.Method = "direct" }, func(d *studyDocument) { d.MaxTimeMS = 20001 }} {
		invalid := valid
		change(&invalid)
		if validateStudyDocument(invalid) == nil {
			t.Fatalf("invalid settings accepted: %+v", invalid)
		}
	}
}

func TestStudySnapshotLifecyclePostgres(t *testing.T) {
	f := newStudyFixture(t)
	ctx := context.Background()
	owner := f.tokens[0].Token
	first, err := f.store.SaveStudy(ctx, owner, f.project, f.scheme, 0, 0, f.topology, studyCommand(1), f.doc)
	if err != nil {
		t.Fatal(err)
	}
	id, _ := strconv.ParseInt(first.ID, 10, 64)
	if first.Revision != "1" || first.Status != "captured" || first.AuthorAccountID != strconv.FormatInt(f.tokens[0].Identity.AccountID, 10) {
		t.Fatalf("invalid version metadata %+v", first)
	}
	_, original, err := f.store.ReadStudy(ctx, owner, f.project, id, 1, "input")
	if err != nil {
		t.Fatal(err)
	}
	_, evidence, err := f.store.ReadStudy(ctx, owner, f.project, id, 1, "provenance")
	if err != nil || archiveDigest(evidence) != first.ProvenanceSHA256 || archiveDigest(original) != first.InputSHA256 {
		t.Fatal("captured bytes/digests mismatch", err)
	}
	for _, session := range f.tokens {
		if bytes.Contains(original, []byte(session.Token)) || bytes.Contains(evidence, []byte(session.Token)) {
			t.Fatal("snapshot contains credentials")
		}
	}
	var payload struct {
		Base       studyBase                     `json:"base"`
		Solver     studySolverOptions            `json:"solverOptions"`
		Ref        struct{ ID, Revision string } `json:"studyReference"`
		Components []calculationComponent        `json:"components"`
	}
	if json.Unmarshal(original, &payload) != nil || payload.Base != f.doc.Base || payload.Solver != f.doc.Solver || payload.Ref.ID != first.ID || payload.Ref.Revision != "1" {
		t.Fatal("snapshot lost explicit options or identity")
	}
	if _, err = f.store.database.Exec(`UPDATE scheme_component_params SET param_value='0.1' WHERE scheme_component_id=$1 AND param_key='p'`, f.load); err != nil {
		t.Fatal(err)
	}
	replay, err := f.store.SaveStudy(ctx, owner, f.project, f.scheme, 0, 0, f.topology, studyCommand(1), f.doc)
	if err != nil || replay.ID != first.ID || replay.InputSHA256 != first.InputSHA256 {
		t.Fatal("retry recaptured mutable source", err)
	}
	changed := f.doc
	changed.Name = "Different command"
	if _, err = f.store.SaveStudy(ctx, owner, f.project, f.scheme, 0, 0, f.topology, studyCommand(1), changed); !errors.Is(err, errStudyCommand) {
		t.Fatal("command reuse not rejected", err)
	}
	second, err := f.store.SaveStudy(ctx, owner, f.project, 0, id, 1, f.topology, studyCommand(2), f.doc)
	if err != nil || second.Revision != "2" || second.InputSHA256 == first.InputSHA256 {
		t.Fatal("new source version missing", err)
	}
	_, later, err := f.store.ReadStudy(ctx, owner, f.project, id, 1, "input")
	if err != nil || !bytes.Equal(original, later) {
		t.Fatal("old network changed", err)
	}
	_, updated, err := f.store.ReadStudy(ctx, owner, f.project, id, 2, "input")
	if err != nil || !bytes.Contains(updated, []byte(`"p":"0.1"`)) {
		t.Fatal("new version did not capture edited parameters", err)
	}
	// Both sessions start from revision 2. Exactly one may append revision 3.
	var wg sync.WaitGroup
	outcomes := make(chan error, 2)
	for i := 0; i < 2; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			_, err := f.store.SaveStudy(ctx, f.tokens[i].Token, f.project, 0, id, 2, f.topology, studyCommand(3+i), f.doc)
			outcomes <- err
		}(i)
	}
	wg.Wait()
	close(outcomes)
	success, conflicts := 0, 0
	for err := range outcomes {
		if err == nil {
			success++
		} else if errors.Is(err, errStudyConflict) {
			conflicts++
		} else {
			t.Fatal(err)
		}
	}
	if success != 1 || conflicts != 1 {
		t.Fatalf("lost-update guard: success=%d conflict=%d", success, conflicts)
	}
	if _, _, err = f.store.ReadStudy(ctx, f.tokens[2].Token, f.project, id, 1, "input"); err != nil {
		t.Fatal("viewer cannot read history", err)
	}
	if _, err = f.store.SaveStudy(ctx, f.tokens[2].Token, f.project, 0, id, 3, f.topology, studyCommand(5), f.doc); !errors.Is(err, sql.ErrNoRows) {
		t.Fatal("viewer wrote Study", err)
	}
	if _, _, err = f.store.ReadStudy(ctx, f.tokens[3].Token, f.project, id, 1, "input"); !errors.Is(err, sql.ErrNoRows) {
		t.Fatal("foreign account read snapshot", err)
	}
	otherProject, err := f.store.Create(ctx, owner, "Other owned project")
	if err != nil {
		t.Fatal(err)
	}
	if _, _, err = f.store.ReadStudy(ctx, owner, otherProject, id, 1, "input"); !errors.Is(err, sql.ErrNoRows) {
		t.Fatal("accessible project ID authorized a different project's Study", err)
	}
	if _, err = f.store.database.Exec(`INSERT INTO project_studies(project_id,scheme_id,current_revision,created_by) VALUES($1,$2,1,$3)`, otherProject, f.scheme, f.tokens[0].Identity.AccountID); err == nil || !strings.Contains(err.Error(), "Study source must belong") {
		t.Fatal("SQL source ownership guard missing", err)
	}
	for _, query := range []string{`UPDATE project_study_versions SET input_body='{}'::bytea WHERE study_id=$1`, `DELETE FROM project_study_versions WHERE study_id=$1 AND revision=1`, `UPDATE project_studies SET current_revision=7 WHERE id=$1`} {
		if _, err = f.store.database.Exec(query, id); err == nil {
			t.Fatal("SQL bypassed immutable history/head")
		}
	}
	if _, err = f.store.database.Exec(`UPDATE project_studies SET current_revision=current_revision+1 WHERE id=$1`, id); err == nil {
		t.Fatal("head accepted a missing version")
	}
	if _, err = f.store.SaveStudy(ctx, owner, f.project, 0, id, 3, f.topology+1, studyCommand(20), f.doc); !errors.Is(err, errStudyTopology) {
		t.Fatal("wrong source revision accepted", err)
	}
	down, err := os.ReadFile(filepath.Join("..", "database", "migrations", "20261024001_project_studies.down.sql"))
	if err != nil {
		t.Fatal(err)
	}
	if _, err = f.store.database.Exec(string(down)); err == nil {
		t.Fatal("downgrade discarded history")
	}
	if err = (sessionStore{database: f.store.database}).Revoke(ctx, f.tokens[2].Token, f.tokens[2].Identity.SessionID); err != nil {
		t.Fatal(err)
	}
	if _, _, err = f.store.ReadStudy(ctx, f.tokens[2].Token, f.project, id, 1, "input"); !errors.Is(err, sql.ErrNoRows) {
		t.Fatal("revoked session read history", err)
	}
	if _, err = f.store.database.Exec(`DELETE FROM circuit_schemes WHERE id=$1`, f.scheme); err != nil {
		t.Fatal(err)
	}
	if _, body, err := f.store.ReadStudy(ctx, owner, f.project, id, 1, "input"); err != nil || !bytes.Equal(body, original) {
		t.Fatal("scheme deletion erased history", err)
	}
	if replay, err := f.store.SaveStudy(ctx, owner, f.project, f.scheme, 0, 0, f.topology, studyCommand(1), f.doc); err != nil || replay.InputSHA256 != first.InputSHA256 {
		t.Fatal("source deletion broke command replay", err)
	}
	if _, err = f.store.database.Exec(`DELETE FROM projects WHERE id=$1`, f.project); err != nil {
		t.Fatal("project privacy deletion failed", err)
	}
}

func TestStudyHTTPIsolationAndRevisionPostgres(t *testing.T) {
	f := newStudyFixture(t)
	auth := newAuthHTTP(f.store.database, "https://frontend.example", true)
	handler := projectsHTTP{auth: auth}
	if _, err := f.store.database.Exec(`SELECT setval(pg_get_serial_sequence('project_studies','id'),9007199254740993,false)`); err != nil {
		t.Fatal(err)
	}
	body, _ := json.Marshal(map[string]any{"topologyRevision": strconv.FormatInt(f.topology, 10), "document": f.doc})
	request := func(actor int, method, path, command, tag string, data []byte, headers ...http.Header) *httptest.ResponseRecorder {
		r := httptest.NewRequest(method, path, bytes.NewReader(data))
		r.Header.Set("Origin", auth.origin)
		r.Header.Set("Content-Type", "application/json")
		for _, header := range headers {
			for key, values := range header {
				for _, value := range values {
					r.Header.Add(key, value)
				}
			}
		}
		if actor >= 0 {
			r.AddCookie(&http.Cookie{Name: auth.cookieName(), Value: f.tokens[actor].Token})
		}
		if command != "" {
			r.Header.Set("Idempotency-Key", command)
		}
		if tag != "" {
			r.Header.Set("If-Match", tag)
		}
		w := httptest.NewRecorder()
		handler.ServeHTTP(w, r)
		return w
	}
	create := fmt.Sprintf("/api/projects/%d/schemes/%d/studies", f.project, f.scheme)
	if w := request(-1, "POST", create, studyCommand(1), "", body); w.Code != 401 {
		t.Fatal("anonymous create", w.Code)
	}
	if w := request(2, "POST", create, studyCommand(1), "", body); w.Code != 404 {
		t.Fatal("viewer create", w.Code)
	}
	w := request(0, "POST", create, studyCommand(1), "", body)
	if w.Code != 201 || w.Header().Get("ETag") != `"1"` {
		t.Fatalf("create %d %s", w.Code, w.Body.String())
	}
	var first studyVersion
	if json.Unmarshal(w.Body.Bytes(), &first) != nil || first.ID != "9007199254740993" {
		t.Fatal("wire Study ID lost precision")
	}
	bound := http.Header{"X-Enersy-Account-Id": {strconv.FormatInt(f.tokens[0].Identity.AccountID, 10)}, "X-Enersy-Session-Id": {strconv.FormatInt(f.tokens[0].Identity.SessionID, 10)}}
	if w := request(0, "POST", create, studyCommand(1), "", body, bound); w.Code != 201 {
		t.Fatal("bound replay", w.Code)
	}
	if w := request(1, "POST", create, studyCommand(99), "", body, bound); w.Code != 409 || !strings.Contains(w.Body.String(), "study_session_changed") {
		t.Fatal("changed account accepted", w.Code)
	}
	old := f.tokens[0]
	newSession, issueErr := (sessionStore{database: f.store.database}).Issue(context.Background(), old.Identity.AccountID, time.Hour)
	if issueErr != nil {
		t.Fatal(issueErr)
	}
	f.tokens[0] = newSession
	if w := request(0, "POST", create, studyCommand(99), "", body, bound); w.Code != 409 {
		t.Fatal("changed session accepted", w.Code)
	}
	f.tokens[0] = old
	duplicate := bound.Clone()
	duplicate.Add("X-Enersy-Session-Id", bound.Get("X-Enersy-Session-Id"))
	if w := request(0, "POST", create, studyCommand(99), "", body, duplicate); w.Code != 400 {
		t.Fatal("duplicate identity accepted", w.Code)
	}
	var count int
	if err := f.store.database.QueryRow(`SELECT count(*) FROM project_study_versions WHERE project_id=$1`, f.project).Scan(&count); err != nil || count != 1 {
		t.Fatal("identity mismatch changed history", count, err)
	}
	base := fmt.Sprintf("/api/projects/%d/studies/%s", f.project, first.ID)
	for _, path := range []string{base, base + "/versions/1", base + "/versions/1/input", base + "/versions/1/provenance", base + "/versions"} {
		if w := request(2, "GET", path, "", "", nil); w.Code != 200 || !strings.Contains(w.Header().Get("Cache-Control"), "no-store") {
			t.Fatalf("viewer read: %s %d", path, w.Code)
		}
		if w := request(3, "GET", path, "", "", nil); w.Code != 404 {
			t.Fatalf("foreign read %s %d", path, w.Code)
		}
	}
	if w := request(0, "POST", base+"/versions", studyCommand(2), "", body); w.Code != 428 {
		t.Fatal("missing CAS", w.Code)
	}
	if w := request(0, "POST", base+"/versions", studyCommand(2), `"1"`, body); w.Code != 201 || w.Header().Get("ETag") != `"2"` {
		t.Fatalf("append %d %s", w.Code, w.Body.String())
	}
	if w := request(1, "POST", base+"/versions", studyCommand(3), `"1"`, body); w.Code != 412 {
		t.Fatal("stale write", w.Code)
	}
	if w := request(0, "POST", base+"/versions", studyCommand(2), `"1"`, body); w.Code != 201 {
		t.Fatal("acknowledgement replay failed", w.Code)
	}
	if w := request(0, "GET", fmt.Sprintf("/api/projects/%d/studies?limit=1", f.project), "", "", nil); w.Code != 200 || !strings.Contains(w.Body.String(), `"nextAfterId":"9007199254740993"`) {
		t.Fatal("head cursor lost precision", w.Body.String())
	}
	for _, data := range [][]byte{[]byte(`{}`), []byte(`null`), append(append([]byte{}, body...), []byte(`{}`)...), []byte(strings.Repeat(" ", 128<<10) + string(body))} {
		w := request(0, "POST", create, studyCommand(10), "", data)
		if w.Code != 400 && w.Code != 413 {
			t.Fatal("invalid create accepted", w.Code)
		}
	}
	if w := request(0, "PUT", base, "", "", body); w.Code != 405 {
		t.Fatal("mutable version endpoint allowed", w.Code)
	}
	if w := request(0, "POST", create, studyCommand(20), "", []byte(strings.Repeat(" ", 128<<10)+string(body))); w.Code != 413 {
		t.Fatal("body limit did not return 413", w.Code)
	}
}

func TestStudyFrozenInputWorkerPostgres(t *testing.T) {
	worker := os.Getenv("TEST_JULIA_URL")
	if worker == "" {
		t.Skip("Set TEST_JULIA_URL for frozen Study physical acceptance")
	}
	f := newStudyFixture(t)
	f.doc.ComputeBackend = "julia-rust-jacobian"
	ctx := context.Background()
	version, err := f.store.SaveStudy(ctx, f.tokens[0].Token, f.project, f.scheme, 0, 0, f.topology, studyCommand(1), f.doc)
	if err != nil {
		t.Fatal(err)
	}
	id, _ := strconv.ParseInt(version.ID, 10, 64)
	_, body, err := f.store.ReadStudy(ctx, f.tokens[0].Token, f.project, id, 1, "input")
	if err != nil {
		t.Fatal(err)
	}
	if _, err = f.store.database.Exec(`UPDATE scheme_component_params SET param_value='0.1' WHERE scheme_component_id=$1 AND param_key='p'`, f.load); err != nil {
		t.Fatal(err)
	}
	client := &http.Client{Timeout: 25 * time.Second}
	for i := 0; i < 2; i++ {
		response, err := client.Post(worker+"/calculate", "application/json", bytes.NewReader(body))
		if err != nil {
			t.Fatal(err)
		}
		result, err := io.ReadAll(response.Body)
		response.Body.Close()
		if err != nil || response.StatusCode != 200 {
			t.Fatalf("frozen source rejected: %d %s %v", response.StatusCode, result, err)
		}
		var decoded struct {
			Success bool `json:"success"`
			Solver  struct {
				Backend struct {
					ID string `json:"id"`
				} `json:"compute_backend"`
			} `json:"solver"`
			Nodes []struct {
				Voltage  float64 `json:"voltage"`
				Internal bool    `json:"is_internal_source_node"`
			} `json:"nodes"`
		}
		if json.Unmarshal(result, &decoded) != nil || !decoded.Success || decoded.Solver.Backend.ID != "julia-rust-jacobian" || len(decoded.Nodes) != 2 {
			t.Fatal("invalid result")
		}
		external := 0
		for _, node := range decoded.Nodes {
			if !node.Internal {
				external++
				if math.Abs(node.Voltage-(1+math.Sqrt(0.2))/2) > 1e-10 {
					t.Fatal("frozen source used edited demand", node.Voltage)
				}
			}
		}
		if external != 1 {
			t.Fatal("missing terminal voltage")
		}
	}
}

func TestStudyQuotaAndEmptyMigrationPostgres(t *testing.T) {
	f := newStudyFixture(t)
	ctx := context.Background()
	owner := f.tokens[0].Token
	// An unused schema can roll the additive migration down/up without data loss.
	for _, migration := range []string{"20261028002_study_run_leases.down", "20261028001_study_run_queue.down", "20261024001_project_studies.down", "20261024001_project_studies.up", "20261028001_study_run_queue.up", "20261028002_study_run_leases.up"} {
		body, err := os.ReadFile(filepath.Join("..", "database", "migrations", migration+".sql"))
		if err != nil {
			t.Fatal(err)
		}
		if _, err = f.store.database.Exec(string(body)); err != nil {
			t.Fatal("empty migration round trip", err)
		}
	}
	var study int64
	for i := 0; i < 100; i++ {
		scheme := 0
		if i == 0 {
			scheme = f.scheme
		}
		version, err := f.store.SaveStudy(ctx, owner, f.project, scheme, study, int64(i), f.topology, studyCommand(i+1), f.doc)
		if err != nil {
			t.Fatalf("version %d: %v", i+1, err)
		}
		study, err = strconv.ParseInt(version.ID, 10, 64)
		if err != nil {
			t.Fatal(err)
		}
	}
	if _, err := f.store.SaveStudy(ctx, owner, f.project, 0, study, 100, f.topology, studyCommand(101), f.doc); !errors.Is(err, errStudyQuota) {
		t.Fatal("history count limit not enforced", err)
	}
	var count int
	if err := f.store.database.QueryRow(`SELECT count(*) FROM project_study_versions`).Scan(&count); err != nil || count != 100 {
		t.Fatal("failed capture changed history", count, err)
	}
}

func TestStudyByteQuotaPostgres(t *testing.T) {
	f := newStudyFixture(t)
	ctx := context.Background()
	owner := f.tokens[0].Token
	// Storage-only fixture: a long but syntactically numeric legacy parameter.
	// No physical result is claimed; captures stay explicitly "captured".
	if _, err := f.store.database.Exec(`UPDATE scheme_component_params SET param_value='0.'||repeat('1',4194304) WHERE scheme_component_id=$1 AND param_key='p'`, f.load); err != nil {
		t.Fatal(err)
	}
	var study int64
	created := 0
	limited := false
	for i := 0; i < 100; i++ {
		scheme := 0
		if i == 0 {
			scheme = f.scheme
		}
		version, err := f.store.SaveStudy(ctx, owner, f.project, scheme, study, int64(created), f.topology, studyCommand(i+1), f.doc)
		if errors.Is(err, errStudyQuota) {
			limited = true
			break
		}
		if err != nil {
			t.Fatal(err)
		}
		created++
		study, _ = strconv.ParseInt(version.ID, 10, 64)
	}
	if !limited || created <= 0 || created >= 100 {
		t.Fatalf("byte quota did not limit before count quota: %d", created)
	}
	var size, head, count int64
	if err := f.store.database.QueryRow(`SELECT count(*),sum(octet_length(input_body)::bigint+octet_length(provenance_body)+octet_length(document::text)) FROM project_study_versions`).Scan(&count, &size); err != nil {
		t.Fatal(err)
	}
	if err := f.store.database.QueryRow(`SELECT current_revision FROM project_studies WHERE id=$1`, study).Scan(&head); err != nil {
		t.Fatal(err)
	}
	if count != int64(created) || head != count || size > 64<<20 {
		t.Fatalf("failed capture changed history or exceeded byte quota: count=%d head=%d size=%d", count, head, size)
	}
}
