package main

import (
	"context"
	"database/sql"
	"fmt"
	"sort"
	"time"
)

type catalogBinding struct {
	KeySHA256     string   `json:"keySha256"`
	Kind          string   `json:"kind"`
	SourceRefs    []string `json:"sourceRefs"`
	ChangedFields []string `json:"changedFields"`
	RefsTruncated bool     `json:"refsTruncated"`
}
type catalogEntityAudit struct {
	Name              string           `json:"name"`
	Available         bool             `json:"available"`
	ExpectedRows      int              `json:"expectedRows"`
	ActualRows        *int             `json:"actualRows"`
	Matched           int              `json:"matched"`
	Modified          int              `json:"modified"`
	Extra             int              `json:"extra"`
	Missing           int              `json:"missing"`
	Ambiguous         int              `json:"ambiguous"`
	Invalid           int              `json:"invalid"`
	Bindings          []catalogBinding `json:"bindings"`
	BindingsTruncated bool             `json:"bindingsTruncated"`
}
type catalogAudit struct {
	FormatVersion   int                  `json:"formatVersion"`
	Scope           string               `json:"scope"`
	ReadOnly        bool                 `json:"readOnly"`
	Status          string               `json:"status"`
	CapturedAt      time.Time            `json:"capturedAt"`
	SourceVersion   string               `json:"sourceVersion"`
	MigrationSHA256 string               `json:"migrationSha256"`
	BaselineSHA256  string               `json:"baselineSha256"`
	SnapshotSHA256  string               `json:"snapshotSha256"`
	Database        string               `json:"database"`
	Schema          string               `json:"schema"`
	Entities        []catalogEntityAudit `json:"entities"`
}

func compareCatalog(b catalogBaseline, s catalogSnapshot) (catalogAudit, error) {
	// Do not let database row order or caller-owned slices change the fingerprint.
	s.Entities = append([]catalogEntity(nil), s.Entities...)
	for i := range s.Entities {
		s.Entities[i].Records = append([]catalogRecord(nil), s.Entities[i].Records...)
		sortCatalogRecords(s.Entities[i].Records)
	}
	r := catalogAudit{FormatVersion: 1, Scope: "catalog-seed-comparison", ReadOnly: true, Status: "matches_seed_baseline", CapturedAt: s.CapturedAt, SourceVersion: b.SourceVersion, MigrationSHA256: b.MigrationSHA256, BaselineSHA256: catalogDigest(b), SnapshotSHA256: catalogDigest(s.Entities), Entities: []catalogEntityAudit{}}
	r.Database, r.Schema = s.Database, s.Schema
	if err := validateCatalogBaseline(b); err != nil {
		return r, err
	}
	if len(s.Entities) != len(b.Entities) {
		return r, fmt.Errorf("catalog entity set mismatch")
	}
	for i, actual := range s.Entities {
		expected := b.Entities[i]
		if actual.Name != expected.Name {
			return r, fmt.Errorf("catalog entity identity mismatch")
		}
		a := catalogEntityAudit{Name: actual.Name, Available: actual.Available, ExpectedRows: len(expected.Records), Bindings: []catalogBinding{}}
		if !actual.Available {
			r.Status = "review_required"
			r.Entities = append(r.Entities, a)
			continue
		}
		n := len(actual.Records)
		a.ActualRows = &n
		byKey := map[string][]catalogRecord{}
		refCounts := map[string]int{}
		keys := map[string]bool{}
		base := map[string]catalogRecord{}
		for _, e := range expected.Records {
			base[e.Key] = e
			keys[e.Key] = true
		}
		add := func(v catalogBinding) {
			if len(a.Bindings) < 1000 {
				a.Bindings = append(a.Bindings, v)
			} else {
				a.BindingsTruncated = true
			}
		}
		for _, record := range actual.Records {
			refCounts[record.SourceRef]++
		}
		for _, record := range actual.Records {
			if !record.ValidKey {
				a.Invalid++
				add(catalogBinding{record.Key, "invalid_key", []string{record.SourceRef}, []string{}, false})
				continue
			}
			byKey[record.Key] = append(byKey[record.Key], record)
			keys[record.Key] = true
		}
		ordered := []string{}
		for key := range keys {
			ordered = append(ordered, key)
		}
		sort.Strings(ordered)
		for _, key := range ordered {
			rows := byKey[key]
			original, exists := base[key]
			binding := catalogBinding{KeySHA256: key, SourceRefs: []string{}, ChangedFields: []string{}}
			for _, row := range rows {
				if len(binding.SourceRefs) < 20 {
					binding.SourceRefs = append(binding.SourceRefs, row.SourceRef)
				} else {
					binding.RefsTruncated = true
				}
			}
			switch {
			case len(rows) == 0:
				binding.Kind = "missing"
				a.Missing++
			case len(rows) > 1 || len(rows) == 1 && refCounts[rows[0].SourceRef] > 1:
				binding.Kind = "ambiguous"
				a.Ambiguous++
			case !exists:
				binding.Kind = "extra"
				a.Extra++
			default:
				for field, value := range original.Fields {
					if rows[0].Fields[field] != value {
						binding.ChangedFields = append(binding.ChangedFields, field)
					}
				}
				sort.Strings(binding.ChangedFields)
				if len(binding.ChangedFields) > 0 {
					binding.Kind = "modified"
					a.Modified++
				} else {
					binding.Kind = "matched"
					a.Matched++
				}
			}
			add(binding)
		}
		if a.Modified+a.Extra+a.Missing+a.Ambiguous+a.Invalid > 0 {
			r.Status = "review_required"
		}
		r.Entities = append(r.Entities, a)
	}
	return r, nil
}
func auditCatalog(ctx context.Context, db *sql.DB, url, path string) (catalogAudit, error) {
	b, err := readCatalogBaseline(path, url)
	if err != nil {
		return catalogAudit{}, err
	}
	s, err := readCatalogSnapshot(ctx, db)
	if err != nil {
		return catalogAudit{}, err
	}
	return compareCatalog(b, s)
}
