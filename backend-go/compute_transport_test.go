package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestComputeWorkerStatuses(t *testing.T) {
	for _, status := range []int{400, 422, 500, 503} {
		t.Run(http.StatusText(status), func(t *testing.T) {
			body := `{"success":false,"error_detail":{"code":"worker_failure","message":"diagnostic"}}`
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				w.WriteHeader(status)
				io.WriteString(w, body)
			}))
			defer server.Close()
			previous := juliaBaseURL
			juliaBaseURL = server.URL
			defer func() { juliaBaseURL = previous }()
			rec := httptest.NewRecorder()
			proxyJulia(rec, httptest.NewRequest("POST", "/", nil), "/calculate", []byte(`{}`))
			if rec.Code != status || rec.Body.String() != body {
				t.Fatalf("worker diagnostic changed: %d %s", rec.Code, rec.Body.String())
			}
		})
	}
}

func TestComputeUnavailable(t *testing.T) {
	server := httptest.NewServer(http.NotFoundHandler())
	server.Close()
	previous := juliaBaseURL
	juliaBaseURL = server.URL
	defer func() { juliaBaseURL = previous }()
	rec := httptest.NewRecorder()
	handleCapabilities(rec, httptest.NewRequest("GET", "/", nil))
	if rec.Code != 503 || !strings.Contains(rec.Body.String(), "unreachable") {
		t.Fatalf("unavailable status: %d %s", rec.Code, rec.Body.String())
	}
}

func TestComputeMalformedJSON(t *testing.T) {
	for _, body := range []string{"", " \n\t", "<html>upstream failure</html>", `{"success":true`, `{"success":true}{"other":1}`, `{"value":NaN}`} {
		t.Run(fmt.Sprintf("%q", body), func(t *testing.T) {
			for _, status := range []int{http.StatusOK, http.StatusInternalServerError} {
				server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
					w.WriteHeader(status)
					io.WriteString(w, body)
				}))
				previous := juliaBaseURL
				juliaBaseURL = server.URL
				rec := httptest.NewRecorder()
				proxyJulia(rec, httptest.NewRequest("POST", "/", nil), "/calculate", []byte(`{}`))
				juliaBaseURL = previous
				server.Close()
				if rec.Code != http.StatusBadGateway || !json.Valid(rec.Body.Bytes()) || !strings.Contains(rec.Body.String(), "Invalid Julia JSON response") {
					t.Fatalf("malformed worker document accepted: upstream=%d gateway=%d body=%s", status, rec.Code, rec.Body.String())
				}
			}
		})
	}
}

func TestComputeValidJSONPreserved(t *testing.T) {
	// Keep this a transport check: a valid JSON document is not proof of physics.
	body := " \n" + `{"success":true,"value":1.2345678901234567,"unicode":"напряжение"}` + "\n"
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { io.WriteString(w, body) }))
	defer server.Close()
	previous := juliaBaseURL
	juliaBaseURL = server.URL
	defer func() { juliaBaseURL = previous }()
	rec := httptest.NewRecorder()
	proxyJulia(rec, httptest.NewRequest("POST", "/", nil), "/calculate", []byte(`{}`))
	if rec.Code != http.StatusOK || rec.Body.String() != body {
		t.Fatalf("valid worker document changed: %d %s", rec.Code, rec.Body.String())
	}
}

func TestComputeResponseFailures(t *testing.T) {
	for _, oversized := range []bool{false, true} {
		server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if oversized {
				io.WriteString(w, strings.Repeat("x", computeBodyLimit+1))
			} else {
				w.Header().Set("Content-Length", "100")
				io.WriteString(w, `{}`)
			}
		}))
		previous := juliaBaseURL
		juliaBaseURL = server.URL
		rec := httptest.NewRecorder()
		handleCapabilities(rec, httptest.NewRequest("GET", "/", nil))
		juliaBaseURL = previous
		server.Close()
		if rec.Code != 502 {
			t.Fatalf("invalid worker body: %d %s", rec.Code, rec.Body.String())
		}
	}
}

func TestComputeCancellationDuringBody(t *testing.T) {
	for _, deadline := range []bool{false, true} {
		t.Run(map[bool]string{false: "cancel", true: "deadline"}[deadline], func(t *testing.T) {
			started, stopped := make(chan struct{}), make(chan struct{})
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				w.Header().Set("Content-Type", "application/json")
				io.WriteString(w, `{"partial":`)
				w.(http.Flusher).Flush()
				close(started)
				<-r.Context().Done()
				close(stopped)
			}))
			defer server.Close()
			previous := juliaBaseURL
			juliaBaseURL = server.URL
			defer func() { juliaBaseURL = previous }()
			ctx, cancel := context.WithCancel(context.Background())
			if deadline {
				cancel()
				ctx, cancel = context.WithTimeout(context.Background(), time.Second)
			}
			defer cancel()
			rec := httptest.NewRecorder()
			finished := make(chan struct{})
			go func() {
				handleCapabilities(rec, httptest.NewRequest("GET", "/", nil).WithContext(ctx))
				close(finished)
			}()
			select {
			case <-started:
			case <-time.After(2 * time.Second):
				cancel()
				t.Fatal("worker not reached")
			}
			if !deadline {
				cancel()
			}
			select {
			case <-finished:
			case <-time.After(3 * time.Second):
				cancel()
				t.Fatal("proxy body read did not stop")
			}
			select {
			case <-stopped:
			case <-time.After(time.Second):
				t.Fatal("worker connection not released")
			}
			want := 408
			if deadline {
				want = 504
			}
			if rec.Code != want {
				t.Fatalf("body cancellation: %d expected %d: %s", rec.Code, want, rec.Body.String())
			}
			if strings.Contains(rec.Body.String(), "partial") {
				t.Fatal("partial worker result leaked")
			}
		})
	}
}

type failingComputeBody struct{}

func (failingComputeBody) Read([]byte) (int, error) { return 0, errors.New("broken incoming body") }
func (failingComputeBody) Close() error             { return nil }

func TestComputeUnreadableRequest(t *testing.T) {
	req := httptest.NewRequest("POST", "/julia/solve", nil)
	req.Body = failingComputeBody{}
	rec := httptest.NewRecorder()
	handleJuliaSolve(rec, req)
	if rec.Code != 400 {
		t.Fatalf("unreadable body: %d", rec.Code)
	}
}
