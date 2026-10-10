package main

import (
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strconv"
	"strings"
)

func (handler projectsHTTP) calculate(w http.ResponseWriter, r *http.Request) bool {
	parts := strings.Split(strings.TrimPrefix(r.URL.Path, "/api/projects/"), "/")
	if len(parts) < 4 || parts[1] != "schemes" || parts[3] != "calculate" {
		return false
	}
	if len(parts) != 4 {
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
	if !requireMethod(w, r, http.MethodPost) {
		return true
	}
	expected, ok := expectedTopologyRevision(w, r)
	if !ok {
		return true
	}
	query := r.URL.Query()
	for key, values := range query {
		if (key != "modelGroup" && key != "method") || len(values) != 1 {
			sendError(w, "Invalid calculation options", 400)
			return true
		}
	}
	group, method := query.Get("modelGroup"), query.Get("method")
	if len(group) == 0 || len(group) > 64 || len(method) == 0 || len(method) > 64 {
		sendError(w, "Explicit modelGroup and method required", 400)
		return true
	}
	body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, 1))
	if err != nil || len(body) != 0 {
		sendError(w, "Calculation body must be empty; options belong in query", 400)
		return true
	}
	input, err := readCalculationInputScope(r.Context(), handler.auth.database, scheme, project, token)
	if errors.Is(err, sql.ErrNoRows) {
		sendError(w, "Scheme unavailable", 404)
		return true
	}
	if err != nil {
		sendError(w, "Could not read calculation snapshot", 500)
		return true
	}
	if input.TopologyRevision != expected {
		componentWriteError(w, 412, "topology_revision_conflict", "Топология изменена. Перечитайте схему перед расчётом")
		return true
	}
	payload, err := json.Marshal(map[string]any{"components": input.Components, "connections": input.Connections, "modelGroup": group, "method": method})
	if err != nil {
		sendError(w, "Could not serialize calculation snapshot", 500)
		return true
	}
	// No session/account secrets are sent to the worker. This digest identifies
	// the exact request bytes, not an immutable Study/Run or physical equivalence.
	digest := sha256.Sum256(payload)
	store := projectStore{database: handler.auth.database}
	allowed := func() bool {
		access, err := store.Access(r.Context(), token, schemeScope, int64(scheme), projectWrite)
		if errors.Is(err, errProjectUnavailable) || (err == nil && access.ProjectID != project) {
			sendError(w, "Scheme unavailable", 404)
			return false
		}
		if err != nil {
			sendError(w, "Project service unavailable", 503)
			return false
		}
		return true
	}
	if !allowed() {
		return true
	}
	proxyCompute(w, r, handler.workerURL, "/calculate", payload, func() bool {
		if !allowed() {
			return false
		}
		w.Header().Set("X-Enersy-Input-SHA256", hex.EncodeToString(digest[:]))
		w.Header().Set("X-Enersy-Topology-Revision", strconv.FormatInt(input.TopologyRevision, 10))
		w.Header().Set("X-Enersy-Project-Id", strconv.FormatInt(project, 10))
		w.Header().Set("X-Enersy-Scheme-Id", strconv.Itoa(scheme))
		return true
	})
	return true
}
