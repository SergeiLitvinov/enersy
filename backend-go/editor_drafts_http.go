package main

import (
	"database/sql"
	"errors"
	"io"
	"mime"
	"net/http"
	"strconv"
	"strings"
)

func editorDraftHTTPError(w http.ResponseWriter, err error) bool {
	if err == nil {
		return false
	}
	switch {
	case errors.Is(err, sql.ErrNoRows):
		sendError(w, "Draft or scheme unavailable", 404)
	case errors.Is(err, errEditorDraftConflict):
		componentWriteError(w, 412, "editor_draft_revision_conflict", "Черновик изменён другим контекстом. Перечитайте журнал")
	case errors.Is(err, errEditorDraftQuota):
		componentWriteError(w, 409, "editor_draft_quota", "Достигнут предел хранения черновиков аккаунта")
	case errors.Is(err, errEditorDraftPayload):
		componentWriteError(w, 400, "invalid_editor_draft", "Некорректный формат журнала редактора")
	default:
		sendError(w, "Draft service unavailable", 503)
	}
	return true
}
func expectedEditorDraftRevision(w http.ResponseWriter, r *http.Request) (int64, bool) {
	tags := r.Header.Values("If-Match")
	if len(tags) == 0 {
		componentWriteError(w, 428, "editor_draft_revision_required", "Укажите ревизию черновика")
		return 0, false
	}
	if len(tags) != 1 || len(tags[0]) < 3 {
		componentWriteError(w, 400, "invalid_editor_draft_revision", "Ожидается одна ревизия черновика")
		return 0, false
	}
	tag := tags[0]
	value := tag[1 : len(tag)-1]
	if !draftRevision(value, true) || tag != `"`+value+`"` {
		componentWriteError(w, 400, "invalid_editor_draft_revision", "Некорректная ревизия черновика")
		return 0, false
	}
	revision, _ := strconv.ParseInt(value, 10, 64)
	return revision, true
}
func (handler projectsHTTP) drafts(w http.ResponseWriter, r *http.Request) bool {
	parts := strings.Split(strings.TrimPrefix(r.URL.Path, "/api/projects/"), "/")
	if len(parts) < 4 || parts[1] != "schemes" || parts[3] != "drafts" {
		return false
	}
	if len(parts) > 5 {
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
	workspace := ""
	if len(parts) == 5 {
		workspace = parts[4]
		if !editorWorkspacePattern.MatchString(workspace) {
			sendError(w, "Not found", 404)
			return true
		}
	}
	allowed := "GET"
	if workspace != "" {
		allowed = "GET, PUT, DELETE"
	}
	if r.Method != http.MethodGet && !(workspace != "" && (r.Method == http.MethodPut || r.Method == http.MethodDelete)) {
		w.Header().Set("Allow", allowed)
		sendError(w, "Method not allowed", 405)
		return true
	}
	token, err := handler.auth.token(r)
	if err != nil {
		sendError(w, "Session unavailable", 401)
		return true
	}
	store := projectStore{database: handler.auth.database}
	if r.Method == http.MethodGet {
		items, err := store.ReadEditorDrafts(r.Context(), token, project, scheme, workspace)
		if editorDraftHTTPError(w, err) {
			return true
		}
		if workspace == "" {
			writeJSON(w, map[string]any{"items": items})
		} else {
			w.Header().Set("ETag", `"`+items[0].Revision+`"`)
			writeJSON(w, items[0])
		}
		return true
	}
	expected, ok := expectedEditorDraftRevision(w, r)
	if !ok {
		return true
	}
	var payload []byte
	if r.Method == http.MethodPut {
		contentType, _, err := mime.ParseMediaType(r.Header.Get("Content-Type"))
		if err != nil || contentType != "application/json" {
			sendError(w, "JSON content type required", 415)
			return true
		}
		payload, err = io.ReadAll(http.MaxBytesReader(w, r.Body, editorDraftMaxBytes))
		if err != nil {
			var tooLarge *http.MaxBytesError
			if errors.As(err, &tooLarge) {
				sendError(w, "Request exceeds size limit", 413)
			} else {
				sendError(w, "Invalid draft request", 400)
			}
			return true
		}
	}
	view, err := store.WriteEditorDraft(r.Context(), token, project, scheme, workspace, expected, payload, r.Method == http.MethodDelete)
	if editorDraftHTTPError(w, err) {
		return true
	}
	w.Header().Set("ETag", `"`+view.Revision+`"`)
	writeJSON(w, view)
	return true
}
