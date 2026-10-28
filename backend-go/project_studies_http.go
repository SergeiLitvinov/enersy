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

func expectedStudyRevision(w http.ResponseWriter, r *http.Request) (int64, bool) {
	tags := r.Header.Values("If-Match")
	if len(tags) == 0 {
		componentWriteError(w, 428, "study_revision_required", "Загрузите актуальную версию исследования")
		return 0, false
	}
	if len(tags) != 1 || len(tags[0]) < 3 {
		sendError(w, "One strong Study ETag required", 400)
		return 0, false
	}
	tag := tags[0]
	value, err := strconv.ParseInt(tag[1:len(tag)-1], 10, 64)
	if err != nil || value <= 0 || `"`+strconv.FormatInt(value, 10)+`"` != tag {
		sendError(w, "Invalid Study revision", 400)
		return 0, false
	}
	return value, true
}

func studyHTTPError(w http.ResponseWriter, err error) bool {
	if err == nil {
		return false
	}
	switch {
	case errors.Is(err, sql.ErrNoRows), errors.Is(err, errProjectUnavailable):
		sendError(w, "Study or source scheme unavailable", 404)
	case errors.Is(err, errStudyInput):
		sendError(w, "Invalid Study document or source reference", 400)
	case errors.Is(err, errStudyCommand):
		componentWriteError(w, 409, "study_command_conflict", "Ключ команды уже использован с другими данными")
	case errors.Is(err, errStudyConflict):
		componentWriteError(w, 412, "study_revision_conflict", "Исследование изменено другой сессией. Локальные настройки не сохранены; сравните версии")
	case errors.Is(err, errStudyTopology), errors.Is(err, errStudySource):
		componentWriteError(w, 412, "study_source_conflict", "Исходная схема изменилась. Перечитайте её перед сохранением исследования")
	case errors.Is(err, errStudyQuota), errors.Is(err, errCalculationProvenanceLimit):
		sendError(w, "Study history exceeds project size/count limit", 413)
	case errors.Is(err, errArchiveCorrupt):
		sendError(w, "Stored Study snapshot is invalid", 500)
	default:
		sendError(w, "Study service unavailable", 503)
	}
	return true
}

