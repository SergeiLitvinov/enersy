package main

import (
	"database/sql"
	"encoding/json"
	"errors"
	"io"
	"mime"
	"net/http"
	"net/url"
	"strconv"
	"time"
)

type authHTTP struct {
	database   *sql.DB
	origin     string
	secure     bool
	enabled    bool
	loginSlots chan struct{}
}

func newAuthHTTP(database *sql.DB, origin string, secure bool) *authHTTP {
	parsed, err := url.Parse(origin)
	enabled := err == nil && (parsed.Scheme == "http" || parsed.Scheme == "https") && parsed.Host != "" && parsed.Hostname() != "*" && parsed.Path == "" && parsed.RawQuery == "" && !parsed.ForceQuery && parsed.Fragment == "" && parsed.User == nil && parsed.Opaque == "" && parsed.String() == origin
	return &authHTTP{database: database, origin: origin, secure: secure, enabled: enabled, loginSlots: make(chan struct{}, 2)}
}
func (handler *authHTTP) cookieName() string {
	if handler.secure {
		return "__Host-enersy_session"
	}
	return "enersy_session"
}
func (handler *authHTTP) cookie(w http.ResponseWriter, token string, expiry time.Time, clear bool) {
	value := &http.Cookie{Name: handler.cookieName(), Value: token, Path: "/", Secure: handler.secure, HttpOnly: true, SameSite: http.SameSiteStrictMode, Expires: expiry}
	if clear {
		value.MaxAge = -1
		value.Expires = time.Unix(1, 0)
	} else {
		value.MaxAge = int(time.Until(expiry).Seconds())
	}
	http.SetCookie(w, value)
}
func (handler *authHTTP) token(r *http.Request) (string, error) {
	var token string
	count := 0
	for _, cookie := range r.Cookies() {
		if cookie.Name == handler.cookieName() {
			token = cookie.Value
			count++
		}
	}
	if count != 1 {
		return "", errSessionUnavailable
	}
	if _, err := sessionTokenHash(token); err != nil {
		return "", err
	}
	return token, nil
}
func authIdentityJSON(w http.ResponseWriter, identity sessionIdentity) {
	// BIGINT identifiers are strings at the browser boundary.
	json.NewEncoder(w).Encode(struct {
		AccountID string    `json:"accountId"`
		SessionID string    `json:"sessionId"`
		ExpiresAt time.Time `json:"expiresAt"`
	}{strconv.FormatInt(identity.AccountID, 10), strconv.FormatInt(identity.SessionID, 10), identity.ExpiresAt})
}

// Shared session transport policy for authenticated application routes.
func (handler *authHTTP) prepare(w http.ResponseWriter, r *http.Request) bool {
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Content-Type", "application/json")
	w.Header().Add("Vary", "Origin")
	if !handler.enabled || handler.database == nil {
		sendError(w, "Authentication service unavailable", 503)
		return false
	}
	origin := r.Header.Get("Origin")
	if len(r.Header.Values("Origin")) > 1 {
		sendError(w, "Origin not allowed", 403)
		return false
	}
	if origin != "" && origin != handler.origin {
		sendError(w, "Origin not allowed", 403)
		return false
	}
	if origin == handler.origin {
		w.Header().Set("Access-Control-Allow-Origin", handler.origin)
		w.Header().Set("Access-Control-Allow-Credentials", "true")
	}
	if r.Method == http.MethodOptions {
		if origin != handler.origin {
			sendError(w, "Origin required", 403)
			return false
		}
		w.Header().Set("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
		w.Header().Set("Access-Control-Allow-Headers", "Content-Type")
		w.WriteHeader(204)
		return false
	}
	if r.Method != http.MethodGet && r.Method != http.MethodHead && origin != handler.origin {
		sendError(w, "Origin required", 403)
		return false
	}
	return true
}

func (handler *authHTTP) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if !handler.prepare(w, r) {
		return
	}
	switch r.URL.Path {
	case "/api/auth/login":
		if requireMethod(w, r, http.MethodPost) {
			handler.login(w, r)
		}
	case "/api/auth/session":
		if !requireMethod(w, r, http.MethodGet) {
			return
		}
		token, err := handler.token(r)
		if err != nil {
			sendError(w, "Session unavailable", 401)
			return
		}
		identity, err := (sessionStore{database: handler.database}).Authenticate(r.Context(), token)
		if errors.Is(err, errSessionUnavailable) {
			sendError(w, "Session unavailable", 401)
			return
		}
		if err != nil {
			sendError(w, "Authentication service unavailable", 503)
			return
		}
		authIdentityJSON(w, identity)
	case "/api/auth/logout", "/api/auth/logout-all":
		if !requireMethod(w, r, http.MethodPost) {
			return
		}
		handler.logout(w, r, r.URL.Path == "/api/auth/logout-all")
	default:
		sendError(w, "Not found", 404)
	}
}

