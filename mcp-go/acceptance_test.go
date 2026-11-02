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
	if mode == "write" || mode == "write-based" {
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
	if mode != "write" && mode != "write-based" {
		if _, err := session.CallTool(ctx, &mcp.CallToolParams{Name: createOperation, Arguments: map[string]any{}}); err == nil {
			t.Fatal("read-only session exposed write")
		}
		return
	}
	commandID := "11111111-1111-4111-8111-000000000999"
	expectedValue, expectedUnit := "110000.0000", "В"
	if mode == "write-based" {
		commandID = "11111111-1111-4111-8111-000000000997"
		expectedValue, expectedUnit = "1.0000", "p.u."
	}
	args := map[string]any{"commandId": commandID, "expectedTopologyRevision": graph["topologyRevision"],
		"equipment": map[string]any{"typeId": os.Getenv("TEST_MCP_TYPE_ID"), "name": "MCP acceptance busbar", "x": 0, "y": 0, "rotation": 0, "params": map[string]string{"voltage_nom": "110000.0000"},
			"parameterUnitDeclaration": map[string]any{"formatVersion": 1, "units": map[string]string{"voltage_nom": "В"}}}}
	if mode == "write-based" {
		equipment := args["equipment"].(map[string]any)
		equipment["params"] = map[string]string{"voltage_nom": expectedValue}
		equipment["parameterUnitDeclaration"] = map[string]any{"formatVersion": 2, "units": map[string]string{"voltage_nom": expectedUnit}, "bases": map[string]any{"voltage_nom": map[string]any{"profile": "ac-three-phase-rms-v1", "s_base_mva": 10, "v_base_kv": 110}}}
	}
	for _, units := range []any{nil, map[string]any{"formatVersion": 2, "units": map[string]string{"voltage_nom": "В"}},
		map[string]any{"formatVersion": 2, "units": map[string]string{"voltage_nom": "p.u."}, "bases": map[string]any{"voltage_nom": map[string]any{"profile": "ac-three-phase-rms-v1", "s_base_mva": 0, "v_base_kv": 110}}},
		map[string]any{"formatVersion": 2, "units": map[string]string{"voltage_nom": "p.u."}, "bases": map[string]any{"absent": map[string]any{"profile": "ac-three-phase-rms-v1", "s_base_mva": 10, "v_base_kv": 110}}},
		map[string]any{"formatVersion": 1, "units": map[string]string{}},
		map[string]any{"formatVersion": 1, "units": map[string]string{"voltage_nom": " MW"}},
		map[string]any{"formatVersion": 1, "units": map[string]string{"voltage_nom": "В\n"}},
		map[string]any{"formatVersion": 1, "units": map[string]string{"absent": "В"}}} {
		equipment := map[string]any{}
		for key, value := range args["equipment"].(map[string]any) {
			equipment[key] = value
		}
		equipment["parameterUnitDeclaration"] = units
		invalid := map[string]any{"commandId": args["commandId"], "expectedTopologyRevision": args["expectedTopologyRevision"], "equipment": equipment}
		if result := call(createOperation, invalid); !result.IsError {
			t.Fatal("invalid creation units admitted")
		}
	}
	lost := call(createOperation, args)
	if !lost.IsError {
		t.Fatal("lost acknowledgement was hidden by an automatic retry")
	}
	committed := read()
	if len(committed["components"].([]any)) != len(graph["components"].([]any))+1 {
		t.Fatal("lost response did not leave one committed creation")
	}
	first := call(createOperation, args) // Explicit replay of the original input.
	if first.IsError {
		t.Fatal("creation failed", first)
	}
	var receipt struct {
		ID                     string
		Params                 map[string]string
		DeclaredParameterUnits *creationUnits
	}
	if json.Unmarshal([]byte(first.Content[0].(*mcp.TextContent).Text), &receipt) != nil || receipt.Params["voltage_nom"] != expectedValue || receipt.DeclaredParameterUnits == nil || receipt.DeclaredParameterUnits.Units["voltage_nom"] != expectedUnit {
		t.Fatal("creation receipt lost the explicit value/unit pair")
	}
	if mode == "write-based" && (receipt.DeclaredParameterUnits.Bases["voltage_nom"] == nil || receipt.DeclaredParameterUnits.Bases["voltage_nom"].SBaseMVA != 10 || receipt.DeclaredParameterUnits.Bases["voltage_nom"].VBaseKV != 110) {
		t.Fatal("lost source basis")
	}
	replay := call(createOperation, args)
	if replay.IsError || replay.Content[0].(*mcp.TextContent).Text != first.Content[0].(*mcp.TextContent).Text {
		t.Fatal("replay did not return same receipt")
	}
	after := read()
	if len(after["components"].([]any)) != len(graph["components"].([]any))+1 {
		t.Fatal("duplicate or missing creation")
	}
	found := false
	for _, raw := range after["components"].([]any) {
		component := raw.(map[string]any)
		if component["id"] == receipt.ID {
			found = true
			units := component["declaredParameterUnits"].(map[string]any)["units"].(map[string]any)
			if component["params"].(map[string]any)["voltage_nom"] != expectedValue || units["voltage_nom"] != expectedUnit {
				t.Fatal("graph differs from acknowledged pair")
			}
			if mode == "write-based" {
				base := component["declaredParameterUnits"].(map[string]any)["bases"].(map[string]any)["voltage_nom"].(map[string]any)
				if base["profile"] != "ac-three-phase-rms-v1" || base["s_base_mva"] != float64(10) || base["v_base_kv"] != float64(110) {
					t.Fatal("fresh graph lost original source base")
				}
			}
		}
	}
	if !found {
		t.Fatal("created component missing from fresh graph")
	}
	equipment := args["equipment"].(map[string]any)
	originalUnits := equipment["parameterUnitDeclaration"]
	equipment["parameterUnitDeclaration"] = map[string]any{"formatVersion": 1, "units": map[string]string{"voltage_nom": "кВ"}}
	if result := call(createOperation, args); !result.IsError {
		t.Fatal("unit-only change reused a command")
	}
	equipment["parameterUnitDeclaration"] = originalUnits
	if mode == "write-based" {
		bases := originalUnits.(map[string]any)["bases"].(map[string]any)
		source := bases["voltage_nom"].(map[string]any)
		source["s_base_mva"] = 20
		if result := call(createOperation, args); !result.IsError {
			t.Fatal("basis-only change reused original command")
		}
		source["s_base_mva"] = 10
	}
	args["commandId"] = "11111111-1111-4111-8111-000000000998"
	if result := call(createOperation, args); !result.IsError {
		t.Fatal("stale topology accepted")
	}
	args["commandId"] = commandID
	args["equipment"].(map[string]any)["name"] = "Changed intention"
	if result := call(createOperation, args); !result.IsError || strings.Contains(result.Content[0].(*mcp.TextContent).Text, "Changed intention") {
		t.Fatal("changed intention accepted or echoed")
	}
}
