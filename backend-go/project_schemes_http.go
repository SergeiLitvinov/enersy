package main

import (
	"encoding/json"
	"errors"
	"io"
	"mime"
	"net/http"
	"strconv"
	"strings"
)

func (handler projectsHTTP) schemes(w http.ResponseWriter, r *http.Request) bool {
	parts := strings.Split(strings.TrimPrefix(r.URL.Path, "/api/projects/"), "/")
	if len(parts) < 2 || parts[1] != "schemes" {
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
	if len(parts) == 3 {
		if r.Method != http.MethodGet {
			w.Header().Set("Allow", "GET")
			sendError(w, "Method not allowed", 405)
			return true
		}
		id, err := intProjectID(parts[2])
		if err != nil {
			sendError(w, "Not found", 404)
			return true
		}
		serveSchemeSnapshot(w, r, handler.auth.database, id, project, token)
		return true
	}
	store := projectStore{database: handler.auth.database}
	if r.Method == http.MethodGet {
		limit := 50
		var after int64
		if v := r.URL.Query().Get("limit"); v != "" {
			limit, err = strconv.Atoi(v)
			if err != nil || limit < 1 || limit > 100 {
				sendError(w, "Invalid page limit", 400)
				return true
			}
		}
		if v := r.URL.Query().Get("afterId"); v != "" {
			after, err = strconv.ParseInt(v, 10, 64)
			if err != nil || after < 0 {
				sendError(w, "Invalid cursor", 400)
				return true
			}
		}
		page, err := store.Schemes(r.Context(), token, project, after, limit)
		if memberHTTPError(w, err) {
			return true
		}
		writeJSON(w, page)
		return true
	}
	if r.Method != http.MethodPost {
		w.Header().Set("Allow", "GET, POST")
		sendError(w, "Method not allowed", 405)
		return true
	}
	contentType, _, err := mime.ParseMediaType(r.Header.Get("Content-Type"))
	if err != nil || contentType != "application/json" {
		sendError(w, "JSON content type required", 415)
		return true
	}
	var input struct {
		Name        string `json:"name"`
		Description string `json:"description"`
	}
	decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, 32<<10))
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
			sendError(w, "Invalid scheme request", 400)
		}
		return true
	}
	id, err := store.CreateScheme(r.Context(), token, project, input.Name, input.Description)
	if errors.Is(err, errProjectName) {
		sendError(w, "Invalid scheme name or description", 400)
		return true
	}
	if memberHTTPError(w, err) {
		return true
	}
	w.WriteHeader(201)
	writeJSON(w, struct {
		ID string `json:"id"`
	}{strconv.FormatInt(id, 10)})
	return true
}
