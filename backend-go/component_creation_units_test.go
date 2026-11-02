package main

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strconv"
	"strings"
	"testing"
)

func TestCreationUnitDeclarationCodec(t *testing.T) {
	base := `{"schemeId":1,"typeId":2,"x":0,"y":0,"rotation":0,"name":"Fixture","equipmentModelId":null,"params":{"p":"1.0000","q":"2"}}`
	var omitted createComponentRequest
	if err := json.Unmarshal([]byte(base), &omitted); err != nil {
		t.Fatal(err)
	}
	encoded, err := json.Marshal(omitted)
	if err != nil || string(encoded) != base {
		t.Fatal("omitted declaration changed existing command intent bytes", string(encoded), err)
	}
	with := func(declaration string) string {
		return strings.TrimSuffix(base, "}") + `,"parameterUnitDeclaration":` + declaration + `}`
	}
	for _, params := range []string{`null`, `{"p":null,"q":"2"}`, `{"p":"1","p":"2","q":"2"}`} {
		var request createComponentRequest
		input := strings.Replace(base, `{"p":"1.0000","q":"2"}`, params, 1)
		if err := json.Unmarshal([]byte(input), &request); err == nil {
			t.Fatalf("accepted null or ambiguous creation parameters: %s", params)
		}
	}
	var first, reordered createComponentRequest
	for raw, target := range map[string]*createComponentRequest{
		`{"formatVersion":1,"units":{"p":"MW","q":"Mvar"}}`:      &first,
		`{ "units": {"q":"Mvar", "p":"MW"}, "formatVersion":1 }`: &reordered,
	} {
		if err := json.Unmarshal([]byte(with(raw)), target); err != nil {
			t.Fatal(err)
		}
		if err := validateComponentCreation(*target); err != nil {
			t.Fatal(err)
		}
	}
	a, _ := json.Marshal(first)
	b, _ := json.Marshal(reordered)
	if string(a) != string(b) {
		t.Fatal("equivalent declaration changed canonical command intent")
	}
	for _, invalid := range []string{
		`null`, `[]`, `{}`, `{"formatVersion":2,"units":{"p":"MW"}}`,
		`{"formatVersion":1,"units":{}}`, `{"formatVersion":1,"units":{"p":""}}`,
		`{"formatVersion":1,"units":{"p":null}}`, `{"formatVersion":1,"units":{"p":" MW"}}`,
		`{"formatVersion":1,"units":{"p":"MW"},"extra":true}`,
		`{"formatVersion":1,"units":{"p":"MW","p":"W"}}`,
		`{"formatVersion":1,"formatVersion":1,"units":{"p":"MW"}}`,
	} {
		var request createComponentRequest
		if err := json.Unmarshal([]byte(with(invalid)), &request); err == nil {
			t.Fatalf("accepted malformed declaration %s", invalid)
		}
	}
	var missing createComponentRequest
	if err := json.Unmarshal([]byte(with(`{"formatVersion":1,"units":{"voltage_nom":"kV"}}`)), &missing); err != nil {
		t.Fatal(err)
	}
	if validateComponentCreation(missing) == nil {
		t.Fatal("label without an explicit value accepted")
	}
	passport := &parameterUnitDeclaration{1, map[string]string{"p": "MW", "voltage_nom": "kV"}}
	first.unitDeclaration = passport
	merged := creationParameterUnits(first)
	merged.Units["p"] = "W"
	if passport.Units["p"] != "MW" || first.UnitDeclaration.declaration.Units["p"] != "MW" || merged.Units["voltage_nom"] != "kV" {
		t.Fatal("merge mutated source declarations or lost inherited units")
	}
}

