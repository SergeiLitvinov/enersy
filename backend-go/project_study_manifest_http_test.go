package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"
)

func TestStudyManifestHTTPPostgres(t *testing.T) {
	f := newStudyFixture(t)
	auth := newAuthHTTP(f.store.database, "https://frontend.example", true)
	handler := projectsHTTP{auth: auth}
	source := func() []studySourceRevision {
		t.Helper()
		input, err := readCalculationInputScope(context.Background(), f.store.database, f.scheme, f.project, f.tokens[0].Token, true)
		if err != nil {
			t.Fatal(err)
		}
		manifest := []studySourceRevision{}
		for _, c := range input.Components {
			manifest = append(manifest, studySourceRevision{strconv.Itoa(c.ID), strconv.FormatInt(c.Revision, 10)})
		}
		return manifest
	}
	request := func(actor int, path, command, tag string, manifest any) *httptest.ResponseRecorder {
		t.Helper()
		payload := map[string]any{"document": f.doc, "topologyRevision": strconv.FormatInt(f.topology, 10)}
		if digest, ok := manifest.(string); ok {
			payload["sourceDigest"] = digest
		} else {
			payload["sourceRevisions"] = manifest
		}
		body, err := json.Marshal(payload)
		if err != nil {
			t.Fatal(err)
		}
		r := httptest.NewRequest(http.MethodPost, path, bytes.NewReader(body))
		r.Header.Set("Origin", auth.origin)
		r.Header.Set("Content-Type", "application/json")
		r.Header.Set("Idempotency-Key", command)
		if tag != "" {
			r.Header.Set("If-Match", tag)
		}
		r.AddCookie(&http.Cookie{Name: auth.cookieName(), Value: f.tokens[actor].Token})
		w := httptest.NewRecorder()
		handler.ServeHTTP(w, r)
		return w
	}
	requireStatus := func(w *httptest.ResponseRecorder, status int, code string) {
		t.Helper()
		if w.Code != status || code != "" && !strings.Contains(w.Body.String(), code) {
			t.Fatalf("HTTP %d: %s", w.Code, w.Body.String())
		}
	}
	create := fmt.Sprintf("/api/projects/%d/schemes/%d/studies", f.project, f.scheme)
	observed := source()
	firstReply := request(0, create, studyCommand(881), "", observed)
	requireStatus(firstReply, 201, "")
	var first studyVersion
	if err := json.Unmarshal(firstReply.Body.Bytes(), &first); err != nil {
		t.Fatal(err)
	}
	appendPath := fmt.Sprintf("/api/projects/%d/studies/%s/versions", f.project, first.ID)
	change := func(p string) {
		t.Helper()
		if _, err := f.store.database.Exec(`UPDATE scheme_component_params SET param_value=$2 WHERE scheme_component_id=$1 AND param_key='p'`, f.load, p); err != nil {
			t.Fatal(err)
		}
	}
	change("0.1")
	requireStatus(request(0, appendPath, studyCommand(882), `"1"`, observed), 412, "study_source_conflict")
	var count int
	if err := f.store.database.QueryRow(`SELECT count(*) FROM project_study_versions WHERE project_id=$1`, f.project).Scan(&count); err != nil || count != 1 {
		t.Fatalf("partial version: %d %v", count, err)
	}
	refreshed := source()
	secondReply := request(0, appendPath, studyCommand(882), `"1"`, refreshed)
	requireStatus(secondReply, 201, "")
	if secondReply.Header().Get("ETag") != `"2"` {
		t.Fatal("missing version confirmation")
	}
	var second studyVersion
	if err := json.Unmarshal(secondReply.Body.Bytes(), &second); err != nil {
		t.Fatal(err)
	}
	change("0.05")
	replay := request(0, appendPath, studyCommand(882), `"1"`, refreshed)
	requireStatus(replay, 201, "")
	var restored studyVersion
	if err := json.Unmarshal(replay.Body.Bytes(), &restored); err != nil || restored.Revision != "2" || restored.InputSHA256 != second.InputSHA256 {
		t.Fatal("append replay changed capture", err)
	}
	requireStatus(request(0, appendPath, studyCommand(882), `"1"`, source()), 409, "study_command_conflict")
	requireStatus(request(2, create, studyCommand(883), "", source()), 404, "")
	for _, bad := range []any{[]studySourceRevision{refreshed[0], refreshed[0]}, []map[string]any{{"id": 1, "revision": "1"}}, []map[string]any{{"id": "1", "revision": "01"}}, []map[string]any{{"id": "1", "revision": "1", "extra": true}}} {
		requireStatus(request(0, create, studyCommand(884), "", bad), 400, "")
	}
	if err := f.store.database.QueryRow(`SELECT count(*) FROM project_study_versions WHERE project_id=$1`, f.project).Scan(&count); err != nil || count != 2 {
		t.Fatalf("replay/invalid write created version: %d %v", count, err)
	}
	input, err := readCalculationInputScope(context.Background(), f.store.database, f.scheme, f.project, f.tokens[0].Token, true)
	if err != nil {
		t.Fatal(err)
	}
	digest := studySourceDigest(f.scheme, input.Components)
	compact := request(0, create, studyCommand(885), "", digest)
	requireStatus(compact, 201, "")
	change("0.025")
	requireStatus(request(0, create, studyCommand(886), "", digest), 412, "study_source_conflict")
	replayed := request(0, create, studyCommand(885), "", digest)
	requireStatus(replayed, 201, "")
	if !bytes.Equal(compact.Body.Bytes(), replayed.Body.Bytes()) {
		t.Fatal("digest replay changed version")
	}
	requireStatus(request(0, create, studyCommand(887), "", "v2:"+strings.Repeat("a", 64)), 400, "")
	if err := f.store.database.QueryRow(`SELECT count(*) FROM project_study_versions WHERE project_id=$1`, f.project).Scan(&count); err != nil || count != 3 {
		t.Fatalf("digest refusal created a version: %d %v", count, err)
	}
}
