package main

import (
	"encoding/json"
	"errors"
	"io"
	"mime"
	"net/http"
	"strconv"
	"strings"
)

func positiveProjectID(value string) (int64, error) {
	id, err := strconv.ParseInt(value, 10, 64)
	if err != nil || id <= 0 || strconv.FormatInt(id, 10) != value {
		return 0, errProjectUnavailable
	}
	return id, nil
}

// Called only after the shared cookie/Origin transport policy.
func (handler projectsHTTP) members(w http.ResponseWriter, r *http.Request) {
	parts := strings.Split(strings.TrimPrefix(r.URL.Path, "/api/projects/"), "/")
	if len(parts) < 2 || len(parts) > 3 || parts[1] != "members" {
		sendError(w, "Not found", 404)
		return
	}
	project, err := positiveProjectID(parts[0])
	if err != nil {
		sendError(w, "Not found", 404)
		return
	}
	token, err := handler.auth.token(r)
	if err != nil {
		sendError(w, "Session unavailable", 401)
		return
	}
	store := projectStore{database: handler.auth.database}
	if len(parts) == 2 {
		if r.Method != http.MethodGet {
			w.Header().Set("Allow", "GET")
			sendError(w, "Method not allowed", 405)
			return
		}
		limit := 50
		var after int64
		if v := r.URL.Query().Get("limit"); v != "" {
			limit, err = strconv.Atoi(v)
			if err != nil || limit < 1 || limit > 100 {
				sendError(w, "Invalid page limit", 400)
				return
			}
		}
		if v := r.URL.Query().Get("afterId"); v != "" {
			after, err = strconv.ParseInt(v, 10, 64)
			if err != nil || after < 0 {
				sendError(w, "Invalid cursor", 400)
				return
			}
		}
		page, err := store.Members(r.Context(), token, project, after, limit)
		if memberHTTPError(w, err) {
			return
		}
		json.NewEncoder(w).Encode(page)
		return
	}
	if r.Method != http.MethodPut && r.Method != http.MethodDelete {
		w.Header().Set("Allow", "PUT, DELETE")
		sendError(w, "Method not allowed", 405)
		return
	}
	target, err := positiveProjectID(parts[2])
	if err != nil {
		sendError(w, "Not found", 404)
		return
	}
	match := r.Header.Get("If-Match")
	if match == "" {
		sendError(w, "Membership revision required", 428)
		return
	}
	if len(r.Header.Values("If-Match")) != 1 || len(match) < 3 || match[0] != '"' || match[len(match)-1] != '"' {
		sendError(w, "Invalid membership revision", 400)
		return
	}
	expected, err := strconv.ParseInt(match[1:len(match)-1], 10, 64)
	if err != nil || expected < 0 || `"`+strconv.FormatInt(expected, 10)+`"` != match {
		sendError(w, "Invalid membership revision", 400)
		return
	}
	var input struct {
		Role string `json:"role"`
	}
	if r.Method == http.MethodPut {
		contentType, _, err := mime.ParseMediaType(r.Header.Get("Content-Type"))
		if err != nil || contentType != "application/json" {
			sendError(w, "JSON content type required", 415)
			return
		}
		decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1024))
		decoder.DisallowUnknownFields()
		err = decoder.Decode(&input)
		if err == nil {
			if trailing := decoder.Decode(&struct{}{}); trailing != io.EOF {
				if trailing == nil {
					err = errMembershipRole
				} else {
					err = trailing
				}
			}
		}
		if err != nil {
			var large *http.MaxBytesError
			if errors.As(err, &large) {
				sendError(w, "Request exceeds size limit", 413)
			} else {
				sendError(w, "Invalid membership request", 400)
			}
			return
		}
	}
	revision, err := store.ChangeMember(r.Context(), token, project, target, expected, input.Role, r.Method == http.MethodDelete)
	if memberHTTPError(w, err) {
		return
	}
	json.NewEncoder(w).Encode(struct {
		Revision string `json:"revision"`
	}{strconv.FormatInt(revision, 10)})
}

func memberHTTPError(w http.ResponseWriter, err error) bool {
	if err == nil {
		return false
	}
	switch {
	case errors.Is(err, errProjectUnavailable), errors.Is(err, errMembershipTarget):
		sendError(w, "Project member unavailable", 404)
	case errors.Is(err, errMembershipConflict):
		sendError(w, "Membership revision conflict", 409)
	case errors.Is(err, errMembershipRole):
		sendError(w, "Invalid membership role", 400)
	default:
		sendError(w, "Project service unavailable", 503)
	}
	return true
}
