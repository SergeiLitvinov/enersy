package main

import (
	"database/sql"
	"errors"
	"io"
	"net/http"
	"strconv"
	"strings"
)

func (handler projectsHTTP) studyRuns(w http.ResponseWriter, r *http.Request) bool {
	parts := strings.Split(strings.TrimPrefix(r.URL.Path, "/api/projects/"), "/")
	collection := len(parts) == 6 && parts[1] == "studies" && parts[3] == "versions" && parts[5] == "runs"
	creating := collection && r.Method == http.MethodPost
	if !collection && (len(parts) < 2 || parts[1] != "runs") {
		return false
	}
	if !collection && len(parts) != 3 {
		sendError(w, "Not found", 404)
		return true
	}
	project, err := positiveProjectID(parts[0])
	if err != nil {
		sendError(w, "Not found", 404)
		return true
	}
	if collection && r.Method == http.MethodGet {
		handler.listStudyRuns(w, r, project, parts[2], parts[4])
		return true
	}
	if collection && r.Method != http.MethodPost {
		w.Header().Set("Allow", "GET, POST")
		sendError(w, "Method not allowed", 405)
		return true
	}
	method := http.MethodGet
	if creating {
		method = http.MethodPost
	}
	if !requireMethod(w, r, method) {
		return true
	}
	if len(r.URL.Query()) != 0 {
		sendError(w, "Run does not accept calculation overrides", 400)
		return true
	}
	token, err := handler.auth.token(r)
	if err != nil {
		sendError(w, "Session unavailable", 401)
		return true
	}
	store := projectStore{database: handler.auth.database}
	var run studyRun
	if creating {
		study, e1 := positiveProjectID(parts[2])
		revision, e2 := positiveProjectID(parts[4])
		if e1 != nil || e2 != nil {
			sendError(w, "Explicit Study version required", 400)
			return true
		}
		// Every new Run command must be bound to the UI's expected identity.
		accounts, sessions := r.Header.Values("X-Enersy-Account-Id"), r.Header.Values("X-Enersy-Session-Id")
		if len(accounts) != 1 || len(sessions) != 1 {
			sendError(w, "One expected account and session required", 400)
			return true
		}
		account, e1 := positiveProjectID(accounts[0])
		session, e2 := positiveProjectID(sessions[0])
		if e1 != nil || e2 != nil {
			sendError(w, "Invalid expected identity", 400)
			return true
		}
		identity, authErr := (sessionStore{database: handler.auth.database}).Authenticate(r.Context(), token)
		if authErr != nil {
			if errors.Is(authErr, errSessionUnavailable) {
				sendError(w, "Session unavailable", 401)
			} else {
				sendError(w, "Session service unavailable", 503)
			}
			return true
		}
		if identity.AccountID != account || identity.SessionID != session {
			componentWriteError(w, 409, "run_session_changed", "Сессия изменилась. Проверьте рабочий контекст перед запуском")
			return true
		}
		command, keyErr := connectionCommandKey(r)
		if keyErr != nil || command == "" {
			sendError(w, "One UUID Idempotency-Key required", 400)
			return true
		}
		body, bodyErr := io.ReadAll(http.MaxBytesReader(w, r.Body, 1))
		if bodyErr != nil || len(body) != 0 {
			sendError(w, "Run input comes only from the saved Study; request body must be empty", 400)
			return true
		}
		run, err = store.EnqueueStudyRun(r.Context(), token, project, study, revision, command)
	} else {
		id, idErr := positiveProjectID(parts[2])
		if idErr != nil {
			sendError(w, "Not found", 404)
			return true
		}
		run, err = store.ReadStudyRun(r.Context(), token, project, id)
	}
	if errors.Is(err, sql.ErrNoRows) {
		sendError(w, "Run or Study unavailable", 404)
		return true
	}
	if errors.Is(err, errStudyRunCommand) {
		componentWriteError(w, 409, "run_command_conflict", "Команда уже относится к другой версии Study")
		return true
	}
	if errors.Is(err, errStudyRunQuota) {
		componentWriteError(w, 409, "run_project_quota", "Достигнут лимит запусков проекта")
		return true
	}
	if err != nil {
		sendError(w, "Run service unavailable", 503)
		return true
	}
	w.Header().Set("Cache-Control", "no-store")
	if creating {
		w.Header().Set("Location", "/api/projects/"+parts[0]+"/runs/"+run.ID)
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusAccepted)
	}
	writeJSON(w, map[string]any{"formatVersion": 1, "runId": run.ID, "run": run})
	return true
}

func (handler projectsHTTP) listStudyRuns(w http.ResponseWriter, r *http.Request, project int64, studyText, revisionText string) {
	study, e1 := positiveProjectID(studyText)
	revision, e2 := positiveProjectID(revisionText)
	if e1 != nil || e2 != nil {
		sendError(w, "Explicit Study version required", 400)
		return
	}
	before, limit := int64(0), 25
	for key, values := range r.URL.Query() {
		if len(values) != 1 {
			sendError(w, "Invalid Run page", 400)
			return
		}
		switch key {
		case "beforeId":
			var err error
			before, err = positiveProjectID(values[0])
			if err != nil {
				sendError(w, "Invalid Run cursor", 400)
				return
			}
		case "limit":
			n, err := strconv.Atoi(values[0])
			if err != nil || n < 1 || n > 50 || strconv.Itoa(n) != values[0] {
				sendError(w, "Invalid Run page size", 400)
				return
			}
			limit = n
		default:
			sendError(w, "Invalid Run page", 400)
			return
		}
	}
	token, err := handler.auth.token(r)
	if err != nil {
		sendError(w, "Session unavailable", 401)
		return
	}
	page, err := (projectStore{database: handler.auth.database}).ListStudyRuns(r.Context(), token, project, study, revision, before, limit)
	if errors.Is(err, sql.ErrNoRows) {
		sendError(w, "Study unavailable", 404)
		return
	}
	if err != nil {
		sendError(w, "Run history unavailable", 503)
		return
	}
	writeJSON(w, page)
}
