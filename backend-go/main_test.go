package main

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"
)

func TestGetEnv(t *testing.T) {
	tests := []struct {
		name       string
		key        string
		val        string
		defaultVal string
		want       string
	}{
		{"uses default when unset", "UNSET_VAR_1", "", "default1", "default1"},
		{"uses env when set", "TEST_GETENV", "env_value", "default2", "env_value"},
		{"empty default when unset", "UNSET_VAR_2", "", "", ""},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if tt.val != "" {
				os.Setenv(tt.key, tt.val)
				defer os.Unsetenv(tt.key)
			}
			got := getEnv(tt.key, tt.defaultVal)
			if got != tt.want {
				t.Errorf("getEnv(%q, %q) = %q; want %q", tt.key, tt.defaultVal, got, tt.want)
			}
		})
	}
}

func TestSendError(t *testing.T) {
	rec := httptest.NewRecorder()
	sendError(rec, "test error", http.StatusBadRequest)

	if rec.Code != http.StatusBadRequest {
		t.Errorf("status = %d; want %d", rec.Code, http.StatusBadRequest)
	}

	ct := rec.Header().Get("Content-Type")
	if ct != "application/json" {
		t.Errorf("Content-Type = %q; want %q", ct, "application/json")
	}

	var resp Response
	if err := json.NewDecoder(rec.Body).Decode(&resp); err != nil {
		t.Fatalf("failed to decode response: %v", err)
	}
	if resp.Error != "test error" {
		t.Errorf("error = %q; want %q", resp.Error, "test error")
	}
}

func TestEnableCORS(t *testing.T) {
	handler := enableCORS(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	})

	t.Run("sets CORS headers on GET", func(t *testing.T) {
		rec := httptest.NewRecorder()
		req := httptest.NewRequest("GET", "/", nil)
		handler(rec, req)

		if rec.Header().Get("Access-Control-Allow-Origin") != "*" {
			t.Errorf("CORS origin = %q; want %q", rec.Header().Get("Access-Control-Allow-Origin"), "*")
		}
		if rec.Header().Get("Access-Control-Allow-Methods") == "" {
			t.Error("Access-Control-Allow-Methods is empty")
		}
	})

	t.Run("returns 200 on OPTIONS", func(t *testing.T) {
		rec := httptest.NewRecorder()
		req := httptest.NewRequest("OPTIONS", "/", nil)
		handler(rec, req)

		if rec.Code != http.StatusOK {
			t.Errorf("OPTIONS status = %d; want %d", rec.Code, http.StatusOK)
		}
	})
}

func TestHandlersReturn503WhenDBIsNil(t *testing.T) {
	db = nil

	tests := []struct {
		name    string
		method  string
		path    string
		handler http.HandlerFunc
	}{
		{"GET /api/ees/component-types", "GET", "/api/ees/component-types", handleGetComponentTypes},
		{"GET /api/ees/component-params/generator", "GET", "/api/ees/component-params/generator", handleGetComponentParams},
		{"GET /api/ees/schemes", "GET", "/api/ees/schemes", handleSchemes},
		{"POST /api/ees/schemes", "POST", "/api/ees/schemes", handleSchemes},
		{"GET /api/ees/schemes/1", "GET", "/api/ees/schemes/1", handleSchemeByID},
		{"DELETE /api/ees/schemes/1", "DELETE", "/api/ees/schemes/1", handleSchemeByID},
		{"POST /api/ees/components", "POST", "/api/ees/components", handleComponents},
		{"PUT /api/ees/components/1", "PUT", "/api/ees/components/1", handleComponentByIDOrParams},
		{"DELETE /api/ees/components/1", "DELETE", "/api/ees/components/1", handleComponentByIDOrParams},
		{"POST /api/ees/components/1/params", "POST", "/api/ees/components/1/params", handleComponentByIDOrParams},
		{"POST /api/ees/connections", "POST", "/api/ees/connections", handleConnections},
		{"DELETE /api/ees/connections/1", "DELETE", "/api/ees/connections/1", handleConnectionByID},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			rec := httptest.NewRecorder()
			req := httptest.NewRequest(tt.method, tt.path, nil)

			tt.handler(rec, req)

			if rec.Code != http.StatusServiceUnavailable {
				t.Errorf("status = %d; want %d (503 Service Unavailable)", rec.Code, http.StatusServiceUnavailable)
			}

			var resp Response
			json.NewDecoder(rec.Body).Decode(&resp)
			if resp.Error == "" {
				t.Error("expected error message, got empty")
			}
		})
	}
}

func TestCalculateReturns503WhenDBIsNil(t *testing.T) {
	db = nil

	rec := httptest.NewRecorder()
	req := httptest.NewRequest("POST", "/api/ees/calculate/1", nil)
	handleCalculate(rec, req)

	if rec.Code != http.StatusServiceUnavailable {
		t.Errorf("status = %d; want %d", rec.Code, http.StatusServiceUnavailable)
	}
}

func TestJuliaSolveProxiesRequest(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/solve" || r.Method != "POST" {
			t.Errorf("unexpected request: %s %s", r.Method, r.URL.Path)
		}
		w.WriteHeader(http.StatusUnprocessableEntity)
		w.Write([]byte(`{"success":false,"error":{"code":"singular_matrix"}}`))
	}))
	defer server.Close()
	previous := juliaBaseURL
	juliaBaseURL = server.URL
	defer func() { juliaBaseURL = previous }()

	rec := httptest.NewRecorder()
	body := strings.NewReader(`{"A":[[2,3],[1,4]],"b":[5,7]}`)
	req := httptest.NewRequest("POST", "/julia/solve", body)
	handleJuliaSolve(rec, req)

	if rec.Code != http.StatusUnprocessableEntity || !strings.Contains(rec.Body.String(), "singular_matrix") {
		t.Errorf("structured worker error lost: %d %s", rec.Code, rec.Body.String())
	}
}

