package main

import (
	"database/sql"
	"encoding/json"
	"errors"
	"io"
	"mime"
	"net/http"
	"strconv"
	"strings"
)

func expectedTopologyRevision(w http.ResponseWriter, r *http.Request) (int64, bool) {
	tags := r.Header.Values("If-Match")
	if len(tags) == 0 {
		componentWriteError(w, 428, "topology_revision_required", "Загрузите актуальную топологию схемы")
		return 0, false
	}
	if len(tags) != 1 || len(tags[0]) < 3 {
		componentWriteError(w, 400, "invalid_topology_revision", "Ожидается одна ревизия топологии")
		return 0, false
	}
	tag := tags[0]
	revision, err := strconv.ParseInt(tag[1:len(tag)-1], 10, 64)
	if err != nil || revision < 0 || `"`+strconv.FormatInt(revision, 10)+`"` != tag {
		componentWriteError(w, 400, "invalid_topology_revision", "Некорректная ревизия топологии")
		return 0, false
	}
	return revision, true
}

func projectConnectionError(w http.ResponseWriter, err error) bool {
	if err == nil {
		return false
	}
	var failure *connectionWriteFailure
	switch {
	case errors.Is(err, sql.ErrNoRows):
		sendError(w, "Соединение или схема недоступны", 404)
	case errors.Is(err, errTopologyConflict):
		componentWriteError(w, 412, "topology_revision_conflict", "Топология изменена другим клиентом. Перечитайте схему")
	case errors.Is(err, errConnectionCommandConflict):
		sendError(w, "Ключ команды уже использован с другими данными", 409)
	case errors.As(err, &failure):
		sendError(w, failure.message, failure.status)
	default:
		sendError(w, "Не удалось сохранить соединение; изменения отменены", 500)
	}
	return true
}

func (handler projectsHTTP) connections(w http.ResponseWriter, r *http.Request) bool {
	parts := strings.Split(strings.TrimPrefix(r.URL.Path, "/api/projects/"), "/")
	if len(parts) < 4 || parts[1] != "schemes" || (parts[3] != "connections" && parts[3] != "connection-commands") {
		return false
	}
	creating := parts[3] == "connection-commands"
	if (creating && len(parts) != 4) || (!creating && len(parts) != 5) {
		sendError(w, "Not found", 404)
		return true
	}
	project, err := positiveProjectID(parts[0])
	if err != nil {
		sendError(w, "Not found", 404)
		return true
	}
	scheme, err := intProjectID(parts[2])
	if err != nil {
		sendError(w, "Not found", 404)
		return true
	}
	token, err := handler.auth.token(r)
	if err != nil {
		sendError(w, "Session unavailable", 401)
		return true
	}
	method := http.MethodDelete
	if creating {
		method = http.MethodPost
	}
	if !requireMethod(w, r, method) {
		return true
	}
	expected, ok := expectedTopologyRevision(w, r)
	if !ok {
		return true
	}
	store := projectStore{database: handler.auth.database}
	if !creating {
		id, err := intProjectID(parts[4])
		if err != nil {
			sendError(w, "Not found", 404)
			return true
		}
		revision, err := store.DeleteConnection(r.Context(), token, project, scheme, id, expected)
		if projectConnectionError(w, err) {
			return true
		}
		decimal := strconv.FormatInt(revision, 10)
		w.Header().Set("ETag", `"`+decimal+`"`)
		writeJSON(w, map[string]any{"success": true, "topologyRevision": decimal})
		return true
	}
	key, err := connectionCommandKey(r)
	if err != nil || key == "" {
		sendError(w, "Требуется один UUID Idempotency-Key", 400)
		return true
	}
	contentType, _, err := mime.ParseMediaType(r.Header.Get("Content-Type"))
	if err != nil || contentType != "application/json" {
		sendError(w, "JSON content type required", 415)
		return true
	}
	var input struct {
		From     string `json:"from"`
		To       string `json:"to"`
		FromPort string `json:"fromPort"`
		ToPort   string `json:"toPort"`
	}
	decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, 64<<10))
	decoder.DisallowUnknownFields()
	err = decoder.Decode(&input)
	if err == nil {
		if trailing := decoder.Decode(&struct{}{}); trailing != io.EOF {
			if trailing == nil {
				err = errProjectName
			} else {
				err = trailing
			}
		}
	}
	if err != nil {
		var large *http.MaxBytesError
		if errors.As(err, &large) {
			sendError(w, "Request exceeds size limit", 413)
		} else {
			sendError(w, "Invalid connection request", 400)
		}
		return true
	}
	from, err := intProjectID(input.From)
	if err != nil {
		sendError(w, "Invalid endpoint", 400)
		return true
	}
	to, err := intProjectID(input.To)
	if err != nil {
		sendError(w, "Invalid endpoint", 400)
		return true
	}
	input.FromPort = strings.ToLower(input.FromPort)
	input.ToPort = strings.ToLower(input.ToPort)
	if len(input.FromPort) == 0 || len(input.FromPort) > 50 || len(input.ToPort) == 0 || len(input.ToPort) > 50 {
		sendError(w, "Invalid port", 400)
		return true
	}
	if from == to && input.FromPort == input.ToPort {
		sendError(w, "Нельзя соединить порт с самим собой", 422)
		return true
	}
	ack, err := store.CreateConnection(r.Context(), token, project, connectionRequest{SchemeID: scheme, From: from, To: to, FromPort: input.FromPort, ToPort: input.ToPort}, key, expected)
	if projectConnectionError(w, err) {
		return true
	}
	w.Header().Set("ETag", `"`+strconv.FormatInt(ack.Revision, 10)+`"`)
	if ack.Replayed {
		w.Header().Set("Idempotency-Replayed", "true")
	} else {
		w.WriteHeader(201)
	}
	writeJSON(w, map[string]any{"id": strconv.Itoa(ack.ID), "commandId": key, "success": true, "deleted": ack.Deleted, "topologyRevision": strconv.FormatInt(ack.Revision, 10)})
	return true
}
