package main

import (
	"bytes"
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"

	"github.com/golang-migrate/migrate/v4/source"
)

type catalogBaseline struct {
	FormatVersion   int             `json:"formatVersion"`
	SourceVersion   string          `json:"sourceVersion"`
	MigrationSHA256 string          `json:"migrationSha256"`
	Entities        []catalogEntity `json:"entities"`
}

var catalogHash = regexp.MustCompile(`^[0-9a-f]{64}$`)

func catalogMigrationIdentity(url string) (string, string, error) {
	files, err := source.Open(url)
	if err != nil {
		return "", "", err
	}
	defer files.Close()
	snapshot, err := snapshotMigrations(files)
	if err != nil {
		return "", "", err
	}
	versions := []uint{}
	for version := range snapshot.scripts {
		versions = append(versions, version)
	}
	sort.Slice(versions, func(i, j int) bool { return versions[i] < versions[j] })
	pairs := [][2]string{}
	for _, v := range versions {
		pairs = append(pairs, [2]string{strconv.FormatUint(uint64(v), 10), snapshot.scripts[v].hash})
	}
	return pairs[len(pairs)-1][0], catalogDigest(pairs), nil
}

// Every allowed value has a finite, non-recursive structure made only of JSON
// strings, booleans and integers. json.Marshal cannot reject these input types.
type catalogDigestInput interface {
	catalogBaseline | []catalogEntity | [][2]string | map[string]string
}

func catalogDigest[T catalogDigestInput](value T) string {
	body, _ := json.Marshal(value)
	hash := sha256.Sum256(body)
	return hex.EncodeToString(hash[:])
}

// Used only by the independent fresh-database generator/test. Runtime never
// creates a baseline from the database that it is supposed to audit.
func generateCatalogBaseline(ctx context.Context, db *sql.DB, url string) (catalogBaseline, error) {
	version, digest, err := catalogMigrationIdentity(url)
	if err != nil {
		return catalogBaseline{}, err
	}
	provenance, err := auditDatabase(ctx, db, url)
	if err != nil {
		return catalogBaseline{}, err
	}
	if provenance.Version == nil || *provenance.Version != version || provenance.Dirty == nil || *provenance.Dirty {
		return catalogBaseline{}, fmt.Errorf("baseline generator requires a fully migrated clean database")
	}
	for _, field := range []string{"checksumMismatches", "missingIntegrityEntries", "unexpectedIntegrityEntries", "legacyBaselineEntries"} {
		if provenance.Counts[field] == nil || *provenance.Counts[field] != 0 {
			return catalogBaseline{}, fmt.Errorf("baseline generator requires checked applied migration history")
		}
	}
	snapshot, err := readCatalogSnapshot(ctx, db)
	if err != nil {
		return catalogBaseline{}, err
	}
	endVersion, endDigest, err := catalogMigrationIdentity(url)
	if err != nil {
		return catalogBaseline{}, err
	}
	if endVersion != version || endDigest != digest {
		return catalogBaseline{}, fmt.Errorf("migration source changed during baseline generation")
	}
	for i := range snapshot.Entities {
		for j := range snapshot.Entities[i].Records {
			snapshot.Entities[i].Records[j].SourceRef = ""
		}
	}
	b := catalogBaseline{1, version, digest, snapshot.Entities}
	if err := validateCatalogBaseline(b); err != nil {
		return b, err
	}
	return b, nil
}
func validateCatalogBaseline(b catalogBaseline) error {
	fail := func() error { return fmt.Errorf("invalid catalog baseline") }
	if b.FormatVersion != 1 || !catalogHash.MatchString(b.MigrationSHA256) || !decimalString(b.SourceVersion) {
		return fail()
	}
	definitions := catalogQueries(func(s string) string { return s })
	if len(b.Entities) != len(definitions) {
		return fail()
	}
	for i, entity := range b.Entities {
		def := definitions[i]
		if entity.Name != def.name || !entity.Available || len(entity.Records) == 0 || len(entity.Records) > catalogRowLimit {
			return fail()
		}
		previous := ""
		for _, r := range entity.Records {
			if !r.ValidKey || r.SourceRef != "" || !catalogHash.MatchString(r.Key) || r.Key <= previous || len(r.Fields) != len(def.fields) {
				return fail()
			}
			previous = r.Key
			for field := range def.fields {
				if !catalogHash.MatchString(r.Fields[field]) {
					return fail()
				}
			}
		}
	}
	return nil
}
func decimalString(s string) bool {
	if s == "" || s[0] == '0' {
		return false
	}
	for _, c := range []byte(s) {
		if c < '0' || c > '9' {
			return false
		}
	}
	_, err := strconv.ParseUint(s, 10, 64)
	return err == nil
}
func readCatalogBaseline(path, url string) (catalogBaseline, error) {
	f, err := os.Open(path)
	if err != nil {
		return catalogBaseline{}, err
	}
	defer f.Close()
	body, err := io.ReadAll(io.LimitReader(f, 2*1024*1024+1))
	if err != nil || len(body) > 2*1024*1024 {
		return catalogBaseline{}, fmt.Errorf("catalog baseline exceeds size limit or cannot be read")
	}
	var b catalogBaseline
	decoder := json.NewDecoder(bytes.NewReader(body))
	decoder.DisallowUnknownFields()
	if err = decoder.Decode(&b); err != nil {
		return b, err
	}
	var trailing any
	if err = decoder.Decode(&trailing); err != io.EOF {
		return b, fmt.Errorf("catalog baseline has trailing data")
	}
	if err = validateCatalogBaseline(b); err != nil {
		return b, err
	}
	version, digest, err := catalogMigrationIdentity(url)
	if err != nil {
		return b, err
	}
	if version != b.SourceVersion || digest != b.MigrationSHA256 {
		return b, fmt.Errorf("catalog baseline does not match the shipped migration source; regenerate on a fresh database")
	}
	return b, nil
}
func configuredCatalogBaseline() (string, error) {
	if path := os.Getenv("CATALOG_BASELINE_SOURCE"); path != "" {
		return path, nil
	}
	executable, err := os.Executable()
	if err != nil {
		return "", err
	}
	return filepath.Join(filepath.Dir(executable), "database", "catalog-baseline.v1.json"), nil
}
