package main

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"
)

func TestProjectPassportBindingPostgres(t *testing.T) {
	database := migrationTestDatabase(t)
	if err := runMigrationsFromSource(database, migrationSourceURL(t)); err != nil {
		t.Fatal(err)
	}
	// An unused migration can be reverted and applied again. Once references
	// exist, the same down path must refuse to discard them (checked below).
	for _, suffix := range []string{"down", "up"} {
		data, err := os.ReadFile(filepath.Join("..", "database", "migrations", "20261021001_component_passport_binding."+suffix+".sql"))
		if err != nil {
			t.Fatal(err)
		}
		if _, err := database.Exec(string(data)); err != nil {
			t.Fatal(err)
		}
	}
	ctx, cancel := context.WithTimeout(context.Background(), 45*time.Second)
	defer cancel()
	var account int64
	if err := database.QueryRowContext(ctx, `INSERT INTO auth_accounts(display_name) VALUES('Binding fixture') RETURNING id`).Scan(&account); err != nil {
		t.Fatal(err)
	}
	session, err := (sessionStore{database: database}).Issue(ctx, account, time.Hour)
	if err != nil {
		t.Fatal(err)
	}
	store := projectStore{database: database}
	project, err := store.Create(ctx, session.Token, "Bound project")
	if err != nil {
		t.Fatal(err)
	}
	foreign, err := store.Create(ctx, session.Token, "Other owned project")
	if err != nil {
		t.Fatal(err)
	}
	scheme, err := store.CreateScheme(ctx, session.Token, project, "Source", "")
	if err != nil {
		t.Fatal(err)
	}
	otherScheme, err := store.CreateScheme(ctx, session.Token, foreign, "Other", "")
	if err != nil {
		t.Fatal(err)
	}
	var typeID, otherTypeID int
	if err := database.QueryRowContext(ctx, `SELECT id FROM component_types WHERE code='generator'`).Scan(&typeID); err != nil {
		t.Fatal(err)
	}
	if err := database.QueryRowContext(ctx, `SELECT id FROM component_types WHERE code='transformer'`).Scan(&otherTypeID); err != nil {
		t.Fatal(err)
	}
	doc := passportFixture()
	doc.Parameters = map[string]passportParameter{"power_nom": {Value: "10.00", Unit: "МВА"}}
	first, err := store.SavePassport(ctx, session.Token, project, "11111111-0000-4000-8000-000000000001", nil, doc)
	if err != nil {
		t.Fatal(err)
	}
	parent, _ := strconv.ParseInt(first.ID, 10, 64)
	if _, _, _, err := createComponent(ctx, database, createComponentRequest{SchemeID: int(scheme), TypeID: typeID, ProjectPassportVersionID: &parent}); err == nil {
		t.Fatal("legacy creation accepted a project passport")
	}
	auth := newAuthHTTP(database, "https://frontend.example", true)
	handler := projectsHTTP{auth: auth}
	request := func(method, path, body, tag string) *httptest.ResponseRecorder {
		r := httptest.NewRequest(method, path, strings.NewReader(body))
		r.Header.Set("Origin", auth.origin)
		r.Header.Set("Content-Type", "application/json")
		r.AddCookie(&http.Cookie{Name: auth.cookieName(), Value: session.Token})
		if tag != "" {
			r.Header.Set("If-Match", tag)
		}
		w := httptest.NewRecorder()
		handler.ServeHTTP(w, r)
		return w
	}
	path := fmt.Sprintf("/api/projects/%d/schemes/%d", project, scheme)
	body := fmt.Sprintf(`{"typeId":"%d","projectPassportVersionId":"%s","equipmentModelId":null,"x":1,"y":2,"rotation":0,"name":"Bound source","params":{}}`, typeID, first.ID)
	w := request(http.MethodPost, path+"/components", body, "")
	if w.Code != 201 {
		t.Fatalf("creation %d %s", w.Code, w.Body)
	}
	var created struct {
		Declaration              *parameterUnitDeclaration `json:"declaredParameterUnits"`
		ID, Revision             string
		ProjectPassportVersionID *string `json:"projectPassportVersionId"`
		Params                   map[string]string
	}
	if err := json.Unmarshal(w.Body.Bytes(), &created); err != nil {
		t.Fatal(err)
	}
	if created.ProjectPassportVersionID == nil || *created.ProjectPassportVersionID != first.ID || len(created.Params) != 1 || created.Params["power_nom"] != "10.00" {
		t.Fatalf("source copy not exact: %s", w.Body)
	}
	if created.Declaration == nil || created.Declaration.FormatVersion != 1 || created.Declaration.Units["power_nom"] != "МВА" {
		t.Fatal("creation acknowledgement lost passport units", w.Body.String())
	}
	// Same account owns both projects: authorization to one does not permit
	// silently binding its passport into another graph.
	foreignPath := fmt.Sprintf("/api/projects/%d/schemes/%d", foreign, otherScheme)
	if w := request(http.MethodPost, foreignPath+"/components", body, ""); w.Code != 404 {
		t.Fatalf("cross-project bind accepted: %d %s", w.Code, w.Body)
	}
	for _, invalid := range []string{
		strings.Replace(body, `"equipmentModelId":null`, `"equipmentModelId":"1"`, 1),
		strings.Replace(body, fmt.Sprintf(`"typeId":"%d"`, typeID), fmt.Sprintf(`"typeId":"%d"`, otherTypeID), 1),
		strings.Replace(body, fmt.Sprintf(`"typeId":"%d"`, typeID), `"typeId":"2147483647"`, 1),
		strings.Replace(body, `"params":{}`, `"params":{"unknown":"3"}`, 1),
		strings.Replace(body, `"params":{}`, `"params":{"power_nom":"NaN"}`, 1),
	} {
		if w := request(http.MethodPost, path+"/components", invalid, ""); w.Code != 400 {
			t.Fatalf("invalid bind accepted: %d %s", w.Code, w.Body)
		}
	}
	overrideBody := strings.Replace(body, `"params":{}`, `"params":{"power_nom":"12.00","voltage_nom":"10.5"}`, 1)
	if w := request(http.MethodPost, path+"/components", overrideBody, ""); w.Code != 201 {
		t.Fatalf("typed overrides: %d %s", w.Code, w.Body)
	}
	frozen, err := readCalculationInputScope(ctx, database, int(scheme), project, session.Token, true)
	if err != nil {
		t.Fatal(err)
	}
	doc.Parameters["power_nom"] = passportParameter{Value: "25.00", Unit: "МВА"}
	second, err := store.SavePassport(ctx, session.Token, project, "11111111-0000-4000-8000-000000000002", &parent, doc)
	if err != nil {
		t.Fatal(err)
	}
	w = request(http.MethodGet, path, "", "")
	if w.Code != 200 {
		t.Fatal(w.Body)
	}
	var graph struct {
		Components []struct {
			Declaration              *parameterUnitDeclaration `json:"declaredParameterUnits"`
			ID                       string
			ProjectPassportVersionID *string `json:"projectPassportVersionId"`
			Params                   map[string]string
		}
	}
	if err := json.Unmarshal(w.Body.Bytes(), &graph); err != nil {
		t.Fatal(err)
	}
	if len(graph.Components) != 2 {
		t.Fatalf("unexpected components: %s", w.Body)
	}
	for _, component := range graph.Components {
		if component.ProjectPassportVersionID == nil || *component.ProjectPassportVersionID != first.ID {
			t.Fatal("binding followed newest version")
		}
		expected := "12.00"
		if component.ID == created.ID {
			expected = "10.00"
		}
		if component.Params["power_nom"] != expected {
			t.Fatal("old instance changed with passport update")
		}
		if component.Declaration == nil || component.Declaration.Units["power_nom"] != "МВА" {
			t.Fatal("graph lost copied passport unit")
		}
	}
	w = request(http.MethodPost, path+"/components/"+created.ID+"/params", `{"key":"power_nom","value":"15.00"}`, `"`+created.Revision+`"`)
	if w.Code != 200 {
		t.Fatalf("instance override %d %s", w.Code, w.Body)
	}
	originals, err := store.ReadPassports(ctx, session.Token, project, 0, 1, &parent)
	if err != nil || originals[0].Document.Parameters["power_nom"].Value != "10.00" {
		t.Fatal("instance edit changed catalog")
	}
	// A transport/storage fixture, not an electrical reference result. Archive
	// the previously captured state after both catalog and object have changed.
	payload, err := json.Marshal(map[string]any{"components": frozen.Components, "connections": frozen.Connections, "modelGroup": "three-phase", "method": "newton-raphson"})
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(payload), "passport") || strings.Contains(string(payload), "source") {
		t.Fatal("audit evidence leaked into worker input")
	}
	result := []byte(`{"success":true,"node_count":1,"nodes":[{"node_id":1}],"method_used":"three-phase/newton-raphson","version":"transport-fixture"}`)
	archive, err := store.SaveCalculationArchive(ctx, session.Token, project, int(scheme), frozen, "three-phase", "newton-raphson", payload, result)
	if err != nil {
		t.Fatal(err)
	}
	meta, savedInput, _, err := store.CalculationArchive(ctx, session.Token, project, archive)
	if err != nil || string(savedInput) != string(payload) || string(meta.provenance) != string(frozen.Provenance) || meta.ProvenanceSHA256 != archiveDigest(frozen.Provenance) {
		t.Fatal("archive lost historical evidence", err)
	}
	var evidence calculationProvenance
	if err := json.Unmarshal(meta.provenance, &evidence); err != nil {
		t.Fatal(err)
	}
	if len(evidence.Components) != 2 || evidence.Components[0].Passport.VersionID != first.ID || evidence.Components[0].Passport.Document.Parameters["power_nom"].Value != "10.00" || frozen.Components[1].Params["power_nom"] != "12.00" {
		t.Fatal("archive substituted current values")
	}
	archivePath := fmt.Sprintf("/api/projects/%d/calculation-archives/%d/provenance", project, archive)
	if w := request(http.MethodGet, archivePath, "", ""); w.Code != 200 || w.Body.String() != string(frozen.Provenance) || w.Header().Get("ETag") != `"`+meta.ProvenanceSHA256+`"` {
		t.Fatal("provenance HTTP lost bytes or digest")
	}
	if w := request(http.MethodGet, strings.Replace(archivePath, fmt.Sprintf("/projects/%d/", project), fmt.Sprintf("/projects/%d/", foreign), 1), "", ""); w.Code != 404 {
		t.Fatal("cross-project archive evidence exposed")
	}
	old := frozen
	old.Provenance = nil
	historical, err := store.SaveCalculationArchive(ctx, session.Token, project, int(scheme), old, "three-phase", "newton-raphson", payload, result)
	if err != nil {
		t.Fatal(err)
	}
	if w := request(http.MethodGet, fmt.Sprintf("/api/projects/%d/calculation-archives/%d/provenance", project, historical), "", ""); w.Code != 404 {
		t.Fatal("historical provenance manufactured")
	}
	provenanceDown, err := os.ReadFile(filepath.Join("..", "database", "migrations", "20261021002_calculation_provenance.down.sql"))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := database.ExecContext(ctx, string(provenanceDown)); err == nil {
		t.Fatal("downgrade discarded archived provenance")
	}
	for _, sqlText := range []string{
		`UPDATE scheme_components SET project_passport_version_id=NULL WHERE id=$1`,
		`UPDATE scheme_components SET scheme_id=` + strconv.FormatInt(otherScheme, 10) + ` WHERE id=$1`,
		`UPDATE scheme_components SET project_passport_version_id=` + second.ID + ` WHERE id=$1`,
	} {
		if _, err := database.ExecContext(ctx, sqlText, created.ID); err == nil {
			t.Fatal("SQL bypassed binding invariant")
		}
	}
	if _, err := database.ExecContext(ctx, `UPDATE circuit_schemes SET project_id=$1 WHERE id=$2`, foreign, scheme); err == nil {
		t.Fatal("SQL reparent bypassed scope invariant")
	}
	// Changed declared units must not reinterpret a previously saved value.
	if _, err := database.ExecContext(ctx, `UPDATE component_params_template SET unit='Вт' WHERE component_type_id=$1 AND param_key='power_nom'`, typeID); err != nil {
		t.Fatal(err)
	}
	if w := request(http.MethodPost, path+"/components", body, ""); w.Code != 400 {
		t.Fatal("changed units accepted")
	}
	currentInput, err := readCalculationInputScope(ctx, database, int(scheme), project, session.Token, false)
	if err != nil {
		t.Fatal(err)
	}
	for _, component := range currentInput.Components {
		if component.ParameterUnits["power_nom"] != "МВА" {
			t.Fatal("template reinterpreted a copied passport value", component)
		}
	}
	down, err := os.ReadFile(filepath.Join("..", "database", "migrations", "20261021001_component_passport_binding.down.sql"))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := database.ExecContext(ctx, string(down)); err == nil {
		t.Fatal("downgrade discarded used provenance")
	}
	var count int
	if err := database.QueryRowContext(ctx, `SELECT count(*) FROM scheme_components WHERE project_passport_version_id=$1`, parent).Scan(&count); err != nil || count != 2 {
		t.Fatalf("failed writes/downgrade changed bindings: %d %v", count, err)
	}
	// Existing project deletion requires deleting its schemes first.
	if _, err := database.ExecContext(ctx, `DELETE FROM circuit_schemes WHERE id=$1`, scheme); err != nil {
		t.Fatalf("scheme deletion with bound passports: %v", err)
	}
	retained, _, _, err := store.CalculationArchive(ctx, session.Token, project, archive)
	if err != nil || string(retained.provenance) != string(frozen.Provenance) {
		t.Fatal("scheme deletion changed historical passport evidence", err)
	}
	// Simulate storage corruption in this disposable schema only. Restore the
	// immutability guard before invoking the public reader.
	if _, err := database.ExecContext(ctx, `ALTER TABLE project_calculation_archives DISABLE TRIGGER calculation_archive_immutable`); err != nil {
		t.Fatal(err)
	}
	if _, err := database.ExecContext(ctx, `UPDATE project_calculation_archives SET provenance_body=$1 WHERE id=$2`, []byte(`{"formatVersion":1,"components":[]}`), archive); err != nil {
		t.Fatal(err)
	}
	if _, err := database.ExecContext(ctx, `ALTER TABLE project_calculation_archives ENABLE TRIGGER calculation_archive_immutable`); err != nil {
		t.Fatal(err)
	}
	if w := request(http.MethodGet, archivePath, "", ""); w.Code != 500 {
		t.Fatal("corrupt audit evidence was served")
	}
	if _, err := database.ExecContext(ctx, `DELETE FROM projects WHERE id=$1`, project); err != nil {
		t.Fatalf("project deletion with bound passports: %v", err)
	}
}

