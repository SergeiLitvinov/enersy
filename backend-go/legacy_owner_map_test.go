package main

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"os"
	"os/exec"
	"strings"
	"sync"
	"testing"

	"github.com/lib/pq"
)

func ownerID(value string) legacyOwnerID { return legacyOwnerID{Value: &value, Set: true} }

func ownerMapFixture(t *testing.T) (*sql.DB, string, legacyOwnerMap) {
	t.Helper()
	database := migrationTestDatabase(t)
	url := migrationSourceURL(t)
	if err := runMigrationsFromSource(database, url); err != nil {
		t.Fatal(err)
	}
	if _, err := database.Exec(`INSERT INTO users(id,name) VALUES(90011,'Same legacy display name'),(90012,'Same legacy display name');
INSERT INTO circuit_schemes(id,name,description,owner_id,created_at,updated_at) VALUES
(90011,'Legacy network','User description',90011,'2001-01-02','2002-03-04'),
(90012,'Unassigned network',NULL,NULL,NULL,NULL),
(90013,'Orphan reference','Keep me',-99,'2001-01-02','2002-03-04')`); err != nil {
		t.Fatal(err)
	}
	inventory, err := auditLegacyOwners(context.Background(), database, url)
	if err != nil {
		t.Fatal(err)
	}
	plan := legacyOwnerMap{1, "legacy-scheme-owner-map", inventory.Database, inventory.Schema, inventory.SourceVersion, inventory.MigrationSHA256, inventory.SnapshotSHA256, []legacyOwnerChange{}}
	for _, row := range inventory.Schemes {
		if row.ID == "90011" {
			plan.Changes = append(plan.Changes, legacyOwnerChange{row.ID, row.RowSHA256, ownerID("90011"), ownerID("90012"), "Explicit ID review; identical names are not proof of identity"})
		}
	}
	if len(plan.Changes) != 1 {
		t.Fatal("fixture scheme missing")
	}
	return database, url, plan
}

func TestLegacyOwnerMapInput(t *testing.T) {
	plan := legacyOwnerMap{1, "legacy-scheme-owner-map", "database", "public", "20261024001", strings.Repeat("a", 64), strings.Repeat("b", 64),
		[]legacyOwnerChange{{"9007199254740993", strings.Repeat("c", 64), ownerID("-99"), ownerID("9007199254740993"), "Source review"}}}
	body, err := json.Marshal(plan)
	if err != nil {
		t.Fatal(err)
	}
	decoded, err := readLegacyOwnerMap(bytes.NewReader(body))
	if err != nil || *decoded.Changes[0].ToOwnerID.Value != "9007199254740993" {
		t.Fatal(decoded, err)
	}
	for name, invalid := range map[string]string{
		"missing source":  strings.Replace(string(body), `"fromOwnerId":"-99",`, "", 1),
		"missing target":  strings.Replace(string(body), `"toOwnerId":"9007199254740993",`, "", 1),
		"numeric":         strings.Replace(string(body), `"toOwnerId":"9007199254740993"`, `"toOwnerId":9007199254740993`, 1),
		"leading zero":    strings.Replace(string(body), `"-99"`, `"01"`, 1),
		"negative target": strings.Replace(string(body), `"toOwnerId":"9007199254740993"`, `"toOwnerId":"-1"`, 1),
		"alias":           strings.Replace(string(body), `"fromOwnerId":`, `"FromOwnerId":null,"fromOwnerId":`, 1),
	} {
		t.Run(name, func(t *testing.T) {
			if _, err := readLegacyOwnerMap(strings.NewReader(invalid)); err == nil {
				t.Fatal("invalid owner map accepted")
			}
		})
	}
	plan.Changes[0].FromOwnerID = legacyOwnerID{Set: true}
	plan.Changes[0].ToOwnerID = legacyOwnerID{Set: true}
	if err := validateLegacyOwnerMap(plan); err == nil {
		t.Fatal("null to null accepted")
	}
	plan.Changes[0].FromOwnerID = ownerID("1")
	if err := validateLegacyOwnerMap(plan); err != nil {
		t.Fatal("explicit clearing of legacy metadata rejected", err)
	}
	row := legacyOwnerRow{ID: plan.Changes[0].SchemeID, RowSHA256: plan.Changes[0].ExpectedSHA256, OwnerID: plan.Changes[0].FromOwnerID.Value}
	private := "42"
	row.ProjectID = &private
	if err := checkLegacyOwnerBindings(legacyOwnerInventory{Schemes: []legacyOwnerRow{row}}, plan); err == nil {
		t.Fatal("private project scheme accepted")
	}
}

