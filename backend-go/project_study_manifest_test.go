package main

import (
	"context"
	"errors"
	"strconv"
	"testing"
)

func TestStudyManifestValidation(t *testing.T) {
	for _, source := range [][]studySourceRevision{
		nil, {{"01", "1"}}, {{"1", "0"}}, {{"1", "01"}}, {{"1", "9223372036854775808"}},
		{{"1", "1"}, {"1", "2"}}, {{"2", "1"}, {"1", "1"}}, {{"2147483648", "1"}},
	} {
		if !errors.Is(validateStudySourceManifest(&source), errStudyInput) {
			t.Fatalf("accepted invalid manifest: %#v", source)
		}
	}
	empty := []studySourceRevision{}
	if err := validateStudySourceManifest(&empty); err != nil {
		t.Fatal(err)
	}
	if err := matchStudySourceManifest(&empty, []calculationComponent{{ID: 1, Revision: 1}}); !errors.Is(err, errStudySource) {
		t.Fatal(err)
	}
	good := []studySourceRevision{{"1", "9223372036854775807"}}
	if err := validateStudySourceManifest(&good); err != nil {
		t.Fatal(err)
	}
	if err := matchStudySourceManifest(nil, nil); err != nil {
		t.Fatal(err)
	}
}

func TestStudyObservedSourceBeforeReadPostgres(t *testing.T) {
	f := newStudyFixture(t)
	ctx := context.Background()
	readManifest := func() []studySourceRevision {
		t.Helper()
		rows, err := f.store.database.QueryContext(ctx, `SELECT id,revision FROM scheme_components WHERE scheme_id=$1 ORDER BY id`, f.scheme)
		if err != nil {
			t.Fatal(err)
		}
		defer rows.Close()
		source := []studySourceRevision{}
		for rows.Next() {
			var id, revision int64
			if err := rows.Scan(&id, &revision); err != nil {
				t.Fatal(err)
			}
			source = append(source, studySourceRevision{strconv.FormatInt(id, 10), strconv.FormatInt(revision, 10)})
		}
		if err := rows.Err(); err != nil {
			t.Fatal(err)
		}
		return source
	}
	observed := readManifest()
	if _, err := f.store.database.ExecContext(ctx, `UPDATE scheme_component_params SET param_value='0.1' WHERE scheme_component_id=$1 AND param_key='p'`, f.load); err != nil {
		t.Fatal(err)
	}
	save := func(source []studySourceRevision) (studyVersion, error) {
		return f.store.SaveStudy(ctx, f.tokens[0].Token, f.project, f.scheme, 0, 0, f.topology, studyCommand(861), f.doc, &source)
	}
	if _, err := save(observed); !errors.Is(err, errStudySource) {
		t.Fatalf("stale source accepted: %v", err)
	}
	var count int
	if err := f.store.database.QueryRowContext(ctx, `SELECT count(*) FROM project_studies WHERE project_id=$1`, f.project).Scan(&count); err != nil || count != 0 {
		t.Fatalf("partial Study: %d %v", count, err)
	}
	refreshed := readManifest()
	captured, err := save(refreshed)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := f.store.database.ExecContext(ctx, `UPDATE scheme_component_params SET param_value='0.05' WHERE scheme_component_id=$1 AND param_key='p'`, f.load); err != nil {
		t.Fatal(err)
	}
	replay, err := save(refreshed)
	if err != nil || replay.ID != captured.ID || replay.InputSHA256 != captured.InputSHA256 {
		t.Fatalf("replay changed: %v", err)
	}
	if _, err := save(readManifest()); !errors.Is(err, errStudyCommand) {
		t.Fatalf("manifest absent from command digest: %v", err)
	}
}
