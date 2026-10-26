package main

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"testing"
)

func TestCatalogMapCLIPostgres(t *testing.T) {
	binary := os.Getenv("TEST_OPERATOR_BINARY")
	if binary == "" {
		t.Skip("Set TEST_OPERATOR_BINARY and DB_* / POSTGRES_* for the isolated CLI check")
	}
	database, url, path, plan := catalogMapFixture(t)
	body, err := json.Marshal(plan)
	if err != nil {
		t.Fatal(err)
	}
	baseline, err := filepath.Abs(path)
	if err != nil {
		t.Fatal(err)
	}
	run := func(success bool, args ...string) []byte {
		t.Helper()
		cmd := exec.Command(binary, args...)
		cmd.Env = append(os.Environ(), "PGOPTIONS=-c search_path="+plan.Schema, "MIGRATIONS_SOURCE="+url, "CATALOG_BASELINE_SOURCE="+baseline)
		cmd.Stdin = bytes.NewReader(body)
		var output, diagnostic bytes.Buffer
		cmd.Stdout, cmd.Stderr = &output, &diagnostic
		err := cmd.Run()
		if (err == nil) != success {
			t.Fatalf("CLI result mismatch: %v, %s", err, diagnostic.String())
		}
		if !success && output.Len() != 0 {
			t.Fatal("failed CLI emitted a success report")
		}
		return output.Bytes()
	}
	var checked, applied catalogMapResult
	if err := json.Unmarshal(run(true, "-check-catalog-map"), &checked); err != nil || checked.Status != "checked_not_applied" {
		t.Fatal(checked, err)
	}
	run(false, "-check-catalog-map", "-apply-catalog-map")
	if err := json.Unmarshal(run(true, "-apply-catalog-map"), &applied); err != nil || applied.Status != "applied" || applied.MapSHA256 != checked.MapSHA256 {
		t.Fatal(applied, err)
	}
	run(false, "-apply-catalog-map")
	var target, value string
	if err := database.QueryRow(`SELECT c.equipment_model_id::text,p.param_value FROM scheme_components c JOIN scheme_component_params p ON p.scheme_component_id=c.id WHERE c.id=90001 AND p.param_key='p'`).Scan(&target, &value); err != nil || target != plan.Changes[0].ToModelID || value != "10.500" {
		t.Fatal("CLI did not preserve reviewed binding and value", err)
	}
}

func TestCatalogMapInput(t *testing.T) {
	plan := catalogMap{1, "legacy-model-reference-map", "database", "public", strings.Repeat("a", 64), strings.Repeat("b", 64), strings.Repeat("c", 64), []catalogMapChange{{"9007199254740993", "1", "2", "3", "4", "Explicit source review"}}}
	body, err := json.Marshal(plan)
	if err != nil {
		t.Fatal(err)
	}
	decoded, err := readCatalogMap(strings.NewReader(string(body)))
	if err != nil || decoded.Changes[0].ComponentID != "9007199254740993" {
		t.Fatal(decoded, err)
	}
	for name, invalid := range map[string]string{
		"duplicate":     strings.Replace(string(body), `"formatVersion":1`, `"formatVersion":1,"formatVersion":1`, 1),
		"case alias":    strings.Replace(string(body), `"formatVersion":1`, `"formatVersion":1,"FormatVersion":1`, 1),
		"nested alias":  strings.Replace(string(body), `"componentId":`, `"ComponentId":"1","componentId":`, 1),
		"unicode alias": strings.Replace(string(body), `"schemeId":`, `"ſchemeId":"2","schemeId":`, 1),
		"unknown":       strings.Replace(string(body), `"formatVersion":1`, `"unexpected":1,"formatVersion":1`, 1),
		"trailing":      string(body) + `{}`,
		"numeric id":    strings.Replace(string(body), `"9007199254740993"`, `9007199254740993`, 1),
		"invalid utf8":  string(body) + string([]byte{0xff}),
		"oversize":      strings.Repeat(" ", (1<<20)+1),
		"deep":          strings.Repeat("[", 18) + "1" + strings.Repeat("]", 18),
	} {
		t.Run(name, func(t *testing.T) {
			if _, err := readCatalogMap(strings.NewReader(invalid)); err == nil {
				t.Fatal("invalid map accepted")
			}
		})
	}
	for _, id := range []string{"0", "-1", "+1", "01", "1.0", "9223372036854775808", " 1"} {
		if canonicalCatalogID(id) {
			t.Fatalf("noncanonical ID accepted: %q", id)
		}
	}
	plan.Changes = append(plan.Changes, plan.Changes[0])
	if err := validateCatalogMap(plan); err == nil {
		t.Fatal("duplicate component accepted")
	}
}

