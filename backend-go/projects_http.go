package main

import (
	"encoding/json"
	"errors"
	"io"
	"mime"
	"net/http"
	"strconv"
)

type projectsHTTP struct{ auth *authHTTP }

func (handler projectsHTTP) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if !handler.auth.prepare(w, r) {
		return
	}
	if r.URL.Path != "/api/projects" {
		sendError(w, "Not found", 404)
		return
	}
	if r.Method != http.MethodGet && r.Method != http.MethodPost {
		w.Header().Set("Allow", "GET, POST")
		sendError(w, "Method not allowed", 405)
		return
	}
	token, err := handler.auth.token(r)
	if err != nil {
		sendError(w, "Session unavailable", 401)
		return
	}
	store := projectStore{database: handler.auth.database}
	if r.Method == http.MethodGet {
		limit := 50
		if value := r.URL.Query().Get("limit"); value != "" {
			limit, err = strconv.Atoi(value)
			if err != nil || limit < 1 || limit > 100 {
				sendError(w, "Invalid project page limit", 400)
				return
			}
		}
		var after int64
		if value := r.URL.Query().Get("afterId"); value != "" {
			after, err = strconv.ParseInt(value, 10, 64)
			if err != nil || after < 0 {
				sendError(w, "Invalid project cursor", 400)
				return
			}
		}
		page, err := store.List(r.Context(), token, after, limit)
		if errors.Is(err, errSessionUnavailable) {
			sendError(w, "Session unavailable", 401)
			return
		}
		if err != nil {
			sendError(w, "Project service unavailable", 503)
			return
		}
		json.NewEncoder(w).Encode(page)
		return
	}
	contentType, _, err := mime.ParseMediaType(r.Header.Get("Content-Type"))
	if err != nil || contentType != "application/json" {
		sendError(w, "JSON content type required", 415)
		return
	}
	var input struct {
		Name string `json:"name"`
	}
	decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, 16<<10))
	decoder.DisallowUnknownFields()
	err = decoder.Decode(&input)
	if err == nil {
		trailing := decoder.Decode(&struct{}{})
		if trailing != io.EOF {
			if trailing == nil {
				err = errProjectName
			} else {
				err = trailing
			}
		}
	}
	if err != nil {
		var limit *http.MaxBytesError
		if errors.As(err, &limit) {
			sendError(w, "Request exceeds size limit", 413)
		} else {
			sendError(w, "Invalid project request", 400)
		}
		return
	}
	id, err := store.Create(r.Context(), token, input.Name)
	if errors.Is(err, errProjectName) {
		sendError(w, "Invalid project name", 400)
		return
	}
	if errors.Is(err, errProjectUnavailable) {
		sendError(w, "Session unavailable", 401)
		return
	}
	if err != nil {
		sendError(w, "Project service unavailable", 503)
		return
	}
	w.WriteHeader(http.StatusCreated)
	json.NewEncoder(w).Encode(struct {
		ID string `json:"id"`
	}{strconv.FormatInt(id, 10)})
}
