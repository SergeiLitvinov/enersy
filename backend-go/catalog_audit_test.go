package main

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"strconv"
	"strings"
	"testing"
)

// UPDATE_CATALOG_BASELINE=1 is an explicit development-only generator. The database
// is always a new isolated schema produced by the full migration chain.
func TestCatalogBaselinePostgres(t *testing.T) {
	db := migrationTestDatabase(t)
	url := migrationSourceURL(t)
	if err := runMigrationsFromSource(db, url); err != nil {
		t.Fatal(err)
	}
	b, err := generateCatalogBaseline(context.Background(), db, url)
	if err != nil {
		t.Fatal(err)
	}
	path := filepath.Join("..", "database", "catalog-baseline.v1.json")
	if os.Getenv("UPDATE_CATALOG_BASELINE") == "1" {
		body, err := json.MarshalIndent(b, "", "  ")
		if err != nil {
			t.Fatal(err)
		}
		if err = os.WriteFile(path, append(body, '\n'), 0644); err != nil {
			t.Fatal(err)
		}
	}
	stored, err := readCatalogBaseline(path, url)
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(b, stored) {
		t.Fatal("shipped catalog baseline differs from a fresh migrated database; regenerate and review")
	}
	r, err := auditCatalog(context.Background(), db, url, path)
	if err != nil || r.Status != "matches_seed_baseline" {
		t.Fatal(r, err)
	}
	for _, e := range r.Entities {
		if !e.Available || e.Matched != e.ExpectedRows {
			t.Fatal(e)
		}
	}
}

