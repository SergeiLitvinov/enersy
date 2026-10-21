package main

import (
	"database/sql"
	"encoding/json"
	"errors"
	"net/http"
	"strconv"
	"strings"
)

func archiveHTTPError(w http.ResponseWriter, err error) bool {
	if err == nil {
		return false
	}
	switch {
	case errors.Is(err, sql.ErrNoRows):
		sendError(w, "Calculation archive or project unavailable", 404)
	case errors.Is(err, errArchiveResult):
		sendError(w, "Worker response cannot be archived as a successful calculation", 502)
	case errors.Is(err, errArchiveQuota):
		componentWriteError(w, 409, "calculation_archive_quota", "Достигнут лимит архива проекта: 100 расчётов или 64 МиБ")
	case errors.Is(err, errArchiveCorrupt):
		sendError(w, "Calculation archive failed integrity verification", 500)
	default:
		sendError(w, "Calculation archive service unavailable", 503)
	}
	return true
}

func (handler projectsHTTP) archives(w http.ResponseWriter, r *http.Request) bool {
	parts := strings.Split(strings.TrimPrefix(r.URL.Path, "/api/projects/"), "/")
	if len(parts) < 2 || parts[1] != "calculation-archives" {
		return false
	}
	if len(parts) > 4 || (len(parts) == 4 && parts[3] != "input" && parts[3] != "result" && parts[3] != "provenance") {
		sendError(w, "Not found", 404)
		return true
	}
	project, err := positiveProjectID(parts[0])
	if err != nil {
		sendError(w, "Not found", 404)
		return true
	}
	if !requireMethod(w, r, http.MethodGet) {
		return true
	}
	token, err := handler.auth.token(r)
	if err != nil {
		sendError(w, "Session unavailable", 401)
		return true
	}
	store := projectStore{database: handler.auth.database}
	if len(parts) == 2 {
		limit := 20
		var before int64
		for key, values := range r.URL.Query() {
			if (key != "limit" && key != "beforeId") || len(values) != 1 {
				sendError(w, "Invalid archive page", 400)
				return true
			}
		}
		if value := r.URL.Query().Get("limit"); value != "" {
			limit, err = strconv.Atoi(value)
			if err != nil || limit < 1 || limit > 100 {
				sendError(w, "Invalid archive limit", 400)
				return true
			}
		}
		if value := r.URL.Query().Get("beforeId"); value != "" {
			before, err = positiveProjectID(value)
			if err != nil {
				sendError(w, "Invalid archive cursor", 400)
				return true
			}
		}
		page, err := store.CalculationArchives(r.Context(), token, project, before, limit)
		if !archiveHTTPError(w, err) {
			json.NewEncoder(w).Encode(page)
		}
		return true
	}
	id, err := positiveProjectID(parts[2])
	if err != nil {
		sendError(w, "Not found", 404)
		return true
	}
	if len(r.URL.Query()) != 0 {
		sendError(w, "Invalid archive options", 400)
		return true
	}
	value, input, result, err := store.CalculationArchive(r.Context(), token, project, id)
	if archiveHTTPError(w, err) {
		return true
	}
	if len(parts) == 4 {
		body, digest := input, value.InputSHA256
		if parts[3] == "result" {
			body, digest = result, value.ResultSHA256
		}
		if parts[3] == "provenance" {
			if value.ProvenanceSHA256 == "" {
				sendError(w, "Historical provenance unavailable", 404)
				return true
			}
			body, digest = value.provenance, value.ProvenanceSHA256
		}
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("ETag", `"`+digest+`"`)
		w.Header().Set("X-Enersy-Archive-Id", value.ID)
		w.Write(body)
		return true
	}
	json.NewEncoder(w).Encode(value)
	return true
}
