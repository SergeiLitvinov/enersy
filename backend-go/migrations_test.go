package main

import (
	"database/sql"
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

func TestApplicationCommandsUpgradeFromV1Postgres(t *testing.T) {
	database := migrationTestDatabase(t)
	dir := t.TempDir()
	body, err := os.ReadFile(filepath.Join("..", "database", "migrations", "000001_v1.up.sql"))
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "000001_v1.up.sql"), body, 0600); err != nil {
		t.Fatal(err)
	}
	if err := runMigrationsFromSource(database, "file://"+filepath.ToSlash(dir)); err != nil {
		t.Fatal(err)
	}
	if _, err := database.Exec(`INSERT INTO circuit_schemes(name,description) VALUES('Saved before v2','Сохранённая схема')`); err != nil {
		t.Fatal(err)
	}
	var originalSeal string
	if err := database.QueryRow(`SELECT sha256 FROM schema_migration_integrity WHERE version=1`).Scan(&originalSeal); err != nil {
		t.Fatal(err)
	}
	url := migrationSourceURL(t)
	if err := runMigrationsFromSource(database, url); err != nil {
		t.Fatal(err)
	}
	if err := runMigrationsFromSource(database, url); err != nil {
		t.Fatal(err)
	}
	var seal, description string
	var version, models, receipts int
	if err := database.QueryRow(`SELECT
 (SELECT sha256 FROM schema_migration_integrity WHERE version=1),
 (SELECT version FROM schema_migrations),
 (SELECT description FROM circuit_schemes WHERE name='Saved before v2'),
 (SELECT count(*) FROM equipment_models),
 (SELECT count(*) FROM project_application_commands)`).Scan(&seal, &version, &description, &models, &receipts); err != nil || seal != originalSeal || version != 2 || description != "Сохранённая схема" || models != 90 || receipts != 0 {
		t.Fatal("v2 upgrade changed v1 data or seal", seal, version, description, models, receipts, err)
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
		{"future", 3, false, "newer than supported"},
		{"unpublished version", 0, false, "absent from migration source"},
		{"retired pre-v1", 20261030001, false, "newer than supported"},
		{"dirty", 1, true, "manual recovery required"},
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
	var version int
	if err := fresh.QueryRow("SELECT version FROM schema_migrations").Scan(&version); err != nil || version != 2 {
		t.Fatal(version, err)
	}
	for _, table := range []string{"users", "circuit_nodes", "calculation_results", "calculation_node_results", "calculation_branch_results"} {
		var found bool
		if err := fresh.QueryRow(`SELECT EXISTS(SELECT 1 FROM information_schema.tables WHERE table_schema=current_schema() AND table_name=$1)`, table).Scan(&found); err != nil || found {
			t.Fatal("retired table present", table, err)
		}
	}
	if _, err := fresh.Exec(`INSERT INTO circuit_schemes(id,name) VALUES(90001,'Saved v1 fixture');
INSERT INTO scheme_components(id,scheme_id,component_type_id,custom_name,pos_x,pos_y,rotation) SELECT 90001,90001,id,'Saved generator',12.5,-7.25,90 FROM component_types WHERE code='generator';
INSERT INTO scheme_component_params(scheme_component_id,param_key,param_value) VALUES(90001,'p','12.345')`); err != nil {
		t.Fatal(err)
	}
	if err := runMigrationsFromSource(fresh, url); err != nil {
		t.Fatal(err)
	}
	var value string
	if err := fresh.QueryRow(`SELECT param_value FROM scheme_component_params WHERE scheme_component_id=90001 AND param_key='p'`).Scan(&value); err != nil || value != "12.345" {
		t.Fatal("restart changed saved v1 data", value, err)
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
