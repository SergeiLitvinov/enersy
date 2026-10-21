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

func (handler projectsHTTP) passports(w http.ResponseWriter, r *http.Request) bool {
	parts := strings.Split(strings.TrimPrefix(r.URL.Path, "/api/projects/"), "/")
	if len(parts) < 2 || parts[1] != "passports" {
		return false
	}
	if len(parts) > 3 {
		sendError(w, "Not found", 404)
		return true
	}
	project, err := positiveProjectID(parts[0])
	if err != nil {
		sendError(w, "Not found", 404)
		return true
	}
	token, err := handler.auth.token(r)
	if err != nil {
		sendError(w, "Session unavailable", 401)
		return true
	}
	store := projectStore{database: handler.auth.database}
	if r.Method == http.MethodGet {
		var after int64
		limit := 50
		var id *int64
		if len(parts) == 3 {
			value, e := positiveProjectID(parts[2])
			if e != nil {
				sendError(w, "Not found", 404)
				return true
			}
			id = &value
		}
		if value := r.URL.Query().Get("afterId"); value != "" {
			after, err = strconv.ParseInt(value, 10, 64)
			if err != nil || after < 0 {
				sendError(w, "Invalid cursor", 400)
				return true
			}
		}
		if value := r.URL.Query().Get("limit"); value != "" {
			limit, err = strconv.Atoi(value)
			if err != nil || limit < 1 || limit > 100 {
				sendError(w, "Invalid page limit", 400)
				return true
			}
		}
		if id != nil {
			after = 0
			limit = 1
		}
		items, err := store.ReadPassports(r.Context(), token, project, after, limit, id)
		if passportHTTPError(w, err) {
			return true
		}
		if id != nil {
			json.NewEncoder(w).Encode(items[0])
			return true
		}
		next := ""
		if len(items) == limit {
			next = items[len(items)-1].ID
		}
		json.NewEncoder(w).Encode(struct {
			Items       []passportVersion `json:"items"`
			NextAfterID string            `json:"nextAfterId,omitempty"`
		}{items, next})
		return true
	}
	if r.Method != http.MethodPost || len(parts) != 2 {
		w.Header().Set("Allow", "GET")
		if len(parts) == 2 {
			w.Header().Set("Allow", "GET, POST")
		}
		sendError(w, "Method not allowed", 405)
		return true
	}
	contentType, _, err := mime.ParseMediaType(r.Header.Get("Content-Type"))
	if err != nil || contentType != "application/json" {
		sendError(w, "JSON content type required", 415)
		return true
	}
	command, err := connectionCommandKey(r)
	if err != nil || command == "" {
		sendError(w, "One UUID Idempotency-Key required", 400)
		return true
	}
	var input struct {
		Document      passportDocument `json:"document"`
		PredecessorID *string          `json:"predecessorId"`
	}
	decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, 70<<10))
	decoder.DisallowUnknownFields()
	err = decoder.Decode(&input)
	if err == nil {
		if trailing := decoder.Decode(&struct{}{}); trailing != io.EOF {
			err = trailing
			if err == nil {
				err = errPassportInput
			}
		}
	}
	if err != nil {
		var large *http.MaxBytesError
		if errors.As(err, &large) {
			sendError(w, "Request exceeds size limit", 413)
		} else {
			sendError(w, "Invalid passport request", 400)
		}
		return true
	}
	var parent *int64
	if input.PredecessorID != nil {
		value, e := positiveProjectID(*input.PredecessorID)
		if e != nil {
			sendError(w, "Invalid predecessor ID", 400)
			return true
		}
		parent = &value
	}
	version, err := store.SavePassport(r.Context(), token, project, command, parent, input.Document)
	if passportHTTPError(w, err) {
		return true
	}
	w.WriteHeader(http.StatusCreated)
	json.NewEncoder(w).Encode(version)
	return true
}

func passportHTTPError(w http.ResponseWriter, err error) bool {
	if err == nil {
		return false
	}
	switch {
	case errors.Is(err, sql.ErrNoRows), errors.Is(err, errProjectUnavailable):
		sendError(w, "Project passport unavailable", 404)
	case errors.Is(err, errPassportInput):
		sendError(w, "Invalid passport fields, parameters or declared units", 400)
	case errors.Is(err, errPassportConflict):
		sendError(w, "Passport version or command conflict", 409)
	case errors.Is(err, errPassportQuota):
		sendError(w, "Project passport quota exceeded", 409)
	default:
		sendError(w, "Passport service unavailable", 503)
	}
	return true
}