func TestCatalogAuditChangesPostgres(t *testing.T) {
	db := migrationTestDatabase(t)
	url := migrationSourceURL(t)
	ctx := context.Background()
	if err := runMigrationsFromSource(db, url); err != nil {
		t.Fatal(err)
	}
	b, err := generateCatalogBaseline(ctx, db, url)
	if err != nil {
		t.Fatal(err)
	}
	var modelID, paramID string
	if err = db.QueryRow(`SELECT m.id::text,p.id::text FROM equipment_models m JOIN equipment_model_params p ON p.equipment_model_id=m.id ORDER BY m.id,p.id LIMIT 1`).Scan(&modelID, &paramID); err != nil {
		t.Fatal(err)
	}
	if _, err = db.Exec(`UPDATE equipment_models SET manufacturer=NULL WHERE id=$1`, modelID); err != nil {
		t.Fatal(err)
	}
	nullSnapshot, err := readCatalogSnapshot(ctx, db)
	if err != nil {
		t.Fatal(err)
	}
	hashBytes := func(value []byte) string { sum := sha256.Sum256(value); return hex.EncodeToString(sum[:]) }
	manufacturer := func(s catalogSnapshot) string {
		for _, e := range s.Entities {
			if e.Name == "models" {
				for _, row := range e.Records {
					if row.SourceRef == modelID {
						return row.Fields["manufacturer"]
					}
				}
			}
		}
		t.Fatal("fixture model absent")
		return ""
	}
	if manufacturer(nullSnapshot) != hashBytes([]byte{0}) {
		t.Fatal("database NULL hash differs from independent byte contract")
	}
	if _, err = db.Exec(`UPDATE equipment_models SET manufacturer='' WHERE id=$1`, modelID); err != nil {
		t.Fatal(err)
	}
	emptySnapshot, err := readCatalogSnapshot(ctx, db)
	if err != nil {
		t.Fatal(err)
	}
	if catalogDigest(nullSnapshot.Entities) == catalogDigest(emptySnapshot.Entities) {
		t.Fatal("NULL became an empty string")
	}
	if manufacturer(emptySnapshot) != hashBytes([]byte{1}) {
		t.Fatal("empty string hash differs from independent byte contract")
	}
	if _, err = db.Exec(`UPDATE equipment_model_params SET param_value='Private edited value <not for report>' WHERE id=$1;`, paramID); err != nil {
		t.Fatal(err)
	}
	if _, err = db.Exec(`INSERT INTO equipment_models(component_type_id,model_name,manufacturer) SELECT id,'Private custom model','Private manufacturer' FROM component_types WHERE code='generator'; INSERT INTO equipment_model_params(equipment_model_id,param_key,param_value) VALUES(NULL,'private-orphan','Private orphan value')`); err != nil {
		t.Fatal(err)
	}
	if _, err = db.Exec(`DELETE FROM component_params_template WHERE id=(SELECT min(id) FROM component_params_template)`); err != nil {
		t.Fatal(err)
	}
	// Explicitly damaged legacy fixture: the audit must keep all candidates.
	if _, err = db.Exec(`ALTER TABLE equipment_models DROP CONSTRAINT equipment_models_component_type_id_model_name_key`); err != nil {
		t.Fatal(err)
	}
	if _, err = db.Exec(`INSERT INTO equipment_models(component_type_id,model_name,manufacturer,description) SELECT component_type_id,model_name,manufacturer,description FROM equipment_models WHERE id=$1`, modelID); err != nil {
		t.Fatal(err)
	}
	before, err := readCatalogSnapshot(ctx, db)
	if err != nil {
		t.Fatal(err)
	}
	r, err := compareCatalog(b, before)
	if err != nil {
		t.Fatal(err)
	}
	after, err := readCatalogSnapshot(ctx, db)
	if err != nil || !reflect.DeepEqual(before.Entities, after.Entities) {
		t.Fatal("audit modified source", err)
	}
	byName := map[string]catalogEntityAudit{}
	for _, e := range r.Entities {
		byName[e.Name] = e
	}
	if r.Status != "review_required" || byName["models"].Ambiguous != 1 || byName["models"].Extra != 1 || byName["model_params"].Modified != 1 || byName["model_params"].Invalid != 1 || byName["templates"].Missing != 1 {
		t.Fatalf("classification mismatch: status=%s models ambiguous=%d extra=%d params modified=%d invalid=%d templates missing=%d", r.Status, byName["models"].Ambiguous, byName["models"].Extra, byName["model_params"].Modified, byName["model_params"].Invalid, byName["templates"].Missing)
	}
	body, _ := json.Marshal(r)
	for _, private := range []string{"Private", "private-orphan", "not for report"} {
		if strings.Contains(string(body), private) {
			t.Fatal("private catalog values leaked", private)
		}
	}
	found := false
	for _, binding := range byName["model_params"].Bindings {
		if binding.Kind == "modified" && reflect.DeepEqual(binding.SourceRefs, []string{paramID}) {
			found = true
		}
	}
	if !found {
		t.Fatal("changed parameter lost its source ID")
	}
	// Numeric IDs and row order do not determine equality with the canonical seed.
	copySnapshot := catalogSnapshot{Entities: append([]catalogEntity(nil), b.Entities...)}
	for i := range copySnapshot.Entities {
		copySnapshot.Entities[i].Records = append([]catalogRecord(nil), copySnapshot.Entities[i].Records...)
		for j := range copySnapshot.Entities[i].Records {
			copySnapshot.Entities[i].Records[j].SourceRef = strconv.FormatInt(9007199254740993+int64(j), 10)
		}
	}
	if changed, err := compareCatalog(b, copySnapshot); err != nil || changed.Status != "matches_seed_baseline" {
		t.Fatal("IDs altered catalog equality", err)
	}
	first, err := compareCatalog(b, copySnapshot)
	if err != nil {
		t.Fatal(err)
	}
	for i := range copySnapshot.Entities {
		records := copySnapshot.Entities[i].Records
		for left, right := 0, len(records)-1; left < right; left, right = left+1, right-1 {
			records[left], records[right] = records[right], records[left]
		}
	}
	second, err := compareCatalog(b, copySnapshot)
	if err != nil || first.SnapshotSHA256 != second.SnapshotSHA256 || !reflect.DeepEqual(first.Entities, second.Entities) {
		t.Fatal("row order altered bindings", err)
	}
}

