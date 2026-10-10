package main

import (
	"context"
	"testing"
	"time"
)

func TestTopologyRevisionBulkPostgres(t *testing.T) {
	database := migrationTestDatabase(t)
	if err := runMigrationsFromSource(database, migrationSourceURL(t)); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	var scheme int
	if err := database.QueryRowContext(ctx, `INSERT INTO circuit_schemes(name,description) VALUES('Bulk topology','') RETURNING id`).Scan(&scheme); err != nil {
		t.Fatal(err)
	}
	read := func(expected int64) {
		t.Helper()
		var revision int64
		if err := database.QueryRowContext(ctx, `SELECT topology_revision FROM circuit_schemes WHERE id=$1`, scheme).Scan(&revision); err != nil || revision != expected {
			t.Fatalf("revision %d want %d: %v", revision, expected, err)
		}
	}
	read(0)
	if _, err := database.ExecContext(ctx, `INSERT INTO scheme_components(scheme_id,component_type_id,pos_x,pos_y,rotation)
 SELECT $1,ct.id,0,0,0 FROM component_types ct CROSS JOIN generate_series(1,1000) WHERE ct.code='busbar'`, scheme); err != nil {
		t.Fatal(err)
	}
	read(1)
	if _, err := database.ExecContext(ctx, `UPDATE scheme_components SET pos_x=10 WHERE scheme_id=$1`, scheme); err != nil {
		t.Fatal(err)
	}
	read(1)
	if _, err := database.ExecContext(ctx, `INSERT INTO scheme_connections(scheme_id,from_component_id,to_component_id,from_port,to_port)
 SELECT $1,id,next,'right','left' FROM (SELECT id,lead(id) OVER(ORDER BY id) AS next FROM scheme_components WHERE scheme_id=$1) p WHERE next IS NOT NULL`, scheme); err != nil {
		t.Fatal(err)
	}
	read(2)
	if _, err := database.ExecContext(ctx, `DELETE FROM scheme_connections WHERE scheme_id=$1`, scheme); err != nil {
		t.Fatal(err)
	}
	read(3)
	if _, err := database.ExecContext(ctx, `DELETE FROM scheme_components WHERE scheme_id=$1 AND id IN(SELECT id FROM scheme_components WHERE scheme_id=$1 ORDER BY id LIMIT 500)`, scheme); err != nil {
		t.Fatal(err)
	}
	read(4)
	tx, err := database.BeginTx(ctx, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback()
	if _, err := tx.ExecContext(ctx, `INSERT INTO scheme_components(scheme_id,component_type_id,pos_x,pos_y,rotation) SELECT $1,id,0,0,0 FROM component_types WHERE code='busbar'`, scheme); err != nil {
		t.Fatal(err)
	}
	var revision int64
	if err := tx.QueryRowContext(ctx, `SELECT topology_revision FROM circuit_schemes WHERE id=$1`, scheme).Scan(&revision); err != nil || revision != 5 {
		t.Fatal("uncommitted topology increment missing")
	}
	if err := tx.Rollback(); err != nil {
		t.Fatal(err)
	}
	read(4)
}