func (handler projectsHTTP) studies(w http.ResponseWriter, r *http.Request) bool {
	parts := strings.Split(strings.TrimPrefix(r.URL.Path, "/api/projects/"), "/")
	creating := len(parts) == 4 && parts[1] == "schemes" && parts[3] == "studies"
	if !creating && (len(parts) < 2 || parts[1] != "studies") {
		return false
	}
	if !creating && (len(parts) > 6 || len(parts) == 4 && parts[3] != "versions" || len(parts) >= 5 && parts[3] != "versions") {
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
	var study int64
	var scheme int
	if creating {
		scheme, err = intProjectID(parts[2])
	} else if len(parts) >= 3 {
		study, err = positiveProjectID(parts[2])
	}
	if err != nil {
		sendError(w, "Not found", 404)
		return true
	}
	versionRoute := !creating && len(parts) == 4
	if r.Method == http.MethodGet && !creating {
		if len(parts) == 2 || versionRoute {
			cursorKey := "afterId"
			if versionRoute {
				cursorKey = "afterRevision"
			}
			limit := 20
			var after int64
			for key, values := range r.URL.Query() {
				if (key != cursorKey && key != "limit") || len(values) != 1 {
					sendError(w, "Invalid Study page options", 400)
					return true
				}
			}
			if raw, found := r.URL.Query()[cursorKey]; found {
				after, err = strconv.ParseInt(raw[0], 10, 64)
				if err != nil || after < 0 || strconv.FormatInt(after, 10) != raw[0] {
					sendError(w, "Invalid Study cursor", 400)
					return true
				}
			}
			if raw, found := r.URL.Query()["limit"]; found {
				limit, err = strconv.Atoi(raw[0])
				if err != nil || limit < 1 || limit > 100 {
					sendError(w, "Invalid Study limit", 400)
					return true
				}
			}
			items, err := store.ListStudies(r.Context(), token, project, study, after, limit)
			if studyHTTPError(w, err) {
				return true
			}
			response := map[string]any{"items": items}
			if len(items) == limit {
				next := items[len(items)-1].ID
				if versionRoute {
					next = items[len(items)-1].Revision
				}
				response[cursorKeyReplace(cursorKey)] = next
			}
			writeJSON(w, response)
			return true
		}
		var revision int64
		if len(parts) >= 5 {
			revision, err = positiveProjectID(parts[4])
			if err != nil {
				sendError(w, "Not found", 404)
				return true
			}
		}
		kind := ""
		if len(parts) == 6 {
			kind = parts[5]
			if kind != "input" && kind != "provenance" {
				sendError(w, "Not found", 404)
				return true
			}
		}
		if len(r.URL.Query()) != 0 {
			sendError(w, "Study version does not accept query options", 400)
			return true
		}
		version, body, err := store.ReadStudy(r.Context(), token, project, study, revision, kind)
		if studyHTTPError(w, err) {
			return true
		}
		w.Header().Set("X-Enersy-Study-Id", version.ID)
		w.Header().Set("X-Enersy-Study-Revision", version.Revision)
		tag := version.Revision
		if kind != "" {
			tag = version.InputSHA256
			if kind == "provenance" {
				tag = version.ProvenanceSHA256
			}
		}
		w.Header().Set("ETag", `"`+tag+`"`)
		if kind != "" {
			writeJSONBody(w, http.StatusOK, body)
		} else {
			writeJSON(w, version)
		}
		return true
	}
	if r.Method != http.MethodPost || (!creating && !versionRoute) {
		allow := "GET"
		if creating {
			allow = "POST"
		} else if versionRoute {
			allow = "GET, POST"
		}
		w.Header().Set("Allow", allow)
		sendError(w, "Method not allowed", 405)
		return true
	}
	if len(r.URL.Query()) != 0 {
		sendError(w, "Study write does not accept query options", 400)
		return true
	}
	// A restored browser command must not run under a cookie changed in another tab.
	// These IDs constrain the authenticated token; they never grant access.
	accounts, sessions := r.Header.Values("X-Enersy-Account-Id"), r.Header.Values("X-Enersy-Session-Id")
	if len(accounts) > 0 || len(sessions) > 0 {
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
		identity, err := (sessionStore{database: handler.auth.database}).Authenticate(r.Context(), token)
		if errors.Is(err, errSessionUnavailable) {
			sendError(w, "Session unavailable", 401)
			return true
		}
		if err != nil {
			sendError(w, "Session service unavailable", 503)
			return true
		}
		if identity.AccountID != account || identity.SessionID != session {
			componentWriteError(w, 409, "study_session_changed", "Сессия изменилась. Проверьте рабочий контекст перед сохранением")
			return true
		}
	}
	var expected int64
	if !creating {
		var ok bool
		expected, ok = expectedStudyRevision(w, r)
		if !ok {
			return true
		}
	}
	command, err := connectionCommandKey(r)
	if err != nil || command == "" {
		sendError(w, "One UUID Idempotency-Key required", 400)
		return true
	}
	content, _, err := mime.ParseMediaType(r.Header.Get("Content-Type"))
	if err != nil || content != "application/json" {
		sendError(w, "JSON content type required", 415)
		return true
	}
	var input struct {
		TopologyRevision string                 `json:"topologyRevision"`
		Document         studyDocument          `json:"document"`
		SourceRevisions  *[]studySourceRevision `json:"sourceRevisions"`
		SourceDigest     *string                `json:"sourceDigest"`
	}
	decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, 128<<10))
	decoder.DisallowUnknownFields()
	err = decoder.Decode(&input)
	if err == nil {
		if trailing := decoder.Decode(&struct{}{}); trailing != io.EOF {
			err = trailing
			if err == nil {
				err = errStudyInput
			}
		}
	}
	if err != nil {
		var large *http.MaxBytesError
		if errors.As(err, &large) {
			sendError(w, "Study request exceeds size limit", 413)
		} else {
			sendError(w, "Invalid Study request", 400)
		}
		return true
	}
	topology, err := strconv.ParseInt(input.TopologyRevision, 10, 64)
	if err != nil || topology < 0 || strconv.FormatInt(topology, 10) != input.TopologyRevision {
		sendError(w, "Explicit source topology revision required", 400)
		return true
	}
	version, err := store.saveStudySource(r.Context(), token, project, scheme, study, expected, topology, command, input.Document, input.SourceRevisions, input.SourceDigest)
	if studyHTTPError(w, err) {
		return true
	}
	w.Header().Set("ETag", `"`+version.Revision+`"`)
	w.WriteHeader(http.StatusCreated)
	writeJSON(w, version)
	return true
}

func cursorKeyReplace(key string) string {
	if key == "afterRevision" {
		return "nextAfterRevision"
	}
	return "nextAfterId"
}