func TestCatalogAuditLegacyPostgres(t *testing.T) {
	for _, fixture := range []string{"init.sql", "ees_schema.sql"} {
		t.Run(fixture, func(t *testing.T) {
			db := migrationTestDatabase(t)
			executeFixture(t, db, filepath.Join("..", "database", fixture))
			before, err := readCatalogSnapshot(context.Background(), db)
			if err != nil {
				t.Fatal(err)
			}
			b, err := readCatalogBaseline(filepath.Join("..", "database", "catalog-baseline.v1.json"), migrationSourceURL(t))
			if err != nil {
				t.Fatal(err)
			}
			r, err := compareCatalog(b, before)
			if err != nil {
				t.Fatal(err)
			}
			for _, e := range r.Entities {
				t.Logf("%s: matched=%d modified=%d extra=%d missing=%d ambiguous=%d invalid=%d", e.Name, e.Matched, e.Modified, e.Extra, e.Missing, e.Ambiguous, e.Invalid)
			}
			if fixture == "init.sql" && r.Status != "matches_seed_baseline" {
				t.Fatal("current bootstrap differs from canonical seed")
			}
			if fixture == "ees_schema.sql" && r.Status != "review_required" {
				t.Fatal("historical seed differences hidden")
			}
			if fixture == "ees_schema.sql" {
				for _, e := range r.Entities {
					if e.Name == "model_params" && e.Missing != 76 {
						t.Fatalf("historical missing params changed: %d", e.Missing)
					}
				}
			}
			after, err := readCatalogSnapshot(context.Background(), db)
			if err != nil || !reflect.DeepEqual(before.Entities, after.Entities) {
				t.Fatal("legacy source changed", err)
			}
		})
	}
}

func TestLegacyCatalogOverridesSurviveUpgradePostgres(t *testing.T) {
	for _, fixture := range []string{"init.sql", "ees_schema.sql"} {
		t.Run(fixture, func(t *testing.T) {
			db := migrationTestDatabase(t)
			url := migrationSourceURL(t)
			ctx := context.Background()
			executeFixture(t, db, filepath.Join("..", "database", fixture))
			var parameterID, customID string
			if err := db.QueryRow(`SELECT min(id)::text FROM equipment_model_params`).Scan(&parameterID); err != nil {
				t.Fatal(err)
			}
			const edited = "operator override - preserve exact text 10.500"
			if _, err := db.Exec(`UPDATE equipment_model_params SET param_value=$1 WHERE id=$2`, edited, parameterID); err != nil {
				t.Fatal(err)
			}
			if err := db.QueryRow(`INSERT INTO equipment_models(component_type_id,model_name,manufacturer) SELECT id,'Private upgrade fixture','Private maker' FROM component_types WHERE code='generator' RETURNING id::text`).Scan(&customID); err != nil {
				t.Fatal(err)
			}
			b, err := readCatalogBaseline(filepath.Join("..", "database", "catalog-baseline.v1.json"), url)
			if err != nil {
				t.Fatal(err)
			}
			before, err := readCatalogSnapshot(ctx, db)
			if err != nil {
				t.Fatal(err)
			}
			r, err := compareCatalog(b, before)
			if err != nil || r.Status != "review_required" {
				t.Fatal("overrides hidden", err)
			}
			if err = runMigrationsFromSource(db, url); err != nil {
				t.Fatal(err)
			}
			var preserved string
			if err = db.QueryRow(`SELECT param_value FROM equipment_model_params WHERE id=$1`, parameterID).Scan(&preserved); err != nil || preserved != edited {
				t.Fatal("operator value overwritten", err)
			}
			after, err := readCatalogSnapshot(ctx, db)
			if err != nil {
				t.Fatal(err)
			}
			r, err = compareCatalog(b, after)
			if err != nil {
				t.Fatal(err)
			}
			for _, e := range r.Entities {
				if e.Missing != 0 || e.Ambiguous != 0 || e.Invalid != 0 {
					t.Fatal("upgrade did not fill only known gaps", e.Name, e.Missing, e.Ambiguous, e.Invalid)
				}
				if e.Name == "models" && e.Extra != 1 {
					t.Fatal("custom model lost")
				}
				if e.Name == "model_params" && e.Modified != 1 {
					t.Fatal("edited parameter lost")
				}
				for _, binding := range e.Bindings {
					if e.Name == "models" && binding.Kind == "extra" && !reflect.DeepEqual(binding.SourceRefs, []string{customID}) {
						t.Fatal("custom ID changed")
					}
					if e.Name == "model_params" && binding.Kind == "modified" && !reflect.DeepEqual(binding.SourceRefs, []string{parameterID}) {
						t.Fatal("parameter ID changed")
					}
				}
			}
		})
	}
}

