package main

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strconv"
	"testing"
	"time"
)

func TestApplicationReadSchemePostgres(t *testing.T) {
	f := newStudyFixture(t)
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	service := applicationService{database: f.store.database}
	command := readSchemeCommand{ProjectID: f.project, SchemeID: f.scheme}
	sessions := sessionStore{database: f.store.database}
	second, err := sessions.Issue(ctx, f.tokens[0].Identity.AccountID, time.Hour)
	if err != nil {
		t.Fatal(err)
	}
	// Explicit unit text and numeric spelling must survive the shared read.
	if _, err := f.store.database.ExecContext(ctx, `UPDATE scheme_component_params
 SET param_value='0.2000',unit_format_version=1,declared_unit='MW'
 WHERE scheme_component_id=$1 AND param_key='p'`, f.load); err != nil {
		t.Fatal(err)
	}
	want, err := service.ReadScheme(ctx, f.tokens[0].Token, command)
	if err != nil || want.ID != strconv.Itoa(f.scheme) || want.ProjectID != strconv.FormatInt(f.project, 10) || len(want.Components) != 2 || len(want.Connections) != 1 {
		t.Fatalf("incomplete application graph: %+v err=%v", want, err)
	}
	var found bool
	for _, component := range want.Components {
		if component.ProjectPassportVersionID == nil || *component.ProjectPassportVersionID != nil {
			t.Fatal("project passport null contract changed")
		}
		if component.ID == strconv.Itoa(f.load) {
			found = true
			if component.Params["p"] != "0.2000" || component.DeclaredParameterUnits == nil || component.DeclaredParameterUnits.Units["p"] != "MW" {
				t.Fatalf("parameter value or units changed: %+v", component)
			}
		}
	}
	if !found {
		t.Fatal("load is absent")
	}
	// All permitted roles and a second session observe the same graph. Nothing
	// is cached on the service under a global 'current project' or user.
	for _, token := range []string{f.tokens[0].Token, f.tokens[1].Token, f.tokens[2].Token, second.Token} {
		got, err := service.ReadScheme(ctx, token, command)
		if err != nil || !reflect.DeepEqual(want, got) {
			t.Fatalf("permitted session got a different graph: %v", err)
		}
	}
	auth := newAuthHTTP(f.store.database, "https://frontend.example", true)
	request := httptest.NewRequest(http.MethodGet, fmt.Sprintf("/api/projects/%d/schemes/%d", f.project, f.scheme), nil).WithContext(ctx)
	request.AddCookie(&http.Cookie{Name: auth.cookieName(), Value: f.tokens[2].Token})
	response := httptest.NewRecorder()
	(projectsHTTP{auth: auth}).ServeHTTP(response, request)
	// Compare the wire documents: encoding/json intentionally treats an
	// explicit null and an omitted **string identically when decoding a struct.
	wantBytes, err := json.Marshal(want)
	if err != nil {
		t.Fatal(err)
	}
	var fromHTTP, fromApplication any
	if err := json.Unmarshal(wantBytes, &fromApplication); err != nil {
		t.Fatal(err)
	}
	if response.Code != http.StatusOK || json.Unmarshal(response.Body.Bytes(), &fromHTTP) != nil || !reflect.DeepEqual(fromApplication, fromHTTP) || response.Header().Get("Cache-Control") != "no-store" {
		t.Fatalf("editor and application reads differ: %d %s", response.Code, response.Body.String())
	}
	for _, token := range append([]issuedSession{second}, f.tokens[:]...) {
		if bytes.Contains(response.Body.Bytes(), []byte(token.Token)) {
			t.Fatal("credentials leaked into graph")
		}
	}
	denied := func(token string, input readSchemeCommand) {
		t.Helper()
		got, err := service.ReadScheme(ctx, token, input)
		if (!errors.Is(err, sql.ErrNoRows) && !errors.Is(err, errProjectUnavailable)) || !reflect.DeepEqual(got, schemeGraph[string]{}) {
			t.Fatalf("unavailable scope returned data: %+v %v", got, err)
		}
	}
	denied(f.tokens[3].Token, command)
	denied("", command)
	denied("invalid-token", command)
	denied(f.tokens[0].Token, readSchemeCommand{SchemeID: f.scheme})
	denied(f.tokens[0].Token, readSchemeCommand{ProjectID: f.project})
	foreign, err := f.store.Create(ctx, f.tokens[3].Token, "Other private project")
	if err != nil {
		t.Fatal(err)
	}
	foreignScheme, err := f.store.CreateScheme(ctx, f.tokens[3].Token, foreign, "Other graph", "")
	if err != nil {
		t.Fatal(err)
	}
	denied(f.tokens[0].Token, readSchemeCommand{ProjectID: f.project, SchemeID: int(foreignScheme)})
	denied(f.tokens[3].Token, readSchemeCommand{ProjectID: foreign, SchemeID: f.scheme})
	// Previously successful reads grant no access after a membership/session
	// revocation. Revoking one session leaves the owner's other session usable.
	if _, err := f.store.ChangeMember(ctx, f.tokens[0].Token, f.project, f.tokens[2].Identity.AccountID, 2, "", true); err != nil {
		t.Fatal(err)
	}
	denied(f.tokens[2].Token, command)
	if err := sessions.Revoke(ctx, second.Token, f.tokens[0].Identity.SessionID); err != nil {
		t.Fatal(err)
	}
	denied(f.tokens[0].Token, command)
	if _, err := service.ReadScheme(ctx, second.Token, command); err != nil {
		t.Fatal("independent owner session lost access", err)
	}
	cancelled, stop := context.WithCancel(ctx)
	stop()
	if _, err := service.ReadScheme(cancelled, second.Token, command); !errors.Is(err, context.Canceled) {
		t.Fatal("read ignored cancellation", err)
	}
}