func TestComputeMethodsAndLimits(t *testing.T) {
	for _, handler := range []http.HandlerFunc{handleCalculate, handleJuliaSolve} {
		rec := httptest.NewRecorder()
		handler(rec, httptest.NewRequest("GET", "/", nil))
		if rec.Code != 405 || rec.Header().Get("Allow") != "POST" {
			t.Errorf("wrong method response: %d", rec.Code)
		}
	}
	rec := httptest.NewRecorder()
	handleJuliaSolve(rec, httptest.NewRequest("POST", "/julia/solve", strings.NewReader(strings.Repeat("x", computeBodyLimit+1))))
	if rec.Code != 413 {
		t.Errorf("oversized request status: %d", rec.Code)
	}
}

func TestCapabilitiesProxy(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/capabilities" {
			t.Errorf("wrong path: %s", r.URL.Path)
		}
		w.Write([]byte(`{"capabilities":[]}`))
	}))
	defer server.Close()
	previous := juliaBaseURL
	juliaBaseURL = server.URL
	defer func() { juliaBaseURL = previous }()
	rec := httptest.NewRecorder()
	handleCapabilities(rec, httptest.NewRequest("GET", "/api/ees/capabilities", nil))
	if rec.Code != 200 || rec.Body.String() != `{"capabilities":[]}` {
		t.Errorf("bad proxy response: %d %s", rec.Code, rec.Body)
	}
}

func TestComputeDeadlineCancelsUpstream(t *testing.T) {
	started := make(chan struct{})
	stopped := make(chan struct{})
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		close(started)
		<-r.Context().Done()
		close(stopped)
	}))
	defer server.Close()
	previous := juliaBaseURL
	juliaBaseURL = server.URL
	defer func() { juliaBaseURL = previous }()
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	rec := httptest.NewRecorder()
	req := httptest.NewRequest("GET", "/api/ees/capabilities", nil).WithContext(ctx)
	finished := make(chan struct{})
	go func() { handleCapabilities(rec, req); close(finished) }()
	select {
	case <-started:
	case <-ctx.Done():
		t.Fatal("worker never received request")
	}
	select {
	case <-finished:
	case <-time.After(2 * time.Second):
		t.Fatal("proxy did not respect deadline")
	}
	select {
	case <-stopped:
	case <-time.After(time.Second):
		t.Fatal("worker connection was not cancelled")
	}
	if rec.Code != http.StatusGatewayTimeout {
		t.Errorf("deadline status = %d", rec.Code)
	}
}

func TestResponseJSON(t *testing.T) {
	resp := Response{Result: "hello"}
	data, _ := json.Marshal(resp)
	if !strings.Contains(string(data), "hello") {
		t.Error("Response serialization failed")
	}

	errResp := Response{Error: "something went wrong"}
	data, _ = json.Marshal(errResp)
	if !strings.Contains(string(data), "something went wrong") {
		t.Error("Response error serialization failed")
	}
}

func TestHealthEndpoint(t *testing.T) {
	rec := httptest.NewRecorder()
	req := httptest.NewRequest("GET", "/health", nil)
	handleHealth(rec, req)

	if rec.Code != http.StatusOK {
		t.Errorf("status = %d; want %d", rec.Code, http.StatusOK)
	}

	var body map[string]string
	json.NewDecoder(rec.Body).Decode(&body)
	if body["status"] != "ok" {
		t.Errorf("status = %q; want %q", body["status"], "ok")
	}
}

func TestReadyEndpointWhenDBIsNil(t *testing.T) {
	db = nil

	rec := httptest.NewRecorder()
	req := httptest.NewRequest("GET", "/ready", nil)
	handleReady(rec, req)

	if rec.Code != http.StatusServiceUnavailable {
		t.Errorf("status = %d; want %d", rec.Code, http.StatusServiceUnavailable)
	}

	var body map[string]string
	json.NewDecoder(rec.Body).Decode(&body)
	if body["status"] != "not ready" {
		t.Errorf("status = %q; want %q", body["status"], "not ready")
	}
}

func TestEnableCORSSetsConfiguredOrigin(t *testing.T) {
	corsOrigin = "http://example.com"

	handler := enableCORS(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	})

	rec := httptest.NewRecorder()
	req := httptest.NewRequest("GET", "/", nil)
	req.Header.Set("Origin", "http://example.com")
	handler(rec, req)

	if rec.Header().Get("Access-Control-Allow-Origin") != "http://example.com" {
		t.Errorf("CORS origin = %q; want %q", rec.Header().Get("Access-Control-Allow-Origin"), "http://example.com")
	}

	corsOrigin = "*"
}

func TestConfigLoadsFromEnv(t *testing.T) {
	os.Setenv("CORS_ORIGIN", "http://test.local")
	os.Setenv("PORT", "9090")
	defer os.Unsetenv("CORS_ORIGIN")
	defer os.Unsetenv("PORT")

	cfg := loadConfig()
	if cfg.CORSOrigin != "http://test.local" {
		t.Errorf("CORSOrigin = %q; want %q", cfg.CORSOrigin, "http://test.local")
	}
	if cfg.Port != "9090" {
		t.Errorf("Port = %q; want %q", cfg.Port, "9090")
	}
}
