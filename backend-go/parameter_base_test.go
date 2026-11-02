package main

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"math"
	"os"
	"path/filepath"
	"reflect"
	"strconv"
	"strings"
	"testing"
)

func TestParameterBaseDeclaration(t *testing.T) {
	good := `{"formatVersion":2,"units":{"p":"p.u."},"bases":{"p":{"profile":"ac-three-phase-rms-v1","s_base_mva":10,"v_base_kv":35}}}`
	d, err := parseParameterUnitDeclaration([]byte(good), map[string]string{"p": "0.2000"})
	if err != nil || d.Bases["p"].SBaseMVA != 10 {
		t.Fatal(d, err)
	}
	for _, raw := range []string{
		`{"formatVersion":1,"units":{"p":"p.u."},"bases":{"p":null}}`,
		`{"formatVersion":2,"units":{"p":"MW"},"bases":{"p":null}}`,
		`{"formatVersion":2,"units":{"p":"p.u."},"bases":{}}`,
		`{"formatVersion":2,"units":{"p":"p.u."},"bases":{"q":null}}`,
		`{"formatVersion":2,"units":{"p":"p.u."},"bases":{"p":null,"p":null}}`,
		`{"formatVersion":2,"units":{"p":"p.u."},"bases":{"p":{"profile":"ac-three-phase-rms-v1","s_base_mva":10,"v_base_kv":0}}}`,
		`{"formatVersion":2,"units":{"p":"p.u."},"bases":{"p":{"profile":"ac-three-phase-rms-v1","s_base_mva":10,"s_base_mva":20,"v_base_kv":35}}}`,
		`{"formatVersion":2,"units":{"p":"p.u."},"bases":{"p":{"profile":"ac-three-phase-rms-v1","s_base_mva":true,"v_base_kv":35}}}`,
		`{"formatVersion":2,"units":{"p":"p.u."},"bases":{"p":{"profile":"other","s_base_mva":10,"v_base_kv":35}}}`,
	} {
		if _, err := parseParameterUnitDeclaration([]byte(raw), map[string]string{"p": "1"}); err == nil {
			t.Fatal("accepted invalid base", raw)
		}
	}
	for _, number := range []float64{0, -1, math.Inf(1), math.NaN()} {
		if (parameterBase{parameterBaseProfile, number, 35}).valid() || (parameterBase{parameterBaseProfile, 10, number}).valid() {
			t.Fatal(number)
		}
	}
	cloned := mergeParameterUnits(d, &parameterUnitDeclaration{FormatVersion: 1, Units: map[string]string{"p": "p.u."}})
	cloned.Bases["p"].SBaseMVA = 100
	if d.Bases["p"].SBaseMVA != 10 {
		t.Fatal("merge aliases immutable source")
	}
	for _, override := range []*parameterUnitDeclaration{
		{FormatVersion: 1, Units: map[string]string{"p": "MW"}},
		{FormatVersion: 2, Units: map[string]string{"p": "p.u."}, Bases: map[string]*parameterBase{"p": nil}},
	} {
		if merged := mergeParameterUnits(d, override); merged.FormatVersion != 1 || len(merged.Bases) != 0 {
			t.Fatal(merged)
		}
	}
}

func TestPassportBaseCopyPostgres(t *testing.T) {
	f := newStudyFixture(t)
	ctx := context.Background()
	var typeID int
	if err := f.store.database.QueryRow(`SELECT id FROM component_types WHERE code='generator'`).Scan(&typeID); err != nil {
		t.Fatal(err)
	}
	doc := passportFixture()
	doc.FormatVersion = 2
	doc.Parameters = map[string]passportParameter{"e": {Value: "1.0000", Unit: "p.u.", Base: &parameterBase{parameterBaseProfile, 10, 35}}}
	source, err := f.store.SavePassport(ctx, f.tokens[0].Token, f.project, studyCommand(892), nil, doc)
	if err != nil {
		t.Fatal(err)
	}
	version, _ := strconv.ParseInt(source.ID, 10, 64)
	request := createComponentRequest{SchemeID: f.scheme, TypeID: typeID, Name: "Based source", ProjectPassportVersionID: &version, Params: map[string]string{"e": "1.1000"}}
	created, err := f.store.CreateComponent(ctx, f.tokens[0].Token, f.project, request)
	if err != nil || created.DeclaredParameterUnits == nil || created.DeclaredParameterUnits.FormatVersion != 2 || created.DeclaredParameterUnits.Bases["e"].VBaseKV != 35 || created.Params["e"] != "1.1000" {
		t.Fatal(created, err)
	}
	var voltage float64
	if err := f.store.database.QueryRow(`SELECT per_unit_v_base_kv FROM scheme_component_params WHERE scheme_component_id=$1 AND param_key='e'`, created.ID).Scan(&voltage); err != nil || voltage != 35 {
		t.Fatal(voltage, err)
	}
	if err := json.Unmarshal([]byte(`{"formatVersion":1,"units":{"e":"kV"}}`), &request.UnitDeclaration); err != nil {
		t.Fatal(err)
	}
	request.Params["e"] = "38.5000"
	cleared, err := f.store.CreateComponent(ctx, f.tokens[0].Token, f.project, request)
	if err != nil || cleared.DeclaredParameterUnits == nil || cleared.DeclaredParameterUnits.FormatVersion != 1 || len(cleared.DeclaredParameterUnits.Bases) != 0 {
		t.Fatal(cleared, err)
	}
	var raw []byte
	if err := f.store.database.QueryRow(`SELECT document FROM project_passports WHERE id=$1`, version).Scan(&raw); err != nil {
		t.Fatal(err)
	}
	var frozen passportDocument
	if err := json.Unmarshal(raw, &frozen); err != nil || !reflect.DeepEqual(frozen, doc) {
		t.Fatal("source basis changed", err)
	}
}

