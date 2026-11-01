package main

import (
	"context"
	"encoding/json"
	"os"
	"os/exec"
	"strings"
	"testing"
	"time"

	"github.com/modelcontextprotocol/go-sdk/mcp"
)

// The backend fixture starts a real private API/PostgreSQL and invokes this
// independent SDK client. No SDK dependency is linked into the application API.
func TestExternalAPIAcceptance(t *testing.T) {
	binary := os.Getenv("TEST_MCP_BINARY")
	if binary == "" {
		t.Skip("requires real API fixture and MCP executable")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	client := mcp.NewClient(&mcp.Implementation{Name: "enersy-real-api-acceptance", Version: "1"}, nil)
	session, err := client.Connect(ctx, &mcp.CommandTransport{Command: exec.Command(binary)}, nil)
	mode := os.Getenv("TEST_MCP_MODE")
	if mode == "denied" {
		if err == nil {
			session.Close()
			t.Fatal("foreign/revoked actor connected")
		}
		return
	}
	if err != nil {
		t.Fatal("MCP process connection failed", err)
	}
	defer session.Close()
	if session.InitializeResult().ProtocolVersion != protocolVersion {
		t.Fatal("unexpected negotiated protocol")
	}
	list, err := session.ListTools(ctx, nil)
	want := 1
	if mode == "write" {
		want = 2
	}
	if err != nil || len(list.Tools) != want {
		t.Fatal("incorrect tool permissions", list, err)
	}
	call := func(name string, args any) *mcp.CallToolResult {
		t.Helper()
		result, err := session.CallTool(ctx, &mcp.CallToolParams{Name: name, Arguments: args})
		if err != nil {
			t.Fatal("tool RPC failed", err)
		}
		return result
	}
	read := func() map[string]any {
		t.Helper()
		result := call(readOperation, map[string]any{})
		if result.IsError {
			t.Fatal("read failed", result)
		}
		var graph map[string]any
		if json.Unmarshal([]byte(result.Content[0].(*mcp.TextContent).Text), &graph) != nil {
			t.Fatal("malformed graph")
		}
		return graph
	}
	graph := read()
	if graph["id"] != os.Getenv("ENERSY_MCP_SCHEME_ID") || graph["projectId"] != os.Getenv("ENERSY_MCP_PROJECT_ID") {
		t.Fatal("wrong scope")
	}
	if mode != "write" {
		if _, err := session.CallTool(ctx, &mcp.CallToolParams{Name: createOperation, Arguments: map[string]any{}}); err == nil {
			t.Fatal("read-only session exposed write")
		}
		return
	}
	args := map[string]any{"commandId": "11111111-1111-4111-8111-000000000999", "expectedTopologyRevision": graph["topologyRevision"],
		"equipment": map[string]any{"typeId": os.Getenv("TEST_MCP_TYPE_ID"), "name": "MCP acceptance busbar", "x": 0, "y": 0, "rotation": 0, "params": map[string]string{}}}
	first := call(createOperation, args)
	if first.IsError {
		t.Fatal("creation failed", first)
	}
	replay := call(createOperation, args)
	if replay.IsError || replay.Content[0].(*mcp.TextContent).Text != first.Content[0].(*mcp.TextContent).Text {
		t.Fatal("replay did not return same receipt")
	}
	after := read()
	if len(after["components"].([]any)) != len(graph["components"].([]any))+1 {
		t.Fatal("duplicate or missing creation")
	}
	args["commandId"] = "11111111-1111-4111-8111-000000000998"
	if result := call(createOperation, args); !result.IsError {
		t.Fatal("stale topology accepted")
	}
	args["commandId"] = "11111111-1111-4111-8111-000000000999"
	args["equipment"].(map[string]any)["name"] = "Changed intention"
	if result := call(createOperation, args); !result.IsError || strings.Contains(result.Content[0].(*mcp.TextContent).Text, "Changed intention") {
		t.Fatal("changed intention accepted or echoed")
	}
}