func TestProjectPassportUnitCopyScopePostgres(t *testing.T) {
	f := newStudyFixture(t)
	ctx := context.Background()
	var typeID int
	if err := f.store.database.QueryRow(`SELECT id FROM component_types WHERE code='generator'`).Scan(&typeID); err != nil {
		t.Fatal(err)
	}
	if _, err := f.store.database.Exec(`INSERT INTO component_params_template(component_type_id,param_key,param_name,param_type,unit) VALUES($1,'blank_unit_probe','Fixture','number','')`, typeID); err != nil {
		t.Fatal(err)
	}
	doc := passportFixture()
	doc.Parameters = map[string]passportParameter{"power_nom": {Value: "10.00", Unit: "МВА"}, "blank_unit_probe": {Value: "1.0000", Unit: ""}}
	source, err := f.store.SavePassport(ctx, f.tokens[0].Token, f.project, studyCommand(8501), nil, doc)
	if err != nil {
		t.Fatal(err)
	}
	version, _ := strconv.ParseInt(source.ID, 10, 64)
	req := createComponentRequest{SchemeID: f.scheme, TypeID: typeID, Name: "Unit-copy fixture", ProjectPassportVersionID: &version, Params: map[string]string{"power_nom": "12.00", "voltage_nom": "10.5"}}
	created, err := f.store.CreateComponent(ctx, f.tokens[0].Token, f.project, req)
	if err != nil {
		t.Fatal(err)
	}
	if created.DeclaredParameterUnits == nil || len(created.DeclaredParameterUnits.Units) != 1 || created.DeclaredParameterUnits.Units["power_nom"] != "МВА" || created.Params["power_nom"] != "12.00" {
		t.Fatal(created)
	}
	var labels int
	if err := f.store.database.QueryRow(`SELECT count(*) FROM scheme_component_params WHERE scheme_component_id=$1 AND unit_format_version IS NOT NULL`, created.ID).Scan(&labels); err != nil || labels != 1 {
		t.Fatal("blank or extra-override unit was invented", labels, err)
	}
	var value string
	if err := f.store.database.QueryRow(`SELECT param_value FROM scheme_component_params WHERE scheme_component_id=$1 AND param_key='blank_unit_probe'`, created.ID).Scan(&value); err != nil || value != "1.0000" {
		t.Fatal("blank-unit parameter was lost or normalized", value, err)
	}
	// Force a late unit-storage failure in this disposable schema only. Nothing
	// from this new component, including its copied values, may be committed.
	if _, err := f.store.database.Exec(`ALTER TABLE scheme_component_params ADD CONSTRAINT reject_copied_unit CHECK(declared_unit<>'МВА') NOT VALID`); err != nil {
		t.Fatal(err)
	}
	count := func() int {
		t.Helper()
		var n int
		if err := f.store.database.QueryRow(`SELECT count(*) FROM scheme_components WHERE scheme_id=$1`, f.scheme).Scan(&n); err != nil {
			t.Fatal(err)
		}
		return n
	}
	before := count()
	if _, err := f.store.CreateComponent(ctx, f.tokens[0].Token, f.project, req); err == nil || count() != before {
		t.Fatal("unit failure partly created a component", err)
	}
}

func TestCalculationProvenanceUnusedMigrationPostgres(t *testing.T) {
	database := migrationTestDatabase(t)
	if err := runMigrationsFromSource(database, migrationSourceURL(t)); err != nil {
		t.Fatal(err)
	}
	for _, suffix := range []string{"down", "up"} {
		data, err := os.ReadFile(filepath.Join("..", "database", "migrations", "20261021002_calculation_provenance."+suffix+".sql"))
		if err != nil {
			t.Fatal(err)
		}
		if _, err := database.Exec(string(data)); err != nil {
			t.Fatal(err)
		}
	}
}