func TestLegacyOwnerBindingsRejectDuplicateSourceIDs(t *testing.T) {
	plan := legacyOwnerMap{Changes: []legacyOwnerChange{{SchemeID: "7", ExpectedSHA256: strings.Repeat("a", 64), FromOwnerID: ownerID("10"), ToOwnerID: ownerID("20")}}}
	row := legacyOwnerRow{ID: "7", RowSHA256: plan.Changes[0].ExpectedSHA256, OwnerID: plan.Changes[0].FromOwnerID.Value}
	before := legacyOwnerInventory{Users: []legacyOwnerRow{{ID: "10"}, {ID: "20"}}, Schemes: []legacyOwnerRow{row}}
	if err := checkLegacyOwnerBindings(before, plan); err != nil {
		t.Fatal("unique explicit IDs rejected", err)
	}
	for _, kind := range []string{"users", "schemes"} {
		t.Run(kind, func(t *testing.T) {
			ambiguous := before
			if kind == "users" {
				ambiguous.Users = append(append([]legacyOwnerRow{}, before.Users...), legacyOwnerRow{ID: "20"})
			} else {
				ambiguous.Schemes = append(append([]legacyOwnerRow{}, before.Schemes...), row)
			}
			if err := checkLegacyOwnerBindings(ambiguous, plan); err == nil {
				t.Fatal("duplicate identity silently collapsed by owner map")
			}
		})
	}
}

func TestLegacyOwnerMapDuplicateIdentitiesPostgres(t *testing.T) {
	for _, table := range []string{"users", "circuit_schemes"} {
		t.Run(table, func(t *testing.T) {
			database, url, plan := ownerMapFixture(t)
			// This disposable fixture models a damaged legacy source lacking
			// its original primary key. No working database is modified.
			duplicate := "90012"
			if table == "circuit_schemes" {
				duplicate = "90011"
			}
			if _, err := database.Exec(`ALTER TABLE ` + pq.QuoteIdentifier(table) + ` DROP CONSTRAINT ` + pq.QuoteIdentifier(table+"_pkey") + ` CASCADE;
INSERT INTO ` + pq.QuoteIdentifier(table) + ` SELECT * FROM ` + pq.QuoteIdentifier(table) + ` WHERE id=` + duplicate); err != nil {
				t.Fatal(err)
			}
			inventory, err := auditLegacyOwners(context.Background(), database, url)
			if err != nil {
				t.Fatal(err)
			}
			// A fresh digest cannot make duplicated IDs unambiguous.
			plan.SnapshotSHA256 = inventory.SnapshotSHA256
			for _, apply := range []bool{false, true} {
				if _, err := executeLegacyOwnerMap(context.Background(), database, url, plan, apply); err == nil || !strings.Contains(err.Error(), "duplicate legacy") {
					t.Fatal("ambiguous identity must reject both check and apply", apply, err)
				}
			}
			after, err := auditLegacyOwners(context.Background(), database, url)
			if err != nil || after.SnapshotSHA256 != inventory.SnapshotSHA256 {
				t.Fatal("rejected ambiguous map changed source rows", after, err)
			}
		})
	}
}

