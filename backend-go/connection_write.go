package main

import (
	"context"
	"database/sql"
	"errors"
)

type connectionWriteFailure struct {
	message string
	status  int
}

func (e *connectionWriteFailure) Error() string { return e.message }
func connectionError(message string, status int) error {
	return &connectionWriteFailure{message, status}
}

// Shared persisted-port validation and command journaling for legacy/project routes.
func insertConnectionInTx(ctx context.Context, tx *sql.Tx, req connectionRequest, commandKey string, legacy bool) (int, error) {
	var err error
	endpoints := []struct {
		id   int
		port string
	}{{req.From, req.FromPort}, {req.To, req.ToPort}}
	domains := make([]string, 0, 2)
	for _, endpoint := range endpoints {
		var schemeID, typeID int
		query := `SELECT scheme_id,component_type_id FROM scheme_components WHERE id=$1 AND scheme_id=$2 FOR KEY SHARE`
		args := []any{endpoint.id, req.SchemeID}
		if legacy {
			query = `SELECT sc.scheme_id,sc.component_type_id FROM scheme_components sc
 JOIN circuit_schemes s ON s.id=sc.scheme_id WHERE sc.id=$1 AND s.project_id IS NULL FOR KEY SHARE OF sc`
			args = []any{endpoint.id}
		}
		err = tx.QueryRowContext(ctx, query, args...).Scan(&schemeID, &typeID)
		if errors.Is(err, sql.ErrNoRows) {
			return 0, connectionError("Объект соединения не найден", 404)

		}
		if err != nil {
			return 0, connectionError("Не удалось проверить объект соединения", 500)

		}
		if schemeID != req.SchemeID {
			return 0, connectionError("Оба объекта должны принадлежать выбранной схеме", 422)

		}
		var domain string
		err = tx.QueryRowContext(ctx, "SELECT domain FROM component_type_ports WHERE component_type_id=$1 AND port_name=$2", typeID, endpoint.port).Scan(&domain)
		if errors.Is(err, sql.ErrNoRows) {
			return 0, connectionError("Неизвестный порт объекта: "+endpoint.port, 422)

		}
		if err != nil {
			return 0, connectionError("Не удалось проверить порт", 500)

		}
		domains = append(domains, domain)
	}
	if domains[0] != domains[1] {
		return 0, connectionError("Порты относятся к несовместимым физическим доменам", 422)

	}
	var id int
	err = tx.QueryRowContext(ctx, `INSERT INTO scheme_connections(scheme_id,from_component_id,to_component_id,from_port,to_port)
		VALUES($1,$2,$3,$4,$5) RETURNING id`, req.SchemeID, req.From, req.To, req.FromPort, req.ToPort).Scan(&id)
	if err != nil {
		return 0, connectionError("Соединение не сохранено: проверьте актуальность схемы", 409)

	}
	if commandKey != "" {
		_, err = tx.ExecContext(ctx, `INSERT INTO connection_commands(scheme_id,command_id,payload_hash,connection_id) VALUES($1,$2,$3,$4)`, req.SchemeID, commandKey, connectionPayloadHash(req), id)
		if err != nil {
			return 0, connectionError("Не удалось сохранить подтверждение команды", 500)

		}
	}
	return id, nil
}
