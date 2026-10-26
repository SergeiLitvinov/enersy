package main

import (
	"context"
	"errors"
)

var errTopologyConflict = errors.New("topology revision conflict")

type projectConnectionAck struct {
	ID       int
	Revision int64
	Replayed bool
	Deleted  bool
}

func (store projectStore) CreateConnection(ctx context.Context, token string, project int64, req connectionRequest, key string, expected int64) (projectConnectionAck, error) {
	ack := projectConnectionAck{}
	if key == "" || !commandUUID.MatchString(key) || expected < 0 {
		return ack, connectionError("Некорректная команда соединения", 400)
	}
	tx, err := store.database.BeginTx(ctx, nil)
	if err != nil {
		return ack, err
	}
	defer rollbackTx(tx)
	if err := lockProjectSchemeWrite(ctx, tx, token, project, req.SchemeID); err != nil {
		return ack, err
	}
	if err := tx.QueryRowContext(ctx, `SELECT topology_revision FROM circuit_schemes WHERE id=$1`, req.SchemeID).Scan(&ack.Revision); err != nil {
		return ack, err
	}
	id, replayed, err := replayConnectionCommand(ctx, tx, req, key)
	if err != nil {
		return ack, err
	}
	if replayed {
		ack.ID = id
		ack.Replayed = true
		var exists bool
		if err := tx.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM scheme_connections WHERE id=$1 AND scheme_id=$2)`, id, req.SchemeID).Scan(&exists); err != nil {
			return ack, err
		}
		ack.Deleted = !exists
	} else {
		if ack.Revision != expected {
			return ack, errTopologyConflict
		}
		id, err := insertConnectionInTx(ctx, tx, req, key, false)
		if err != nil {
			return ack, err
		}
		ack.ID = id
		if err := tx.QueryRowContext(ctx, `SELECT topology_revision FROM circuit_schemes WHERE id=$1`, req.SchemeID).Scan(&ack.Revision); err != nil {
			return ack, err
		}
	}
	if err := tx.Commit(); err != nil {
		return projectConnectionAck{}, err
	}
	return ack, nil
}

func (store projectStore) DeleteConnection(ctx context.Context, token string, project int64, scheme, id int, expected int64) (int64, error) {
	tx, err := store.database.BeginTx(ctx, nil)
	if err != nil {
		return 0, err
	}
	defer rollbackTx(tx)
	if err := lockProjectSchemeWrite(ctx, tx, token, project, scheme); err != nil {
		return 0, err
	}
	var actual int
	if err := tx.QueryRowContext(ctx, `SELECT c.id FROM scheme_connections c
 JOIN scheme_components f ON f.id=c.from_component_id AND f.scheme_id=c.scheme_id
 JOIN scheme_components t ON t.id=c.to_component_id AND t.scheme_id=c.scheme_id
 WHERE c.id=$1 AND c.scheme_id=$2 FOR UPDATE OF c`, id, scheme).Scan(&actual); err != nil {
		return 0, err
	}
	var revision int64
	if err := tx.QueryRowContext(ctx, `SELECT topology_revision FROM circuit_schemes WHERE id=$1`, scheme).Scan(&revision); err != nil {
		return 0, err
	}
	if revision != expected {
		return 0, errTopologyConflict
	}
	if _, err := tx.ExecContext(ctx, `DELETE FROM scheme_connections WHERE id=$1`, id); err != nil {
		return 0, err
	}
	if err := tx.QueryRowContext(ctx, `SELECT topology_revision FROM circuit_schemes WHERE id=$1`, scheme).Scan(&revision); err != nil {
		return 0, err
	}
	if err := tx.Commit(); err != nil {
		return 0, err
	}
	return revision, nil
}
