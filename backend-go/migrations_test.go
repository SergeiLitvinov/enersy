package main

import (
	"database/sql"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"
)

func migrationTestDatabase(t *testing.T) *sql.DB {
	t.Helper()
	dsn := os.Getenv("TEST_DATABASE_URL")
	if dsn == "" {
		t.Skip("Set TEST_DATABASE_URL for PostgreSQL integration tests")
	}
	admin, err := sql.Open("postgres", dsn)
	if err != nil {
		t.Fatal(err)
	}
	schema := fmt.Sprintf("enersy_migration_test_%d", time.Now().UnixNano())
	if _, err := admin.Exec(`CREATE SCHEMA "` + schema + `"`); err != nil {
		admin.Close()
		t.Fatal(err)
	}
	database, err := sql.Open("postgres", dsn+" search_path="+schema)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		database.Close()
		if _, err := admin.Exec(`DROP SCHEMA "` + schema + `" CASCADE`); err != nil {
			t.Error(err)
		}
		admin.Close()
	})
	return database
}

func migrationSourceURL(t *testing.T) string {
	t.Helper()
	path, err := filepath.Abs(filepath.Join("..", "database", "migrations"))
	if err != nil {
		t.Fatal(err)
	}
	return "file://" + filepath.ToSlash(path)
}

func executeFixture(t *testing.T, database *sql.DB, path string) {
	t.Helper()
	body, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = database.Exec(string(body)); err != nil {
		t.Fatalf("%s: %v", path, err)
	}
}

func TestMigrationCompatibilityPostgres(t *testing.T) {
	url := migrationSourceURL(t)
	for _, tc := range []struct {
		name    string
		version int64
		dirty   bool
		want    string
	}{
		{"future", 20990101001, false, "newer than supported"},
		{"unknown historical", 20260701001, false, "absent from migration source"},
		{"dirty", 20260612001, true, "manual recovery required"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			database := migrationTestDatabase(t)
			if _, err := database.Exec("CREATE TABLE schema_migrations(version bigint NOT NULL PRIMARY KEY, dirty boolean NOT NULL)"); err != nil {
				t.Fatal(err)
			}
			if _, err := database.Exec("INSERT INTO schema_migrations VALUES($1,$2)", tc.version, tc.dirty); err != nil {
				t.Fatal(err)
			}
			if err := runMigrationsFromSource(database, url); err == nil || !strings.Contains(err.Error(), tc.want) {
				t.Fatalf("wanted %q, got %v", tc.want, err)
			}
			var version int64
			var dirty bool
			if err := database.QueryRow("SELECT version,dirty FROM schema_migrations").Scan(&version, &dirty); err != nil || version != tc.version || dirty != tc.dirty {
				t.Fatalf("rejected database was changed: %d/%t: %v", version, dirty, err)
			}
			if err := database.Ping(); err != nil {
				t.Fatalf("migration closed application pool: %v", err)
			}
		})
	}
	t.Run("broken SQL stays dirty", func(t *testing.T) {
		database := migrationTestDatabase(t)
		dir := t.TempDir()
		if err := os.WriteFile(filepath.Join(dir, "1_broken.up.sql"), []byte("THIS IS NOT SQL;"), 0600); err != nil {
			t.Fatal(err)
		}
		url := "file://" + filepath.ToSlash(dir)
		if err := runMigrationsFromSource(database, url); err == nil {
			t.Fatal("accepted broken SQL")
		}
		if err := runMigrationsFromSource(database, url); err == nil || !strings.Contains(err.Error(), "manual recovery required") {
			t.Fatalf("dirty retry: %v", err)
		}
	})
	t.Run("empty source rejected", func(t *testing.T) {
		database := migrationTestDatabase(t)
		if err := runMigrationsFromSource(database, "file://"+filepath.ToSlash(t.TempDir())); err == nil || !strings.Contains(err.Error(), "empty or unreadable") {
			t.Fatalf("empty source: %v", err)
		}
	})
}

