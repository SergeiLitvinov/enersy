package main

import (
	"database/sql"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strings"
)

type connectionRequest struct {
	SchemeID int    `json:"schemeId"`
	From     int    `json:"from"`
	To       int    `json:"to"`
	FromPort string `json:"fromPort"`
	ToPort   string `json:"toPort"`
}

// Validate persisted ownership and named ports; screen coordinates are irrelevant.
func handleConnections(w http.ResponseWriter, r *http.Request) {
	if !requireMethod(w, r, http.MethodPost) {
		return
	}
	if db == nil {
		sendError(w, "Database not available", http.StatusServiceUnavailable)
		return
	}
	commandKey, err := connectionCommandKey(r)
	if err != nil {
		sendError(w, "Idempotency-Key должен содержать один UUID команды", 400)
		return
	}
	r.Body = http.MaxBytesReader(w, r.Body, 64<<10)
	decoder := json.NewDecoder(r.Body)
	var req connectionRequest
	if err := decoder.Decode(&req); err != nil {
		var limit *http.MaxBytesError
		if errors.As(err, &limit) {
			sendError(w, "Запрос соединения слишком большой", 413)
		} else {
			sendError(w, "Некорректный запрос соединения", 400)
		}
		return
	}
	if err := decoder.Decode(new(any)); err != io.EOF {
		sendError(w, "Ожидается один JSON-объект", 400)
		return
	}
	req.FromPort = strings.ToLower(req.FromPort)
	req.ToPort = strings.ToLower(req.ToPort)
	if req.SchemeID <= 0 || req.From <= 0 || req.To <= 0 || req.FromPort == "" || req.ToPort == "" {
		sendError(w, "Укажите схему, оба объекта и имена портов", 400)
		return
	}
	if req.From == req.To && req.FromPort == req.ToPort {
		sendError(w, "Нельзя соединить порт с самим собой", 422)
		return
	}
	tx, err := db.BeginTx(r.Context(), nil)
	if err != nil {
		sendError(w, "Не удалось проверить соединение", 500)
		return
	}
	defer tx.Rollback()
	if commandKey != "" {
		id, replayed, err := replayConnectionCommand(r.Context(), tx, req, commandKey)
		if errors.Is(err, errConnectionCommandConflict) {
			sendError(w, "Ключ команды уже использован с другими данными", 409)
			return
		}
		if err != nil {
			sendError(w, "Не удалось проверить подтверждение команды", 500)
			return
		}
		if replayed {
			w.Header().Set("Idempotency-Replayed", "true")
			connectionAcknowledgement(w, id, commandKey)
			return
		}
	}
	endpoints := []struct {
		id   int
		port string
	}{{req.From, req.FromPort}, {req.To, req.ToPort}}
	domains := make([]string, 0, 2)
	for _, endpoint := range endpoints {
		var schemeID, typeID int
		err = tx.QueryRowContext(r.Context(), "SELECT scheme_id,component_type_id FROM scheme_components WHERE id=$1 FOR KEY SHARE", endpoint.id).Scan(&schemeID, &typeID)
		if errors.Is(err, sql.ErrNoRows) {
			sendError(w, "Объект соединения не найден", 404)
			return
		}
		if err != nil {
			sendError(w, "Не удалось проверить объект соединения", 500)
			return
		}
		if schemeID != req.SchemeID {
			sendError(w, "Оба объекта должны принадлежать выбранной схеме", 422)
			return
		}
		var domain string
		err = tx.QueryRowContext(r.Context(), "SELECT domain FROM component_type_ports WHERE component_type_id=$1 AND port_name=$2", typeID, endpoint.port).Scan(&domain)
		if errors.Is(err, sql.ErrNoRows) {
			sendError(w, "Неизвестный порт объекта: "+endpoint.port, 422)
			return
		}
		if err != nil {
			sendError(w, "Не удалось проверить порт", 500)
			return
		}
		domains = append(domains, domain)
	}
	if domains[0] != domains[1] {
		sendError(w, "Порты относятся к несовместимым физическим доменам", 422)
		return
	}
	var id int
	err = tx.QueryRowContext(r.Context(), `INSERT INTO scheme_connections(scheme_id,from_component_id,to_component_id,from_port,to_port)
		VALUES($1,$2,$3,$4,$5) RETURNING id`, req.SchemeID, req.From, req.To, req.FromPort, req.ToPort).Scan(&id)
	if err != nil {
		sendError(w, "Соединение не сохранено: проверьте актуальность схемы", 409)
		return
	}
	if commandKey != "" {
		_, err = tx.ExecContext(r.Context(), `INSERT INTO connection_commands(scheme_id,command_id,payload_hash,connection_id) VALUES($1,$2,$3,$4)`, req.SchemeID, commandKey, connectionPayloadHash(req), id)
		if err != nil {
			sendError(w, "Не удалось сохранить подтверждение команды", 500)
			return
		}
	}
	if err = tx.Commit(); err != nil {
		sendError(w, "Не удалось подтвердить сохранение соединения", 500)
		return
	}
	connectionAcknowledgement(w, id, commandKey)
}
