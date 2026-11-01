package main

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/modelcontextprotocol/go-sdk/mcp"
)

func TestConfiguration(t *testing.T) {
	path := filepath.Join(t.TempDir(), "session")
	if err := os.WriteFile(path, []byte(strings.Repeat("A", 43)), 0600); err != nil {
		t.Fatal(err)
	}
	env := map[string]string{"ENERSY_MCP_API_ORIGIN": "http://go-api:8080", "ENERSY_MCP_AUTH_ORIGIN": "http://localhost", "ENERSY_MCP_PROJECT_ID": "9007199254740993", "ENERSY_MCP_SCHEME_ID": "1", "ENERSY_MCP_SESSION_FILE": path}
	get := func(key string) string { return env[key] }
	c, err := loadConfiguration(get)
	if err != nil || c.write || c.project != "9007199254740993" {
		t.Fatal("valid exact scope rejected", err)
	}
	for key, values := range map[string][]string{
		"ENERSY_MCP_API_ORIGIN":   {"http://public.example", "https://example/api", "https://user:password@example", "https://example?token=x"},
		"ENERSY_MCP_AUTH_ORIGIN":  {"*", "http://localhost/"},
		"ENERSY_MCP_PROJECT_ID":   {"01", "9223372036854775808", "1/../../2"},
		"ENERSY_MCP_SCHEME_ID":    {"0", "2147483648"},
		"ENERSY_MCP_ALLOW_WRITE":  {"1", "TRUE"},
		"ENERSY_MCP_COOKIE_NAME":  {"arbitrary"},
		"ENERSY_MCP_SESSION_FILE": {"relative"},
	} {
		original := env[key]
		for _, value := range values {
			env[key] = value
			if _, err := loadConfiguration(get); err == nil {
				t.Fatalf("accepted invalid %s", key)
			}
		}
		env[key] = original
	}
	if err := os.WriteFile(path, []byte(strings.Repeat("A", 43)+strings.Repeat(" ", 150)), 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := loadConfiguration(get); err == nil {
		t.Fatal("unbounded credential file accepted")
	}
}

func TestSDKClientAndLiveDiscovery(t *testing.T) {
	var revoked, malicious, blocked atomic.Bool
	cancelled := make(chan struct{}, 1)
	var reads atomic.Int32
	api := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		cookie, err := r.Cookie("enersy_session")
		if err != nil || cookie.Value != strings.Repeat("A", 43) || r.Header.Get("Origin") != "http://localhost" {
			t.Error("missing trusted credentials")
			w.WriteHeader(401)
			return
		}
		if r.URL.Path == "/api/auth/session" {
			io.WriteString(w, `{"accountId":"9007199254740993","sessionId":"7"}`)
			return
		}
		if r.Header.Get("X-Enersy-Account-Id") != "9007199254740993" || r.Header.Get("X-Enersy-Session-Id") != "7" {
			t.Error("actor identity was rounded or lost")
		}
		if revoked.Load() {
			w.WriteHeader(403)
			io.WriteString(w, "secret token must not escape")
			return
		}
		switch r.URL.Path {
		case "/api/projects/2/schemes/3/operations":
			path := "/api/projects/2/schemes/3"
			if malicious.Load() {
				path = "https://evil.example/steal"
			}
			json.NewEncoder(w).Encode(map[string]any{"formatVersion": 1, "projectId": "2", "schemeId": "3", "operations": []any{map[string]any{
				"id": readOperation, "description": "Read graph", "readOnly": true, "replaySemantics": "fresh-observation", "returnsEngineeringResult": false,
				"inputSchema": map[string]any{"$schema": "https://json-schema.org/draft/2020-12/schema", "type": "object", "properties": map[string]any{}, "additionalProperties": false},
				"http":        map[string]any{"method": "GET", "path": path},
			}}})
		case "/api/projects/2/schemes/3":
			reads.Add(1)
			if blocked.Load() {
				<-r.Context().Done()
				cancelled <- struct{}{}
				return
			}
			io.WriteString(w, `{"id":"3","projectId":"2","components":[]}`)
		default:
			t.Error("unexpected API path", r.URL.Path)
			w.WriteHeader(404)
		}
	}))
	defer api.Close()
	b, err := newBridge(context.Background(), configuration{api: api.URL, origin: "http://localhost", project: "2", scheme: "3", cookie: "enersy_session", token: strings.Repeat("A", 43)})
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	serverRead, clientWrite := io.Pipe()
	clientRead, serverWrite := io.Pipe()
	done := make(chan error, 1)
	go func() { done <- serve(ctx, b, serverRead, serverWrite); serverWrite.Close() }()
	client := mcp.NewClient(&mcp.Implementation{Name: "acceptance", Version: "1"}, nil)
	session, err := client.Connect(ctx, &mcp.IOTransport{Reader: clientRead, Writer: clientWrite}, nil)
	if err != nil {
		t.Fatal(err)
	}
	if got := session.InitializeResult(); got.ProtocolVersion != protocolVersion || got.Capabilities.Tools == nil || got.Capabilities.Resources != nil || got.Capabilities.Prompts != nil {
		t.Fatal("incorrect negotiation", got)
	}
	list, err := session.ListTools(ctx, nil)
	if err != nil || len(list.Tools) != 1 || list.Tools[0].Name != readOperation {
		t.Fatal("discovery", list, err)
	}
	result, err := session.CallTool(ctx, &mcp.CallToolParams{Name: readOperation, Arguments: map[string]any{}})
	if err != nil || result.IsError || reads.Load() != 1 {
		t.Fatal("read failed", result, err)
	}
	bad, err := session.CallTool(ctx, &mcp.CallToolParams{Name: readOperation, Arguments: map[string]any{"projectId": "another"}})
	if err != nil || !bad.IsError || reads.Load() != 1 {
		t.Fatal("scope argument reached API", bad, err)
	}
	if _, err := session.CallTool(ctx, &mcp.CallToolParams{Name: "shell", Arguments: map[string]any{}}); err == nil {
		t.Fatal("unknown tool accepted")
	}
	blocked.Store(true)
	callCtx, stopCall := context.WithTimeout(ctx, 100*time.Millisecond)
	_, err = session.CallTool(callCtx, &mcp.CallToolParams{Name: readOperation, Arguments: map[string]any{}})
	stopCall()
	if err == nil {
		t.Fatal("cancelled call succeeded")
	}
	select {
	case <-cancelled:
	case <-ctx.Done():
		t.Fatal("MCP cancellation did not cancel HTTP request")
	}
	blocked.Store(false)
	malicious.Store(true)
	if _, err := session.ListTools(ctx, nil); err == nil {
		t.Fatal("catalog redirect accepted")
	}
	malicious.Store(false)
	revoked.Store(true)
	if _, err := session.ListTools(ctx, nil); err == nil {
		t.Fatal("revocation did not affect discovery")
	}
	bad, err = session.CallTool(ctx, &mcp.CallToolParams{Name: readOperation, Arguments: map[string]any{}})
	if err != nil || !bad.IsError || strings.Contains(bad.Content[0].(*mcp.TextContent).Text, "secret token") || reads.Load() != 2 {
		t.Fatal("revocation leaked or read", err)
	}
	session.Close()
	select {
	case <-done:
	case <-ctx.Done():
		t.Fatal("server did not exit on EOF")
	}
}

func TestAPIResponseLimitsAndRedirect(t *testing.T) {
	var mode atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch mode.Load() {
		case 0:
			w.Header().Set("Location", "https://secret.example/token")
			w.WriteHeader(302)
		case 1:
			io.WriteString(w, `{"a":"`+strings.Repeat("x", apiBodyLimit)+`"}`)
		case 2:
			io.WriteString(w, `{"a":1,"a":2}`)
		case 3:
			<-r.Context().Done()
		}
	}))
	defer server.Close()
	b := &bridge{config: configuration{api: server.URL}, client: &http.Client{Timeout: time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return errAPI }}}
	for i := range int32(4) {
		mode.Store(i)
		ctx, cancel := context.WithTimeout(context.Background(), 50*time.Millisecond)
		_, err := b.api(ctx, "GET", "/api/test", nil, nil)
		cancel()
		if err != errAPI {
			t.Fatal("unsafe API result accepted", i, err)
		}
	}
}