func TestLegacyOwnerMapApplyPostgres(t *testing.T) {
	database, url, plan := ownerMapFixture(t)
	ctx := context.Background()
	state := func() (string, string, string) {
		t.Helper()
		var users, schemes, access string
		if err := database.QueryRow(`SELECT jsonb_agg(to_jsonb(u) ORDER BY id)::text FROM users u`).Scan(&users); err != nil {
			t.Fatal(err)
		}
		if err := database.QueryRow(`SELECT jsonb_agg(to_jsonb(s)-'owner_id' ORDER BY id)::text FROM circuit_schemes s`).Scan(&schemes); err != nil {
			t.Fatal(err)
		}
		if err := database.QueryRow(`SELECT jsonb_build_array((SELECT count(*) FROM auth_accounts),(SELECT count(*) FROM auth_sessions),(SELECT count(*) FROM project_members))::text`).Scan(&access); err != nil {
			t.Fatal(err)
		}
		return users, schemes, access
	}
	users, schemes, access := state()
	check, err := executeLegacyOwnerMap(ctx, database, url, plan, false)
	if err != nil || check.Status != "checked_not_applied" || !check.ReadOnly || check.BeforeSnapshotSHA256 != check.AfterSnapshotSHA256 {
		t.Fatal(check, err)
	}
	applied, err := executeLegacyOwnerMap(ctx, database, url, plan, true)
	if err != nil || applied.Status != "applied" || applied.ReadOnly || applied.MapSHA256 != check.MapSHA256 || applied.BeforeSnapshotSHA256 == applied.AfterSnapshotSHA256 {
		t.Fatal(applied, err)
	}
	afterUsers, afterSchemes, afterAccess := state()
	if users != afterUsers || schemes != afterSchemes || access != afterAccess {
		t.Fatal("owner map changed user rows, other scheme fields or access")
	}
	if _, err := executeLegacyOwnerMap(ctx, database, url, plan, true); err == nil {
		t.Fatal("stale map replay accepted")
	}
	inventory, err := auditLegacyOwners(ctx, database, url)
	if err != nil {
		t.Fatal(err)
	}
	encoded, err := json.Marshal(inventory)
	if err != nil || bytes.Contains(encoded, []byte("Same legacy display name")) || bytes.Contains(encoded, []byte("User description")) {
		t.Fatal("inventory leaked user content", err)
	}
	// Explicitly clear the orphan, then bind the previously NULL reference.
	plan.SnapshotSHA256 = inventory.SnapshotSHA256
	plan.Changes = nil
	for _, row := range inventory.Schemes {
		if row.ID == "90012" || row.ID == "90013" {
			change := legacyOwnerChange{row.ID, row.RowSHA256, legacyOwnerID{Value: row.OwnerID, Set: true}, legacyOwnerID{Set: true}, "Reviewed legacy metadata"}
			if row.ID == "90012" {
				change.ToOwnerID = ownerID("90012")
			}
			plan.Changes = append(plan.Changes, change)
		}
	}
	if _, err := executeLegacyOwnerMap(ctx, database, url, plan, true); err != nil {
		t.Fatal(err)
	}
	var valid bool
	if err := database.QueryRow(`SELECT (SELECT owner_id=90012 FROM circuit_schemes WHERE id=90012) AND (SELECT owner_id IS NULL FROM circuit_schemes WHERE id=90013)`).Scan(&valid); err != nil || !valid {
		t.Fatal("NULL/orphan handling failed", err)
	}
}

func TestLegacyOwnerMapPreconditionsPostgres(t *testing.T) {
	for _, mutation := range []string{"database", "schema", "snapshot", "migration", "version", "scheme hash", "from", "target", "user changed", "scheme changed", "dirty", "history"} {
		t.Run(mutation, func(t *testing.T) {
			database, url, plan := ownerMapFixture(t)
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
			case "snapshot":
				plan.SnapshotSHA256 = strings.Repeat("0", 64)
			case "migration":
				plan.MigrationSHA256 = strings.Repeat("0", 64)
			case "version":
				plan.SourceVersion = "1"
			case "scheme hash":
				plan.Changes[0].ExpectedSHA256 = strings.Repeat("0", 64)
			case "from":
				plan.Changes[0].FromOwnerID = ownerID("9")
			case "target":
				plan.Changes[0].ToOwnerID = ownerID("99999")
			case "user changed":
				exec(`UPDATE users SET name='Different display name' WHERE id=90011`)
			case "scheme changed":
				exec(`UPDATE circuit_schemes SET description='Edited after review' WHERE id=90011`)
			case "dirty":
				exec(`UPDATE schema_migrations SET dirty=true`)
			case "history":
				exec(`DELETE FROM schema_migration_integrity WHERE version=(SELECT min(version) FROM schema_migration_integrity)`)
			}
			for _, apply := range []bool{false, true} {
				if _, err := executeLegacyOwnerMap(context.Background(), database, url, plan, apply); err == nil {
					t.Fatal("invalid owner map accepted", apply)
				}
			}
			var owner string
			if err := database.QueryRow(`SELECT owner_id::text FROM circuit_schemes WHERE id=90011`).Scan(&owner); err != nil || owner != "90011" {
				t.Fatal("rejected map changed owner", err)
			}
		})
	}
}

func TestLegacyOwnerMapAtomicAndConcurrentPostgres(t *testing.T) {
	database, url, plan := ownerMapFixture(t)
	if _, err := database.Exec(`CREATE FUNCTION reject_owner_fixture() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.id=90012 THEN RAISE EXCEPTION 'fixture rejection'; END IF; RETURN NEW; END; $$;
CREATE TRIGGER reject_owner_fixture BEFORE UPDATE ON circuit_schemes FOR EACH ROW EXECUTE FUNCTION reject_owner_fixture()`); err != nil {
		t.Fatal(err)
	}
	inventory, err := auditLegacyOwners(context.Background(), database, url)
	if err != nil {
		t.Fatal(err)
	}
	for _, row := range inventory.Schemes {
		if row.ID == "90012" {
			plan.Changes = append(plan.Changes, legacyOwnerChange{row.ID, row.RowSHA256, legacyOwnerID{Set: true}, ownerID("90012"), "Explicit assignment"})
		}
	}
	if _, err := executeLegacyOwnerMap(context.Background(), database, url, plan, true); err == nil {
		t.Fatal("trigger rejection accepted")
	}
	after, err := auditLegacyOwners(context.Background(), database, url)
	if err != nil || after.SnapshotSHA256 != inventory.SnapshotSHA256 {
		t.Fatal("partial owner map was committed", err)
	}
	plan.Changes = plan.Changes[:1]
	var wg sync.WaitGroup
	errors := make(chan error, 2)
	for range 2 {
		wg.Go(func() {
			_, err := executeLegacyOwnerMap(context.Background(), database, url, plan, true)
			errors <- err
		})
	}
	wg.Wait()
	close(errors)
	success := 0
	for err := range errors {
		if err == nil {
			success++
		}
	}
	if success != 1 {
		t.Fatalf("same map must apply exactly once, got %d", success)
	}
}

