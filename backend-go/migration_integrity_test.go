package main

import (
	"io"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"

	"github.com/golang-migrate/migrate/v4/source"
)

func integrityFixture(t *testing.T) (string, string) {
	t.Helper()
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "1_first.up.sql"), []byte("CREATE TABLE saved_values(value TEXT);\nINSERT INTO saved_values VALUES('kept');\n"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "2_second.up.sql"), []byte("ALTER TABLE saved_values ADD COLUMN extra TEXT;\n"), 0600); err != nil {
		t.Fatal(err)
	}
	return dir, "file://" + filepath.ToSlash(dir)
}

func TestMigrationIntegrityPostgres(t *testing.T) {
	for _, change := range []string{"changed SQL", "deleted SQL", "deleted history", "newline only"} {
		t.Run(change, func(t *testing.T) {
			dir, url := integrityFixture(t)
			database := migrationTestDatabase(t)
			database.SetMaxOpenConns(1)
			if err := runMigrationsFromSource(database, url); err != nil {
				t.Fatal(err)
			}
			path := filepath.Join(dir, "1_first.up.sql")
			original, err := os.ReadFile(path)
			if err != nil {
				t.Fatal(err)
			}
			want := ""
			switch change {
			case "changed SQL":
				if err := os.WriteFile(path, append(original, []byte("-- altered\n")...), 0600); err != nil {
					t.Fatal(err)
				}
				want = "checksum mismatch"
			case "deleted SQL":
				if err := os.Remove(path); err != nil {
					t.Fatal(err)
				}
				want = "missing from source"
			case "deleted history":
				if _, err := database.Exec("DELETE FROM schema_migration_integrity WHERE version=1"); err != nil {
					t.Fatal(err)
				}
				want = "integrity record is missing"
			case "newline only":
				if err := os.WriteFile(path, []byte(strings.ReplaceAll(string(original), "\n", "\r\n")), 0600); err != nil {
					t.Fatal(err)
				}
			}
			err = runMigrationsFromSource(database, url)
			if want == "" && err != nil || want != "" && (err == nil || !strings.Contains(err.Error(), want)) {
				t.Fatalf("want %q, got %v", want, err)
			}
			var value string
			if err := database.QueryRow("SELECT value FROM saved_values").Scan(&value); err != nil || value != "kept" {
				t.Fatalf("data changed: %s: %v", value, err)
			}
		})
	}
	t.Run("legacy baseline then sealed", func(t *testing.T) {
		dir, url := integrityFixture(t)
		database := migrationTestDatabase(t)
		executeFixture(t, database, filepath.Join(dir, "1_first.up.sql"))
		if _, err := database.Exec("CREATE TABLE schema_migrations(version bigint NOT NULL PRIMARY KEY,dirty boolean NOT NULL); INSERT INTO schema_migrations VALUES(1,false)"); err != nil {
			t.Fatal(err)
		}
		if err := runMigrationsFromSource(database, url); err != nil {
			t.Fatal(err)
		}
		var origin string
		if err := database.QueryRow("SELECT origin FROM schema_migration_integrity WHERE version=1").Scan(&origin); err != nil || origin != "legacy-baseline" {
			t.Fatalf("baseline origin: %s: %v", origin, err)
		}
		if err := database.QueryRow("SELECT origin FROM schema_migration_integrity WHERE version=2").Scan(&origin); err != nil || origin != "applied" {
			t.Fatalf("new migration origin: %s: %v", origin, err)
		}
	})
	t.Run("concurrent starts", func(t *testing.T) {
		_, url := integrityFixture(t)
		database := migrationTestDatabase(t)
		var wg sync.WaitGroup
		results := make(chan error, 2)
		for i := 0; i < 2; i++ {
			wg.Add(1)
			go func() { defer wg.Done(); results <- runMigrationsFromSource(database, url) }()
		}
		wg.Wait()
		close(results)
		for err := range results {
			if err != nil {
				t.Fatal(err)
			}
		}
		var count int
		if err := database.QueryRow("SELECT count(*) FROM schema_migration_integrity").Scan(&count); err != nil || count != 2 {
			t.Fatalf("seals: %d: %v", count, err)
		}
	})
}

func TestMigrationSnapshotUsesCheckedBytes(t *testing.T) {
	dir, url := integrityFixture(t)
	files, err := source.Open(url)
	if err != nil {
		t.Fatal(err)
	}
	defer files.Close()
	snapshot, err := snapshotMigrations(files)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "1_first.up.sql"), []byte("DROP TABLE saved_values;"), 0600); err != nil {
		t.Fatal(err)
	}
	reader, _, err := snapshot.ReadUp(1)
	if err != nil {
		t.Fatal(err)
	}
	defer reader.Close()
	body, err := io.ReadAll(reader)
	if err != nil || !strings.Contains(string(body), "CREATE TABLE saved_values") || strings.Contains(string(body), "DROP TABLE") {
		t.Fatalf("executed mutable source: %s: %v", body, err)
	}
}