func TestMigrationDeploymentPostgres(t *testing.T) {
	url := migrationSourceURL(t)
	fresh := migrationTestDatabase(t)
	if err := runMigrationsFromSource(fresh, url); err != nil {
		t.Fatal(err)
	}
	before := migrationSnapshot(t, fresh)
	if err := runMigrationsFromSource(fresh, url); err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(before, migrationSnapshot(t, fresh)) {
		t.Fatal("second migration changed schema or catalog")
	}
	for _, fixture := range []string{"init.sql", "ees_schema.sql", "migrations/20260612001_init.up.sql"} {
		t.Run(fixture, func(t *testing.T) {
			database := migrationTestDatabase(t)
			executeFixture(t, database, filepath.Join("..", "database", fixture))
			if strings.HasPrefix(fixture, "migrations/") {
				if _, err := database.Exec(`CREATE TABLE schema_migrations(version bigint NOT NULL PRIMARY KEY, dirty boolean NOT NULL); INSERT INTO schema_migrations VALUES(20260612001,false);`); err != nil {
					t.Fatal(err)
				}
			}
			// Preserve a saved object, coordinates and explicit parameter overrides.
			if _, err := database.Exec(`INSERT INTO circuit_schemes(id,name) VALUES(90001,'Migration fixture');
INSERT INTO scheme_components(id,scheme_id,component_type_id,custom_name,pos_x,pos_y,rotation)
SELECT 90001,90001,id,'Saved generator',12.5,-7.25,90 FROM component_types WHERE code='generator';
INSERT INTO scheme_component_params(scheme_component_id,param_key,param_value) VALUES(90001,'p','12.345');`); err != nil {
				t.Fatal(err)
			}
			if err := runMigrationsFromSource(database, url); err != nil {
				t.Fatal(err)
			}
			if got := migrationSnapshot(t, database); !reflect.DeepEqual(before, got) {
				for key, want := range before {
					if got[key] != want {
						var expectedRows, actualRows []json.RawMessage
						if err := json.Unmarshal([]byte(want), &expectedRows); err != nil {
							t.Fatal(err)
						}
						if err := json.Unmarshal([]byte(got[key]), &actualRows); err != nil {
							t.Fatal(err)
						}
						t.Errorf("%s differs (rows %d/%d)", key, len(expectedRows), len(actualRows))
						for i := 0; i < len(expectedRows) && i < len(actualRows); i++ {
							if string(expectedRows[i]) != string(actualRows[i]) {
								t.Logf("first difference at %d: want %s; got %s", i, expectedRows[i], actualRows[i])
								break
							}
						}
					}
				}
			}
			var value string
			if err := database.QueryRow(`SELECT param_value FROM scheme_component_params p JOIN scheme_components c ON c.id=p.scheme_component_id WHERE c.id=90001 AND c.pos_x=12.5 AND c.pos_y=-7.25 AND c.rotation=90 AND p.param_key='p'`).Scan(&value); err != nil || value != "12.345" {
				t.Fatalf("saved object changed: %s: %v", value, err)
			}
		})
	}
}

// Natural keys exclude sequence IDs, which legitimately differ in legacy DBs.
// Compare catalog values and column types/nullability/defaults after migration.
func migrationSnapshot(t *testing.T, database *sql.DB) map[string]string {
	t.Helper()
	queries := map[string]string{
		"constraints":  `SELECT c.relname,k.conname,pg_get_constraintdef(k.oid) AS definition,k.convalidated FROM pg_constraint k JOIN pg_class c ON c.oid=k.conrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=current_schema() AND c.relname<>'schema_migrations' ORDER BY c.relname,k.conname`,
		"indexes":      `SELECT tablename,indexname,indexdef FROM pg_indexes WHERE schemaname=current_schema() AND tablename<>'schema_migrations' ORDER BY tablename,indexname`,
		"triggers":     `SELECT c.relname,t.tgname,pg_get_triggerdef(t.oid) AS definition FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=current_schema() AND NOT t.tgisinternal ORDER BY c.relname,t.tgname`,
		"views":        `SELECT viewname,definition FROM pg_views WHERE schemaname=current_schema() ORDER BY viewname`,
		"functions":    `SELECT p.proname,pg_get_functiondef(p.oid) AS definition FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname=current_schema() ORDER BY p.proname`,
		"columns":      `SELECT table_name,column_name,data_type,is_nullable,regexp_replace(coalesce(column_default,''),current_schema()||'\.','','g') AS default_value FROM information_schema.columns WHERE table_schema=current_schema() AND table_name<>'schema_migrations' ORDER BY table_name,ordinal_position`,
		"types":        `SELECT code,name,category,description FROM component_types ORDER BY code`,
		"templates":    `SELECT t.code,p.param_key,p.param_name,p.param_type,p.default_value,p.unit FROM component_params_template p JOIN component_types t ON t.id=p.component_type_id ORDER BY t.code,p.param_key`,
		"models":       `SELECT t.code,m.model_name,m.manufacturer,m.description FROM equipment_models m JOIN component_types t ON t.id=m.component_type_id ORDER BY t.code,m.model_name`,
		"model params": `SELECT t.code,m.model_name,p.param_key,p.param_value FROM equipment_model_params p JOIN equipment_models m ON m.id=p.equipment_model_id JOIN component_types t ON t.id=m.component_type_id ORDER BY t.code,m.model_name,p.param_key`,
		"ports":        `SELECT t.code,p.port_name,p.domain FROM component_type_ports p JOIN component_types t ON t.id=p.component_type_id ORDER BY t.code,p.port_name`,
	}
	out := map[string]string{}
	for key, query := range queries {
		var value string
		if err := database.QueryRow("SELECT replace(coalesce(json_agg(r)::text,'[]'),current_schema()||'.','') FROM (" + query + ") r").Scan(&value); err != nil {
			t.Fatal(err)
		}
		out[key] = value
	}
	return out
}
