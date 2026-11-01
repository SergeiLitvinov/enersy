package main

import (
	"database/sql"
	"errors"
	"net/http"
)

// HTTP is only an adapter; private reads use the same application operation as
// future automation clients. Anonymous reads retain their numeric-ID wire format.
func serveSchemeSnapshot(w http.ResponseWriter, r *http.Request, database *sql.DB, id int, project int64, token string) {
	if project > 0 {
		expected, ok := expectedApplicationIdentity(w, r)
		if !ok {
			return
		}
		result, err := (applicationService{database: database}).ReadScheme(r.Context(), token, readSchemeCommand{ProjectID: project, SchemeID: id, ExpectedIdentity: expected})
		if snapshotHTTPError(w, err) {
			return
		}
		writeJSON(w, result)
		return
	}
	result, err := readSchemeSnapshot(r.Context(), database, id, 0, "", nil)
	if snapshotHTTPError(w, err) {
		return
	}
	writeJSON(w, result)
}

func snapshotHTTPError(w http.ResponseWriter, err error) bool {
	if err == nil {
		return false
	}
	if errors.Is(err, errApplicationSessionChanged) {
		componentWriteError(w, 409, "command_session_changed", "Сессия изменилась. Повторно откройте рабочий контекст")
		return true
	}
	if errors.Is(err, sql.ErrNoRows) || errors.Is(err, errProjectUnavailable) {
		sendError(w, "Scheme not found", http.StatusNotFound)
	} else {
		sendError(w, "Could not read scheme snapshot", http.StatusInternalServerError)
	}
	return true
}