func (handler *authHTTP) login(w http.ResponseWriter, r *http.Request) {
	contentType, _, err := mime.ParseMediaType(r.Header.Get("Content-Type"))
	if err != nil || contentType != "application/json" {
		sendError(w, "JSON content type required", 415)
		return
	}
	var input struct {
		Login    string `json:"login"`
		Password string `json:"password"`
	}
	decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, 16<<10))
	decoder.DisallowUnknownFields()
	err = decoder.Decode(&input)
	if err == nil {
		if trailing := decoder.Decode(&struct{}{}); trailing != io.EOF {
			if trailing == nil {
				err = errCredentialInput
			} else {
				err = trailing
			}
		}
	}
	if err != nil {
		var limit *http.MaxBytesError
		if errors.As(err, &limit) {
			sendError(w, "Request exceeds size limit", 413)
		} else {
			sendError(w, "Invalid login request", 400)
		}
		return
	}
	if _, valid := normalizeLogin(input.Login); !valid || !validPasswordInput(input.Password) {
		sendError(w, "Invalid login request", 400)
		return
	}
	// Slow body upload must not reserve a password-hashing slot.
	select {
	case handler.loginSlots <- struct{}{}:
		defer func() { <-handler.loginSlots }()
	default:
		w.Header().Set("Retry-After", "1")
		sendError(w, "Login capacity exceeded", 429)
		return
	}
	account, err := (credentialStore{database: handler.database}).Authenticate(r.Context(), input.Login, input.Password)
	if errors.Is(err, errCredentials) {
		sendError(w, "Invalid login or password", 401)
		return
	}
	if err != nil {
		sendError(w, "Authentication service unavailable", 503)
		return
	}
	issued, err := (sessionStore{database: handler.database}).Issue(r.Context(), account, 24*time.Hour)
	if errors.Is(err, errSessionUnavailable) {
		sendError(w, "Invalid login or password", 401)
		return
	}
	if err != nil {
		sendError(w, "Authentication service unavailable", 503)
		return
	}
	handler.cookie(w, issued.Token, issued.Identity.ExpiresAt, false)
	authIdentityJSON(w, issued.Identity)
}

func (handler *authHTTP) logout(w http.ResponseWriter, r *http.Request, all bool) {
	token, err := handler.token(r)
	if err != nil {
		handler.cookie(w, "", time.Time{}, true)
		sendError(w, "Session unavailable", 401)
		return
	}
	store := sessionStore{database: handler.database}
	if all {
		err = store.RevokeAll(r.Context(), token)
	} else {
		var identity sessionIdentity
		identity, err = store.Authenticate(r.Context(), token)
		if err == nil {
			err = store.Revoke(r.Context(), token, identity.SessionID)
		}
	}
	if errors.Is(err, errSessionUnavailable) {
		handler.cookie(w, "", time.Time{}, true)
		sendError(w, "Session unavailable", 401)
		return
	}
	if err != nil {
		sendError(w, "Authentication service unavailable", 503)
		return
	}
	handler.cookie(w, "", time.Time{}, true)
	w.WriteHeader(204)
}