func catalogMapFixture(t *testing.T) (*sql.DB, string, string, catalogMap) {
	t.Helper()
	database := migrationTestDatabase(t)
	url := migrationSourceURL(t)
	if err := runMigrationsFromSource(database, url); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join("..", "database", "catalog-baseline.v1.json")
	report, err := auditCatalog(context.Background(), database, url, path)
	if err != nil {
		t.Fatal(err)
	}
	var first, second string
	if err := database.QueryRow(`SELECT min(id)::text,max(id)::text FROM equipment_models WHERE component_type_id=(SELECT id FROM component_types WHERE code='generator')`).Scan(&first, &second); err != nil || first == second {
		t.Fatal(first, second, err)
	}
	if _, err := database.Exec(`INSERT INTO circuit_schemes(id,name) VALUES(90001,'Map fixture')`); err != nil {
		t.Fatal(err)
	}
	if _, err := database.Exec(`INSERT INTO scheme_components(id,scheme_id,component_type_id,equipment_model_id,custom_name,pos_x,pos_y,rotation)
SELECT 90001,90001,component_type_id,id,'User component',-3.25,9.5,180 FROM equipment_models WHERE id=$1`, first); err != nil {
		t.Fatal(err)
	}
	if _, err := database.Exec(`INSERT INTO scheme_component_params(scheme_component_id,param_key,param_value) VALUES(90001,'p','10.500')`); err != nil {
		t.Fatal(err)
	}
	var revision string
	if err := database.QueryRow(`SELECT revision::text FROM scheme_components WHERE id=90001`).Scan(&revision); err != nil {
		t.Fatal(err)
	}
	plan := catalogMap{1, "legacy-model-reference-map", report.Database, report.Schema, report.SnapshotSHA256, report.BaselineSHA256, report.MigrationSHA256,
		[]catalogMapChange{{"90001", "90001", revision, first, second, "Operator chose another legacy model after reviewing source"}}}
	return database, url, path, plan
}

func TestCatalogMapApplyPostgres(t *testing.T) {
	database, url, path, plan := catalogMapFixture(t)
	ctx := context.Background()
	readState := func() (string, string, string) {
		t.Helper()
		var component, params, model string
		if err := database.QueryRow(`SELECT (to_jsonb(c)-'revision'-'equipment_model_id')::text,equipment_model_id::text FROM scheme_components c WHERE id=90001`).Scan(&component, &model); err != nil {
			t.Fatal(err)
		}
		if err := database.QueryRow(`SELECT jsonb_agg(to_jsonb(p) ORDER BY id)::text FROM scheme_component_params p WHERE scheme_component_id=90001`).Scan(&params); err != nil {
			t.Fatal(err)
		}
		return component, params, model
	}
	before, params, model := readState()
	checked, err := executeCatalogMap(ctx, database, url, path, plan, false)
	if err != nil || checked.Status != "checked_not_applied" || !checked.ReadOnly {
		t.Fatal(checked, err)
	}
	_, _, unchangedModel := readState()
	if unchangedModel != model {
		t.Fatal("check changed binding")
	}
	applied, err := executeCatalogMap(ctx, database, url, path, plan, true)
	if err != nil || applied.Status != "applied" || applied.ReadOnly || applied.MapSHA256 != checked.MapSHA256 {
		t.Fatal(applied, err)
	}
	after, preservedParams, target := readState()
	if before != after || params != preservedParams || target != plan.Changes[0].ToModelID {
		t.Fatal("map changed user fields/parameters or missed binding")
	}
	var revision string
	if err := database.QueryRow(`SELECT revision::text FROM scheme_components WHERE id=90001`).Scan(&revision); err != nil || revision == plan.Changes[0].ExpectedRevision {
		t.Fatal("revision did not invalidate stale editors", err)
	}
	if _, err := executeCatalogMap(ctx, database, url, path, plan, true); err == nil {
		t.Fatal("stale map replay accepted")
	}
	report, err := auditCatalog(ctx, database, url, path)
	if err != nil || report.SnapshotSHA256 != plan.SnapshotSHA256 {
		t.Fatal("map changed source catalog", err)
	}
}

