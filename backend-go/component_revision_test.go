package main

import (
	"context"
	"database/sql"
	"errors"
	"path/filepath"
	"sync"
	"testing"
)

func TestComponentRevisionPostgres(t *testing.T) {
	database := migrationTestDatabase(t)
	for _, name := range []string{"20260612001_init.up.sql", "20260612002_equipment_models.up.sql", "20260930001_component_model_snapshot.up.sql", "20260930002_connection_integrity.up.sql", "20261003001_component_revision.up.sql"} {
		executeFixture(t, database, filepath.Join("..", "database", "migrations", name))
	}
	var id int
	if err := database.QueryRow(`INSERT INTO circuit_schemes(name,description) VALUES('Revision fixture','') RETURNING id`).Scan(&id); err != nil {
		t.Fatal(err)
	}
	var component int
	if err := database.QueryRow(`INSERT INTO scheme_components(scheme_id,component_type_id,pos_x,pos_y,rotation,custom_name)
	 VALUES($1,(SELECT id FROM component_types WHERE code='busbar'),0,0,0,'Bus') RETURNING id`, id).Scan(&component); err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()
	read := func() int64 {
		t.Helper()
		var revision int64
		if err := database.QueryRow(`SELECT revision FROM scheme_components WHERE id=$1`, component).Scan(&revision); err != nil {
			t.Fatal(err)
		}
		return revision
	}
	if read() != 1 {
		t.Fatal("initial revision")
	}
	// Competing clients both loaded revision 1; exactly one may commit.
	start := make(chan struct{})
	results := make(chan error, 2)
	var wg sync.WaitGroup
	for _, x := range []int{10, 20} {
		wg.Add(1)
		go func(x int) {
			defer wg.Done()
			<-start
			_, err := mutateComponentRevision(ctx, database, component, 1, func(tx *sql.Tx) error {
				_, err := tx.ExecContext(ctx, `UPDATE scheme_components SET pos_x=$2 WHERE id=$1`, component, x)
				return err
			}, false)
			results <- err
		}(x)
	}
	close(start)
	wg.Wait()
	close(results)
	wins, conflicts := 0, 0
	for err := range results {
		if err == nil {
			wins++
		} else if errors.Is(err, errComponentConflict) {
			conflicts++
		} else {
			t.Fatal(err)
		}
	}
	if wins != 1 || conflicts != 1 || read() != 2 {
		t.Fatalf("wins=%d conflicts=%d revision=%d", wins, conflicts, read())
	}
	// Geometry and parameters share a revision; a stale parameter must not write.
	parameter := func(tx *sql.Tx) error {
		_, err := tx.ExecContext(ctx, `INSERT INTO scheme_component_params(scheme_component_id,param_key,param_value) VALUES($1,'voltage_nom','110')`, component)
		return err
	}
	if _, err := mutateComponentRevision(ctx, database, component, 1, parameter, false); !errors.Is(err, errComponentConflict) {
		t.Fatalf("stale parameter: %v", err)
	}
	var count int
	if err := database.QueryRow(`SELECT count(*) FROM scheme_component_params WHERE scheme_component_id=$1`, component).Scan(&count); err != nil || count != 0 {
		t.Fatalf("partial conflict: %d %v", count, err)
	}
	if revision, err := mutateComponentRevision(ctx, database, component, 2, parameter, false); err != nil || revision != 3 {
		t.Fatalf("parameter: %d %v", revision, err)
	}
	// A failed transaction rolls back both data and its revision.
	injected := errors.New("injected failure")
	_, err := mutateComponentRevision(ctx, database, component, 3, func(tx *sql.Tx) error {
		if _, err := tx.Exec(`UPDATE scheme_component_params SET param_value='220' WHERE scheme_component_id=$1`, component); err != nil {
			return err
		}
		return injected
	}, false)
	if !errors.Is(err, injected) || read() != 3 {
		t.Fatalf("rollback: %v revision=%d", err, read())
	}
	var value string
	if err := database.QueryRow(`SELECT param_value FROM scheme_component_params WHERE scheme_component_id=$1`, component).Scan(&value); err != nil || value != "110" {
		t.Fatalf("rollback value=%s %v", value, err)
	}
	// Direct SQL changes are observed and cannot forge a revision.
	if _, err := database.Exec(`UPDATE scheme_components SET revision=999 WHERE id=$1`, component); err != nil {
		t.Fatal(err)
	}
	if read() != 4 {
		t.Fatal("forged revision accepted")
	}
	if _, err := database.Exec(`UPDATE scheme_component_params SET param_value='220' WHERE scheme_component_id=$1`, component); err != nil {
		t.Fatal(err)
	}
	if read() != 5 {
		t.Fatal("direct parameter revision")
	}
	if _, err := database.Exec(`UPDATE scheme_component_params SET param_value=param_value WHERE scheme_component_id=$1`, component); err != nil {
		t.Fatal(err)
	}
	if read() != 5 {
		t.Fatal("no-op parameter update")
	}
	if _, err := database.Exec(`DELETE FROM scheme_component_params WHERE scheme_component_id=$1`, component); err != nil {
		t.Fatal(err)
	}
	if read() != 6 {
		t.Fatal("parameter deletion revision")
	}
	deletion := func(tx *sql.Tx) error {
		_, err := tx.Exec(`DELETE FROM scheme_components WHERE id=$1`, component)
		return err
	}
	if _, err := mutateComponentRevision(ctx, database, component, 4, deletion, true); !errors.Is(err, errComponentConflict) {
		t.Fatalf("stale deletion: %v", err)
	}
	if _, err := mutateComponentRevision(ctx, database, component, 6, deletion, true); err != nil {
		t.Fatal(err)
	}
	if _, err := mutateComponentRevision(ctx, database, component, 6, deletion, true); !errors.Is(err, sql.ErrNoRows) {
		t.Fatalf("missing object: %v", err)
	}
}