func TestLegacyOwnerMapCLIPostgres(t *testing.T) {
	binary := os.Getenv("TEST_OPERATOR_BINARY")
	if binary == "" {
		t.Skip("Set TEST_OPERATOR_BINARY and DB_* / POSTGRES_* for isolated CLI checks")
	}
	database, url, plan := ownerMapFixture(t)
	body, err := json.Marshal(plan)
	if err != nil {
		t.Fatal(err)
	}
	run := func(success bool, args ...string) []byte {
		t.Helper()
		cmd := exec.Command(binary, args...)
		cmd.Env = append(os.Environ(), "PGOPTIONS=-c search_path="+plan.Schema, "MIGRATIONS_SOURCE="+url)
		cmd.Stdin = bytes.NewReader(body)
		var output, diagnostic bytes.Buffer
		cmd.Stdout, cmd.Stderr = &output, &diagnostic
		err := cmd.Run()
		if (err == nil) != success || !success && output.Len() != 0 {
			t.Fatalf("CLI result mismatch: %v, %s", err, diagnostic.String())
		}
		return output.Bytes()
	}
	var inventory legacyOwnerInventory
	if err := json.Unmarshal(run(true, "-audit-legacy-owners"), &inventory); err != nil || inventory.SnapshotSHA256 != plan.SnapshotSHA256 {
		t.Fatal(inventory, err)
	}
	var result legacyOwnerMapResult
	if err := json.Unmarshal(run(true, "-check-legacy-owner-map"), &result); err != nil || result.Status != "checked_not_applied" {
		t.Fatal(result, err)
	}
	run(false, "-apply-legacy-owner-map", "-check-catalog-map")
	if err := json.Unmarshal(run(true, "-apply-legacy-owner-map"), &result); err != nil || result.Status != "applied" {
		t.Fatal(result, err)
	}
	run(false, "-apply-legacy-owner-map")
	var owner string
	if err := database.QueryRow(`SELECT owner_id::text FROM circuit_schemes WHERE id=90011`).Scan(&owner); err != nil || owner != "90012" {
		t.Fatal("CLI binding mismatch", err)
	}
}

func TestLegacyOwnerMapLockTimeoutPostgres(t *testing.T) {
	database, url, plan := ownerMapFixture(t)
	lock, err := database.Begin()
	if err != nil {
		t.Fatal(err)
	}
	defer rollbackTx(lock)
	if _, err := lock.Exec(`LOCK TABLE users IN SHARE ROW EXCLUSIVE MODE`); err != nil {
		t.Fatal(err)
	}
	if _, err := executeLegacyOwnerMap(context.Background(), database, url, plan, true); err == nil || !strings.Contains(err.Error(), "lock timeout") {
		t.Fatal("owner map must reject a busy maintenance table", err)
	}
	var owner string
	if err := database.QueryRow(`SELECT owner_id::text FROM circuit_schemes WHERE id=90011`).Scan(&owner); err != nil || owner != "90011" {
		t.Fatal("lock timeout changed legacy owner", err)
	}
}

func TestLegacyOwnerAuditSchemaBoundaryPostgres(t *testing.T) {
	database, url, plan := ownerMapFixture(t)
	empty := plan.Schema + "_empty"
	if _, err := database.Exec(`CREATE SCHEMA ` + pq.QuoteIdentifier(empty)); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if _, err := database.Exec(`DROP SCHEMA ` + pq.QuoteIdentifier(empty)); err != nil {
			t.Error(err)
		}
	})
	// The second schema has a complete catalog. A missing selected schema must
	// not silently read rows or migration history from a search_path fallback.
	shadow, err := sql.Open("postgres", os.Getenv("TEST_DATABASE_URL")+" search_path="+empty+","+plan.Schema)
	if err != nil {
		t.Fatal(err)
	}
	defer shadow.Close()
	if _, err := auditLegacyOwners(context.Background(), shadow, url); err == nil {
		t.Fatal("owner inventory crossed the selected schema boundary")
	}
}