func TestCatalogAuditMissingSchemaPostgres(t *testing.T) {
	db := migrationTestDatabase(t)
	if _, err := generateCatalogBaseline(context.Background(), db, migrationSourceURL(t)); err == nil {
		t.Fatal("unversioned database became a canonical seed baseline")
	}
	s, err := readCatalogSnapshot(context.Background(), db)
	if err != nil {
		t.Fatal(err)
	}
	b, err := readCatalogBaseline(filepath.Join("..", "database", "catalog-baseline.v1.json"), migrationSourceURL(t))
	if err != nil {
		t.Fatal(err)
	}
	r, err := compareCatalog(b, s)
	if err != nil || r.Status != "review_required" {
		t.Fatal(r, err)
	}
	for _, e := range r.Entities {
		if e.Available || e.ActualRows != nil || e.Missing != 0 {
			t.Fatal("missing schema became zero rows", e)
		}
	}
	path := filepath.Join(t.TempDir(), "bad.json")
	bad := b
	bad.MigrationSHA256 = strings.Repeat("0", 64)
	body, _ := json.Marshal(bad)
	if err = os.WriteFile(path, body, 0600); err != nil {
		t.Fatal(err)
	}
	if _, err = readCatalogBaseline(path, migrationSourceURL(t)); err == nil {
		t.Fatal("stale baseline accepted")
	}
}

func TestCatalogAuditBindingLimits(t *testing.T) {
	b, err := readCatalogBaseline(filepath.Join("..", "database", "catalog-baseline.v1.json"), migrationSourceURL(t))
	if err != nil {
		t.Fatal(err)
	}
	s := catalogSnapshot{Entities: append([]catalogEntity(nil), b.Entities...)}
	for i := range s.Entities {
		s.Entities[i].Records = append([]catalogRecord(nil), s.Entities[i].Records...)
		for j := range s.Entities[i].Records {
			s.Entities[i].Records[j].SourceRef = strconv.Itoa(j + 1)
		}
	}
	models := &s.Entities[2]
	for i := 0; i < 1200; i++ {
		record := models.Records[0]
		sum := sha256.Sum256([]byte("synthetic storage key " + strconv.Itoa(i)))
		record.Key = hex.EncodeToString(sum[:])
		record.SourceRef = strconv.Itoa(100000 + i)
		models.Records = append(models.Records, record)
	}
	r, err := compareCatalog(b, s)
	if err != nil {
		t.Fatal(err)
	}
	if e := r.Entities[2]; e.Extra != 1200 || e.Matched != 90 || !e.BindingsTruncated || len(e.Bindings) != 1000 {
		t.Fatal("bounded details changed full counts", e.Extra, e.Matched, len(e.Bindings))
	}
	models.Records = models.Records[:90]
	key := models.Records[0].Key
	for i := 0; i < 25; i++ {
		record := models.Records[0]
		record.SourceRef = strconv.Itoa(200000 + i)
		models.Records = append(models.Records, record)
	}
	r, err = compareCatalog(b, s)
	if err != nil {
		t.Fatal(err)
	}
	found := false
	for _, binding := range r.Entities[2].Bindings {
		if binding.KeySHA256 == key {
			found = binding.Kind == "ambiguous" && binding.RefsTruncated && len(binding.SourceRefs) == 20
		}
	}
	if !found || r.Entities[2].Ambiguous != 1 {
		t.Fatal("ambiguous references were silently selected")
	}
	models.Records = models.Records[:90]
	models.Records[0].SourceRef = models.Records[1].SourceRef
	r, err = compareCatalog(b, s)
	if err != nil || r.Entities[2].Ambiguous != 2 {
		t.Fatal("duplicate source IDs were treated as a unique mapping", err)
	}
}
