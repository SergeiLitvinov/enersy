package main

import (
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"net/http"
	"net/url"
	"strconv"
	"strings"
)

func (handler projectsHTTP) calculate(w http.ResponseWriter, r *http.Request) bool {
	parts := strings.Split(strings.TrimPrefix(r.URL.Path, "/api/projects/"), "/")
	if len(parts) < 4 || parts[1] != "schemes" || (parts[3] != "calculate" && parts[3] != "archive-calculation") {
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
		if (key != "modelGroup" && key != "method" && key != "computeBackend" && key != "maxTimeMs" && key != "unitContract") || len(values) != 1 {
			sendError(w, "Invalid calculation options", 400)
			return true
		}
	}
	group, method := query.Get("modelGroup"), query.Get("method")
	unitContract, unitErr := calculationUnitContractOption(query)
	if unitErr != nil {
		sendError(w, "Invalid input unit contract", 400)
		return true
	}
	backend, backendErr := calculationBackendOption(query)
	if backendErr != nil {
		sendError(w, "Invalid compute backend", 400)
		return true
	}
	budget, budgetErr := calculationExecutionOption(query)
	if budgetErr != nil {
		sendError(w, "Invalid calculation time budget", 400)
		return true
	}
	if len(group) == 0 || len(group) > 64 || len(method) == 0 || len(method) > 64 {
		sendError(w, "Explicit modelGroup and method required", 400)
		return true
	}
	limits, ok := readCalculationLimits(w, r)
	if !ok {
		return true
	}
	archive := parts[3] == "archive-calculation"
	input, err := readCalculationInputScope(r.Context(), handler.auth.database, scheme, project, token, archive)
	if errors.Is(err, errCalculationProvenanceLimit) {
		sendError(w, "Calculation provenance exceeds archive limit", 413)
		return true
	}
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
	if !limitTargetsBelongToInput(limits, input) {
		sendError(w, "Operating limit equipment is absent from this scheme", 400)
		return true
	}
	workerInput := map[string]any{"components": input.Components, "connections": input.Connections, "modelGroup": group, "method": method}
	if unitContract != nil {
		workerInput["unitContract"] = unitContract
	}
	if backend != "" {
		workerInput["computeBackend"] = backend
	}
	if budget != 0 {
		workerInput["executionOptions"] = map[string]int64{"max_time_ms": budget}
	}
	if limits != nil {
		workerInput["operatingLimits"] = limits
	}
	payload, err := json.Marshal(workerInput)
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
	if archive && len(payload) > computeBodyLimit {
		sendError(w, "Calculation snapshot exceeds archive limit", 413)
		return true
	}
	proxyComputeResult(w, r, handler.workerURL, "/calculate", payload, func(status int, result []byte) bool {
		if !allowed() {
			return false
		}
		if status >= 200 && status < 300 && !confirmsRequestedUnitContract(payload, result) {
			sendError(w, "Worker did not confirm requested input unit contract", 502)
			return false
		}
		if status >= 200 && status < 300 && !confirmsCalculationLimits(result, limits) {
			sendError(w, "Worker did not confirm requested operating limits", 502)
			return false
		}
		if archive && status >= 200 && status < 300 {
			id, err := store.SaveCalculationArchive(r.Context(), token, project, scheme, input, group, method, payload, result)
			if archiveHTTPError(w, err) {
				return false
			}
			w.Header().Set("X-Enersy-Archive-Id", strconv.FormatInt(id, 10))
		}
		w.Header().Set("X-Enersy-Input-SHA256", hex.EncodeToString(digest[:]))
		w.Header().Set("X-Enersy-Topology-Revision", strconv.FormatInt(input.TopologyRevision, 10))
		w.Header().Set("X-Enersy-Project-Id", strconv.FormatInt(project, 10))
		w.Header().Set("X-Enersy-Scheme-Id", strconv.Itoa(scheme))
		return true
	})
	return true
}

// Omission retains the worker's Julia default and existing snapshot bytes.
// Availability is checked by the selected worker, never by loading user code.
func calculationBackendOption(query url.Values) (string, error) {
	values, present := query["computeBackend"]
	if !present {
		return "", nil
	}
	if len(values) != 1 || (values[0] != "julia" && values[0] != "julia-rust-jacobian") {
		return "", errors.New("unsupported compute backend")
	}
	return values[0], nil
}

// A request can shorten the worker's default budget, never extend it beyond
// the 20-second cooperative ceiling (the proxy waits at most 25 seconds).
func calculationExecutionOption(query url.Values) (int64, error) {
	values, present := query["maxTimeMs"]
	if !present {
		return 0, nil
	}
	if len(values) != 1 {
		return 0, errors.New("ambiguous calculation budget")
	}
	budget, err := strconv.ParseInt(values[0], 10, 64)
	if err != nil || budget < 1 || budget > 20000 || strconv.FormatInt(budget, 10) != values[0] {
		return 0, errors.New("calculation budget must be an integer in 1..20000 milliseconds")
	}
	return budget, nil
}