func TestCreationUnitsPublicHTTPPostgres(t *testing.T) {
	database := migrationTestDatabase(t)
	if err := runMigrationsFromSource(database, migrationSourceURL(t)); err != nil {
		t.Fatal(err)
	}
	var scheme, typeID, model int
	if err := database.QueryRow(`INSERT INTO circuit_schemes(name) VALUES('Creation units fixture') RETURNING id`).Scan(&scheme); err != nil {
		t.Fatal(err)
	}
	if err := database.QueryRow(`SELECT id FROM component_types WHERE code='generator'`).Scan(&typeID); err != nil {
		t.Fatal(err)
	}
	if err := database.QueryRow(`SELECT id FROM equipment_models WHERE component_type_id=$1 ORDER BY id LIMIT 1`, typeID).Scan(&model); err != nil {
		t.Fatal(err)
	}
	previous := db
	db = database
	t.Cleanup(func() { db = previous })
	request := func(body string) *httptest.ResponseRecorder {
		w := httptest.NewRecorder()
		handleComponents(w, httptest.NewRequest(http.MethodPost, "/api/ees/components", strings.NewReader(body)))
		return w
	}
	body := fmt.Sprintf(`{"schemeId":%d,"typeId":%d,"name":"Declared copy","equipmentModelId":%d,"params":{"p":"1.2300"},"parameterUnitDeclaration":{"formatVersion":1,"units":{"p":"MW"}}}`, scheme, typeID, model)
	w := request(body)
	var created struct {
		ID          int
		Params      map[string]string
		Declaration *parameterUnitDeclaration `json:"declaredParameterUnits"`
	}
	if w.Code != 200 || json.Unmarshal(w.Body.Bytes(), &created) != nil || created.Params["p"] != "1.2300" || created.Declaration == nil || created.Declaration.Units["p"] != "MW" {
		t.Fatal("creation acknowledgement lost explicit pair", w.Code, w.Body)
	}
	var count int
	if err := database.QueryRow(`SELECT count(*) FROM scheme_component_params WHERE scheme_component_id=$1 AND unit_format_version=1 AND declared_unit IS NOT NULL`, created.ID).Scan(&count); err != nil || count != 1 {
		t.Fatal("catalogue/template units inferred", count, err)
	}
	var rawValue, rawUnit string
	if err := database.QueryRow(`SELECT param_value,declared_unit FROM scheme_component_params WHERE scheme_component_id=$1 AND param_key='p'`, created.ID).Scan(&rawValue, &rawUnit); err != nil || rawValue != "1.2300" || rawUnit != "MW" {
		t.Fatal("persisted pair differs", rawValue, rawUnit, err)
	}
	for _, invalid := range []string{
		strings.Replace(body, `"units":{"p":"MW"}`, `"units":{"voltage_nom":"kV"}`, 1),
		strings.Replace(body, `{"formatVersion":1,"units":{"p":"MW"}}`, `null`, 1),
		strings.Replace(body, `"params":{"p":"1.2300"}`, `"params":null`, 1),
		strings.Replace(body, `"params":{"p":"1.2300"}`, `"params":{"p":null}`, 1),
		strings.Replace(body, `"params":{"p":"1.2300"}`, `"params":{"p":"1.2300","p":"1.2300"}`, 1),
	} {
		if w := request(invalid); w.Code != 400 {
			t.Fatal("invalid declaration reached storage", w.Code, w.Body)
		}
	}
	if _, err := database.Exec(`ALTER TABLE scheme_component_params ADD CONSTRAINT reject_creation_unit_fixture CHECK (declared_unit IS DISTINCT FROM 'Reject')`); err != nil {
		t.Fatal(err)
	}
	failed := fmt.Sprintf(`{"schemeId":%d,"typeId":%d,"name":"Rollback fixture","params":{"a_first":"ok","z_last":"1.2300"},"parameterUnitDeclaration":{"formatVersion":1,"units":{"z_last":"Reject"}}}`, scheme, typeID)
	if w := request(failed); w.Code != 500 {
		t.Fatal("forced unit insertion failure accepted", w.Code, w.Body)
	}
	if err := database.QueryRow(`SELECT count(*) FROM scheme_components`).Scan(&count); err != nil || count != 1 {
		t.Fatal("failed creation left an object", count, err)
	}
	if err := database.QueryRow(`SELECT count(*) FROM scheme_component_params WHERE param_key='a_first'`).Scan(&count); err != nil || count != 0 {
		t.Fatal("failed creation left a parameter", count, err)
	}
}

