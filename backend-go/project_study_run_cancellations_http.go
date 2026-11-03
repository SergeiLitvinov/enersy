package main

import (
	"database/sql"
	"errors"
	"io"
	"net/http"
)

// Both admission and cancellation must reject a stale UI cookie identity.
func (handler projectsHTTP) expectedRunIdentity(w http.ResponseWriter, r *http.Request, token string) bool {
	accounts, sessions := r.Header.Values("X-Enersy-Account-Id"), r.Header.Values("X-Enersy-Session-Id")
	if len(accounts) != 1 || len(sessions) != 1 {
		sendError(w, "One expected account and session required", 400)
		return false
	}
	account, e1 := positiveProjectID(accounts[0])
	session, e2 := positiveProjectID(sessions[0])
	if e1 != nil || e2 != nil {
		sendError(w, "Invalid expected identity", 400)
		return false
	}
	identity, err := (sessionStore{database: handler.auth.database}).Authenticate(r.Context(), token)
	if err != nil {
		if errors.Is(err, errSessionUnavailable) {
			sendError(w, "Session unavailable", 401)
		} else {
			sendError(w, "Session service unavailable", 503)
		}
		return false
	}
	if identity.AccountID != account || identity.SessionID != session {
		componentWriteError(w, 409, "run_session_changed", "Сессия изменилась. Проверьте рабочий контекст перед командой Run")
		return false
	}
	return true
}

func (handler projectsHTTP) cancelStudyRun(w http.ResponseWriter, r *http.Request, projectText, runText string) {
	if !requireMethod(w, r, http.MethodPost) {
		return
	}
	project, e1 := positiveProjectID(projectText)
	id, e2 := positiveProjectID(runText)
	if e1 != nil || e2 != nil {
		sendError(w, "Run unavailable", 404)
		return
	}
	if len(r.URL.Query()) != 0 {
		sendError(w, "Cancellation does not accept query parameters", 400)
		return
	}
	token, err := handler.auth.token(r)
	if err != nil {
		sendError(w, "Session unavailable", 401)
		return
	}
	if !handler.expectedRunIdentity(w, r, token) {
		return
	}
	command, keyErr := connectionCommandKey(r)
	if keyErr != nil || command == "" {
		sendError(w, "One UUID Idempotency-Key required", 400)
		return
	}
	body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, 1))
	if err != nil || len(body) != 0 {
		sendError(w, "Cancellation request body must be empty", 400)
		return
	}
	run, err := (projectStore{database: handler.auth.database}).CancelQueuedStudyRun(r.Context(), token, project, id, command)
	switch {
	case errors.Is(err, sql.ErrNoRows):
		sendError(w, "Run unavailable", 404)
		return
	case errors.Is(err, errStudyRunStarted):
		componentWriteError(w, 409, "run_already_claimed", "Исполнение уже начиналось. Отмена ещё не выданного запуска недоступна; обновите состояние")
		return
	case errors.Is(err, errStudyRunCommand):
		componentWriteError(w, 409, "run_cancel_command_conflict", "Команда отмены уже относится к другому запуску")
		return
	case errors.Is(err, errStudyRunCancellationQuota):
		componentWriteError(w, 409, "run_cancel_quota", "Достигнут лимит команд отмены проекта")
		return
	case err != nil:
		sendError(w, "Run cancellation unavailable", 503)
		return
	}
	w.Header().Set("Cache-Control", "no-store")
	writeJSON(w, map[string]any{"formatVersion": 1, "commandId": command, "runId": run.ID, "run": run})
}
