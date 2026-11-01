package main

import (
	"bufio"
	"context"
	"encoding/json"
	"io"
	"testing"
	"time"
)

func TestNegotiationAndExactRequestID(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	serverRead, clientWrite := io.Pipe()
	clientRead, serverWrite := io.Pipe()
	defer clientRead.Close()
	defer clientWrite.Close()
	done := make(chan error, 1)
	go func() { done <- serve(ctx, &bridge{}, serverRead, serverWrite); serverWrite.Close() }()
	reader := bufio.NewReader(clientRead)
	exchange := func(input string) map[string]json.RawMessage {
		t.Helper()
		if _, err := io.WriteString(clientWrite, input+"\n"); err != nil {
			t.Fatal(err)
		}
		line, err := reader.ReadBytes('\n')
		if err != nil {
			t.Fatal(err)
		}
		if !validJSON(line) {
			t.Fatal("non-JSON stdout")
		}
		var response map[string]json.RawMessage
		if json.Unmarshal(line, &response) != nil {
			t.Fatal("malformed response")
		}
		return response
	}
	result := exchange(`{"jsonrpc":"2.0","id":"9007199254740993","method":"initialize","params":{"protocolVersion":"2026-07-28","capabilities":{},"clientInfo":{"name":"fixture","version":"1"}}}`)
	if string(result["id"]) != `"9007199254740993"` {
		t.Fatal("request ID changed")
	}
	var negotiated struct{ ProtocolVersion string }
	if json.Unmarshal(result["result"], &negotiated) != nil || negotiated.ProtocolVersion != protocolVersion {
		t.Fatal("incorrect profile fallback")
	}
	if _, err := io.WriteString(clientWrite, `{"jsonrpc":"2.0","method":"notifications/initialized"}`+"\n"); err != nil {
		t.Fatal(err)
	}
	ping := exchange(`{"jsonrpc":"2.0","id":9007199254740991,"method":"ping"}`)
	if string(ping["id"]) != "9007199254740991" || ping["error"] != nil {
		t.Fatal("ping correlation changed")
	}
	clientWrite.Close()
	select {
	case <-done:
	case <-ctx.Done():
		t.Fatal("EOF did not stop server")
	}
}
