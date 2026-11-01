package main

import (
	"errors"
	"net/http"
	"strings"
)

// Expected identities constrain trusted transport credentials; they are never
// model arguments, scope selectors or a substitute for authentication.
func expectedApplicationIdentity(w http.ResponseWriter, r *http.Request) (*applicationIdentity, bool) {
	accounts, sessions := r.Header.Values("X-Enersy-Account-Id"), r.Header.Values("X-Enersy-Session-Id")
	if len(accounts) == 0 && len(sessions) == 0 {
		return nil, true
	}
	if len(accounts) != 1 || len(sessions) != 1 {
		componentWriteError(w, 400, "invalid_expected_identity", "Укажите одну ожидаемую сессию и аккаунт")
		return nil, false
	}
	account, e1 := positiveProjectID(accounts[0])
	session, e2 := positiveProjectID(sessions[0])
	if e1 != nil || e2 != nil {
		componentWriteError(w, 400, "invalid_expected_identity", "Некорректный рабочий контекст")
		return nil, false
	}
	return &applicationIdentity{account, session}, true
}

func (handler projectsHTTP) operations(w http.ResponseWriter, r *http.Request) bool {
	parts := strings.Split(strings.TrimPrefix(r.URL.Path, "/api/projects/"), "/")
	if len(parts) < 4 || parts[1] != "schemes" || parts[3] != "operations" {
		return false
	}
	if len(parts) != 4 || len(r.URL.Query()) != 0 {
		sendError(w, "Not found", 404)
		return true
	}
	project, e1 := positiveProjectID(parts[0])
	scheme, e2 := intProjectID(parts[2])
	if e1 != nil || e2 != nil {
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
	expected, ok := expectedApplicationIdentity(w, r)
	if !ok {
		return true
	}
	catalog, err := (applicationService{database: handler.auth.database}).ReadOperations(r.Context(), token, readSchemeCommand{ProjectID: project, SchemeID: scheme, ExpectedIdentity: expected})
	if errors.Is(err, errApplicationSessionChanged) {
		componentWriteError(w, 409, "command_session_changed", "Сессия изменилась. Повторно откройте рабочий контекст")
		return true
	}
	if memberHTTPError(w, err) {
		return true
	}
	writeJSON(w, catalog)
	return true
}