func TestPassportParameterBaseVersion(t *testing.T) {
	doc := passportFixture()
	doc.Parameters["p"] = passportParameter{Value: "0.2000", Unit: "p.u.", Base: &parameterBase{parameterBaseProfile, 10, 35}}
	if validatePassportDocument(doc) == nil {
		t.Fatal("v1 silently accepted v2 representation")
	}
	doc.FormatVersion = 2
	if err := validatePassportDocument(doc); err != nil {
		t.Fatal(err)
	}
	raw, err := json.Marshal(doc)
	if err != nil {
		t.Fatal(err)
	}
	var cloned passportDocument
	if err = json.Unmarshal(raw, &cloned); err != nil || !reflect.DeepEqual(cloned, doc) {
		t.Fatal("lost passport base", err, string(raw))
	}
}

func TestParameterBaseLifecyclePostgres(t *testing.T) {
	f := newStudyFixture(t)
	ctx := context.Background()
	read := func() (int64, string, sql.NullFloat64) {
		t.Helper()
		var revision int64
		var value string
		var base sql.NullFloat64
		if err := f.store.database.QueryRow(`SELECT c.revision,p.param_value,p.per_unit_s_base_mva FROM scheme_components c JOIN scheme_component_params p ON p.scheme_component_id=c.id WHERE c.id=$1 AND p.param_key='p'`, f.load).Scan(&revision, &value, &base); err != nil {
			t.Fatal(err)
		}
		return revision, value, base
	}
	write := func(expected int64, body string) (int64, error) {
		t.Helper()
		var request componentPatchRequest
		if err := json.Unmarshal([]byte(body), &request); err != nil {
			t.Fatal(err)
		}
		patch, err := parseComponentPatch(request)
		if err != nil {
			t.Fatal(err)
		}
		return f.store.MutateComponent(ctx, f.tokens[0].Token, f.project, f.scheme, f.load, expected, func(tx *sql.Tx) error { return applyComponentPatch(ctx, tx, f.load, patch) }, false)
	}
	revision, _, base := read()
	if base.Valid {
		t.Fatal("migration inferred source basis")
	}
	body := `{"params":{"p":"0.2000"},"parameterUnitDeclaration":{"formatVersion":2,"units":{"p":"p.u."},"bases":{"p":{"profile":"ac-three-phase-rms-v1","s_base_mva":10,"v_base_kv":35}}}}`
	if _, err := write(revision, body); err != nil {
		t.Fatal(err)
	}
	if _, err := write(revision, body); !errors.Is(err, errComponentConflict) {
		t.Fatal("stale base accepted", err)
	}
	revision, value, base := read()
	if value != "0.2000" || !base.Valid || base.Float64 != 10 {
		t.Fatal(value, base)
	}
	for _, assignment := range []string{
		`per_unit_s_base_mva=0`, `per_unit_v_base_kv=-1`, `per_unit_s_base_mva='NaN'::float8`,
		`per_unit_v_base_kv='Infinity'::float8`, `per_unit_base_profile=NULL`, `declared_unit='MW'`,
		`per_unit_s_base_mva=NULL`, `per_unit_base_profile='unsupported'`,
	} {
		// Constant assignments in a disposable fixture; never user-supplied SQL.
		if _, err := f.store.database.Exec(`UPDATE scheme_component_params SET `+assignment+` WHERE scheme_component_id=$1 AND param_key='p'`, f.load); err == nil {
			t.Fatal("database admitted invalid source base", assignment)
		}
		if after, _, _ := read(); after != revision {
			t.Fatal("rejected metadata update advanced revision")
		}
	}
	input, err := readCalculationInputScope(ctx, f.store.database, f.scheme, f.project, f.tokens[0].Token, false)
	if err != nil {
		t.Fatal(err)
	}
	found := false
	for _, c := range input.Components {
		if c.ID == f.load {
			found = c.DeclaredParameterUnits != nil && c.DeclaredParameterUnits.FormatVersion == 2 && c.DeclaredParameterUnits.Bases["p"].VBaseKV == 35
		}
	}
	if !found {
		t.Fatal("capture lost original base")
	}
	if _, err := write(revision, strings.Replace(body, `"s_base_mva":10`, `"s_base_mva":20`, 1)); err != nil {
		t.Fatal(err)
	}
	changed, value, base := read()
	if changed <= revision || value != "0.2000" || !base.Valid || base.Float64 != 20 {
		t.Fatal("basis-only edit did not advance revision", changed, value, base)
	}
	if _, err := write(changed, body); err != nil {
		t.Fatal(err)
	}
	revision, _, _ = read()
	for _, body := range []string{
		`{"params":{"p":"0.3000"}}`,
		`{"params":{"p":"0.3000"},"parameterUnitDeclaration":{"formatVersion":1,"units":{"p":"p.u."}}}`,
	} {
		if _, err := write(revision, body); err != nil {
			t.Fatal(err)
		}
		revision, _, base = read()
		if !base.Valid || base.Float64 != 10 {
			t.Fatal("same-unit edit lost base")
		}
	}
	for _, unit := range []string{"p.u.", "MW"} {
		if _, err := write(revision, body); err != nil {
			t.Fatal(err)
		}
		revision, _, _ = read()
		clearing := `{"params":{"p":"2"},"parameterUnitDeclaration":{"formatVersion":2,"units":{"p":"p.u."},"bases":{"p":null}}}`
		if unit == "MW" {
			clearing = `{"params":{"p":"2"},"parameterUnitDeclaration":{"formatVersion":1,"units":{"p":"MW"}}}`
		}
		if _, err := write(revision, clearing); err != nil {
			t.Fatal(err)
		}
		revision, _, base = read()
		if base.Valid {
			t.Fatal("clearing retained source base", unit)
		}
	}
}