func TestCreationUnitsPrivateCommandPostgres(t *testing.T) {
	f := newStudyFixture(t)
	auth := newAuthHTTP(f.store.database, "https://frontend.example", true)
	var typeID string
	if err := f.store.database.QueryRow(`SELECT id::text FROM component_types WHERE code='busbar'`).Scan(&typeID); err != nil {
		t.Fatal(err)
	}
	body := fmt.Sprintf(`{"typeId":%q,"name":"Declared bus","params":{"voltage_nom":"110.0000","current_nom":"1000"},"parameterUnitDeclaration":{"formatVersion":1,"units":{"voltage_nom":"kV","current_nom":"A"}}}`, typeID)
	request := func(input, token string) *httptest.ResponseRecorder {
		r := httptest.NewRequest(http.MethodPost, fmt.Sprintf("/api/projects/%d/schemes/%d/components", f.project, f.scheme), strings.NewReader(input))
		r.Header.Set("Content-Type", "application/json")
		r.Header.Set("Origin", auth.origin)
		r.Header.Set("Idempotency-Key", studyCommand(890))
		r.Header.Set("If-Match", fmt.Sprintf(`"%d"`, f.topology))
		r.AddCookie(&http.Cookie{Name: auth.cookieName(), Value: token})
		w := httptest.NewRecorder()
		(projectsHTTP{auth: auth}).ServeHTTP(w, r)
		return w
	}
	first := request(body, f.tokens[0].Token)
	if first.Code != 201 || !strings.Contains(first.Body.String(), `"declaredParameterUnits"`) {
		t.Fatal("private receipt lost units", first.Code, first.Body)
	}
	for _, malformed := range []string{
		strings.Replace(body, `"voltage_nom":"110.0000"`, `"voltage_nom":null`, 1),
		strings.Replace(body, `"voltage_nom":"110.0000"`, `"voltage_nom":"110.0000","voltage_nom":"110.0000"`, 1),
	} {
		if invalid := request(malformed, f.tokens[0].Token); invalid.Code != 400 {
			t.Fatal("private creation accepted ambiguous parameters", invalid.Code, invalid.Body)
		}
	}
	reordered := strings.Replace(body, `{"formatVersion":1,"units":{"voltage_nom":"kV","current_nom":"A"}}`, `{"units":{"current_nom":"A","voltage_nom":"kV"},"formatVersion":1}`, 1)
	replay := request(reordered, f.tokens[0].Token)
	if replay.Code != 201 || replay.Header().Get("Idempotency-Replayed") != "true" || replay.Body.String() != first.Body.String() {
		t.Fatal("unit key order changed durable replay", replay.Code, replay.Body)
	}
	if changed := request(strings.Replace(body, `"voltage_nom":"kV"`, `"voltage_nom":"V"`, 1), f.tokens[0].Token); changed.Code != 409 {
		t.Fatal("unit-only intent change reused command", changed.Code, changed.Body)
	}
	for _, actor := range []int{2, 3} {
		if denied := request(body, f.tokens[actor].Token); denied.Code != 404 {
			t.Fatal("viewer or outsider read a creation receipt", denied.Code, denied.Body)
		}
	}
}

func TestCreationUnitsImmutablePassportPostgres(t *testing.T) {
	f := newStudyFixture(t)
	ctx := context.Background()
	var typeID int
	if err := f.store.database.QueryRow(`SELECT id FROM component_types WHERE code='generator'`).Scan(&typeID); err != nil {
		t.Fatal(err)
	}
	doc := passportFixture()
	doc.Parameters = map[string]passportParameter{"power_nom": {Value: "10.00", Unit: "МВА"}, "voltage_nom": {Value: "10.00", Unit: "кВ"}}
	passport, err := f.store.SavePassport(ctx, f.tokens[0].Token, f.project, studyCommand(891), nil, doc)
	if err != nil {
		t.Fatal(err)
	}
	id, _ := strconv.ParseInt(passport.ID, 10, 64)
	request := createComponentRequest{SchemeID: f.scheme, TypeID: typeID, Name: "Explicit override", ProjectPassportVersionID: &id, Params: map[string]string{"voltage_nom": "10500.0000"}}
	if err := json.Unmarshal([]byte(`{"formatVersion":1,"units":{"voltage_nom":"V"}}`), &request.UnitDeclaration); err != nil {
		t.Fatal(err)
	}
	created, err := f.store.CreateComponent(ctx, f.tokens[0].Token, f.project, request)
	if err != nil || created.DeclaredParameterUnits == nil || !reflect.DeepEqual(created.DeclaredParameterUnits.Units, map[string]string{"power_nom": "МВА", "voltage_nom": "V"}) || created.Params["voltage_nom"] != "10500.0000" {
		t.Fatal("explicit override/inherited unit merge differs", created, err)
	}
	var raw []byte
	if err := f.store.database.QueryRow(`SELECT document FROM project_passports WHERE id=$1`, id).Scan(&raw); err != nil {
		t.Fatal(err)
	}
	var frozen passportDocument
	if err := json.Unmarshal(raw, &frozen); err != nil || !reflect.DeepEqual(frozen, doc) {
		t.Fatal("instance override rewrote immutable passport", frozen, err)
	}
}