func TestCatalogMapPreconditionsPostgres(t *testing.T) {
	for _, mutation := range []string{"database", "schema", "baseline", "snapshot", "migration", "revision", "source", "scheme", "type", "missing target", "dirty", "pending migration", "integrity", "missing history", "parameter edit", "catalog edit"} {
		t.Run(mutation, func(t *testing.T) {
			database, url, path, original := catalogMapFixture(t)
			plan := original
			plan.Changes = append([]catalogMapChange(nil), original.Changes...)
			exec := func(query string) {
				t.Helper()
				if _, err := database.Exec(query); err != nil {
					t.Fatal(err)
				}
			}
			switch mutation {
			case "database":
				plan.Database += "_other"
			case "schema":
				plan.Schema += "_other"
			case "baseline":
				plan.BaselineSHA256 = strings.Repeat("0", 64)
			case "snapshot":
				plan.SnapshotSHA256 = strings.Repeat("0", 64)
			case "migration":
				plan.MigrationSHA256 = strings.Repeat("0", 64)
			case "revision":
				plan.Changes[0].ExpectedRevision = "999"
			case "source":
				plan.Changes[0].FromModelID, plan.Changes[0].ToModelID = plan.Changes[0].ToModelID, plan.Changes[0].FromModelID
			case "scheme":
				plan.Changes[0].SchemeID = "999"
			case "type":
				if err := database.QueryRow(`SELECT min(id)::text FROM equipment_models WHERE component_type_id=(SELECT id FROM component_types WHERE code='load')`).Scan(&plan.Changes[0].ToModelID); err != nil {
					t.Fatal(err)
				}
			case "dirty":
				exec(`UPDATE schema_migrations SET dirty=true`)
			case "pending migration":
				exec(`UPDATE schema_migrations SET version=20261021002`)
			case "missing target":
				plan.Changes[0].ToModelID = "2147483647"
			case "integrity":
				exec(`UPDATE schema_migration_integrity SET sha256=repeat('0',64)`)
			case "missing history":
				exec(`DELETE FROM schema_migration_integrity WHERE version=(SELECT min(version) FROM schema_migration_integrity)`)
			case "parameter edit":
				exec(`UPDATE scheme_component_params SET param_value='10.501' WHERE scheme_component_id=90001`)
			case "catalog edit":
				exec(`UPDATE equipment_models SET description='Changed after review' WHERE id=(SELECT min(id) FROM equipment_models)`)
			}
			for _, apply := range []bool{false, true} {
				if _, err := executeCatalogMap(context.Background(), database, url, path, plan, apply); err == nil {
					t.Fatal("invalid map accepted", apply)
				}
			}
			var actual string
			if err := database.QueryRow(`SELECT equipment_model_id::text FROM scheme_components WHERE id=90001`).Scan(&actual); err != nil || actual != original.Changes[0].FromModelID {
				t.Fatal("rejected map changed binding", err)
			}
		})
	}
}

func TestCatalogMapLockTimeoutPostgres(t *testing.T) {
	database, url, path, plan := catalogMapFixture(t)
	lock, err := database.Begin()
	if err != nil {
		t.Fatal(err)
	}
	defer rollbackTx(lock)
	if _, err := lock.Exec(`LOCK TABLE equipment_models IN SHARE ROW EXCLUSIVE MODE`); err != nil {
		t.Fatal(err)
	}
	if _, err := executeCatalogMap(context.Background(), database, url, path, plan, true); err == nil || !strings.Contains(err.Error(), "lock timeout") {
		t.Fatal("maintenance lock conflict must time out without applying", err)
	}
	var current string
	if err := database.QueryRow(`SELECT equipment_model_id::text FROM scheme_components WHERE id=90001`).Scan(&current); err != nil || current != plan.Changes[0].FromModelID {
		t.Fatal("lock timeout changed data", err)
	}
}

func TestCatalogMapAtomicAndConcurrentPostgres(t *testing.T) {
	database, url, path, plan := catalogMapFixture(t)
	if _, err := database.Exec(`INSERT INTO scheme_components(id,scheme_id,component_type_id,equipment_model_id) SELECT 90002,scheme_id,component_type_id,equipment_model_id FROM scheme_components WHERE id=90001;
CREATE FUNCTION reject_map_fixture() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.id=90002 THEN RAISE EXCEPTION 'fixture rejection'; END IF; RETURN NEW; END; $$;
CREATE TRIGGER reject_map_fixture BEFORE UPDATE ON scheme_components FOR EACH ROW EXECUTE FUNCTION reject_map_fixture()`); err != nil {
		t.Fatal(err)
	}
	second := plan.Changes[0]
	second.ComponentID, second.ExpectedRevision = "90002", "1"
	plan.Changes = append(plan.Changes, second)
	if _, err := executeCatalogMap(context.Background(), database, url, path, plan, true); err == nil {
		t.Fatal("trigger failure accepted")
	}
	var model, revision string
	if err := database.QueryRow(`SELECT equipment_model_id::text,revision::text FROM scheme_components WHERE id=90001`).Scan(&model, &revision); err != nil || model != plan.Changes[0].FromModelID || revision != plan.Changes[0].ExpectedRevision {
		t.Fatal("failed second update did not roll back first", err)
	}
	plan.Changes = plan.Changes[:1]
	var wg sync.WaitGroup
	errors := make(chan error, 2)
	for range 2 {
		wg.Go(func() {
			_, err := executeCatalogMap(context.Background(), database, url, path, plan, true)
			errors <- err
		})
	}
	wg.Wait()
	close(errors)
	succeeded := 0
	for err := range errors {
		if err == nil {
			succeeded++
		}
	}
	if succeeded != 1 {
		t.Fatalf("concurrent map must apply exactly once, got %d", succeeded)
	}
}