func TestParameterBaseUpgradeFromV2Postgres(t *testing.T) {
	database := migrationTestDatabase(t)
	dir := t.TempDir()
	for _, name := range []string{"000001_v1.up.sql", "000002_application_commands.up.sql"} {
		body, err := os.ReadFile(filepath.Join("..", "database", "migrations", name))
		if err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(dir, name), body, 0600); err != nil {
			t.Fatal(err)
		}
	}
	if err := runMigrationsFromSource(database, "file://"+filepath.ToSlash(dir)); err != nil {
		t.Fatal(err)
	}
	var scheme, id int
	if err := database.QueryRow(`INSERT INTO circuit_schemes(name) VALUES('Before source bases') RETURNING id`).Scan(&scheme); err != nil {
		t.Fatal(err)
	}
	if err := database.QueryRow(`INSERT INTO scheme_components(scheme_id,component_type_id,pos_x,pos_y) SELECT $1,id,0,0 FROM component_types WHERE code='generator' RETURNING id`, scheme).Scan(&id); err != nil {
		t.Fatal(err)
	}
	if _, err := database.Exec(`INSERT INTO scheme_component_params(scheme_component_id,param_key,param_value,unit_format_version,declared_unit) VALUES($1,'e','1.0000',1,'p.u.'),($1,'x','0.1000',NULL,NULL)`, id); err != nil {
		t.Fatal(err)
	}
	var beforeRevision int64
	if err := database.QueryRow(`SELECT revision FROM scheme_components WHERE id=$1`, id).Scan(&beforeRevision); err != nil {
		t.Fatal(err)
	}
	if err := runMigrationsFromSource(database, migrationSourceURL(t)); err != nil {
		t.Fatal(err)
	}
	var unchanged bool
	if err := database.QueryRow(`SELECT
 (SELECT revision FROM scheme_components WHERE id=$1)=$2
 AND (SELECT count(*) FROM scheme_component_params WHERE scheme_component_id=$1)=2
 AND EXISTS(SELECT 1 FROM scheme_component_params WHERE scheme_component_id=$1 AND param_key='e' AND param_value='1.0000' AND declared_unit='p.u.' AND unit_format_version=1)
 AND EXISTS(SELECT 1 FROM scheme_component_params WHERE scheme_component_id=$1 AND param_key='x' AND param_value='0.1000' AND declared_unit IS NULL AND unit_format_version IS NULL)
 AND NOT EXISTS(SELECT 1 FROM scheme_component_params WHERE per_unit_base_profile IS NOT NULL OR per_unit_s_base_mva IS NOT NULL OR per_unit_v_base_kv IS NOT NULL)`, id, beforeRevision).Scan(&unchanged); err != nil || !unchanged {
		t.Fatal("migration changed old source representations", unchanged, err)
	}
}
