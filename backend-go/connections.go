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
	defer rollbackTx(tx)
	var legacyScheme int
	err = tx.QueryRowContext(r.Context(), `SELECT id FROM circuit_schemes WHERE id=$1 AND project_id IS NULL FOR UPDATE`, req.SchemeID).Scan(&legacyScheme)
	if errors.Is(err, sql.ErrNoRows) {
		sendError(w, "Схема не найдена", 404)
		return
	}
	if err != nil {
		sendError(w, "Не удалось проверить схему", 500)
		return
	}
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
	id, err := insertConnectionInTx(r.Context(), tx, req, commandKey, true)
	if err != nil {
		var failure *connectionWriteFailure
		if errors.As(err, &failure) {
			sendError(w, failure.message, failure.status)
		} else {
			sendError(w, "Не удалось сохранить соединение", 500)
		}
		return
	}
	if err = tx.Commit(); err != nil {
		sendError(w, "Не удалось подтвердить сохранение соединения", 500)
		return
	}
	connectionAcknowledgement(w, id, commandKey)
}
