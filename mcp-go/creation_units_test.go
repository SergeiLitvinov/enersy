package main

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"

	"github.com/google/jsonschema-go/jsonschema"
)

func TestCreationUnitAcknowledgement(t *testing.T) {
	for _, tc := range []struct {
		name   string
		change func(map[string]any)
		valid  bool
	}{
		{"exact", func(map[string]any) {}, true},
		{"historical deleted receipt", func(r map[string]any) { r["deleted"] = true }, true},
		{"missing declaration", func(r map[string]any) { delete(r, "declaredParameterUnits") }, false},
		{"null declaration", func(r map[string]any) { r["declaredParameterUnits"] = nil }, false},
		{"wrong unit", func(r map[string]any) {
			r["declaredParameterUnits"] = &creationUnits{1, map[string]string{"voltage_nom": "кВ"}}
		}, false},
		{"wrong version", func(r map[string]any) {
			r["declaredParameterUnits"] = &creationUnits{2, map[string]string{"voltage_nom": "В"}}
		}, false},
		{"rounded value", func(r map[string]any) { r["params"] = map[string]string{"voltage_nom": "110000"} }, false},
		{"absent value", func(r map[string]any) { r["params"] = map[string]string{} }, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			const command = "11111111-1111-4111-8111-000000000999"
			var calls atomic.Int32
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				calls.Add(1)
				if r.Method != "POST" || r.Header.Get("Idempotency-Key") != command {
					t.Error("lost original command identity")
				}
				receipt := map[string]any{"success": true, "id": "1", "revision": "1", "topologyRevision": "2", "commandId": command,
					"deleted": false, "params": map[string]string{"voltage_nom": "110000.0000"}, "declaredParameterUnits": &creationUnits{1, map[string]string{"voltage_nom": "В"}}}
				tc.change(receipt)
				w.Header().Set("Content-Type", "application/json")
				if err := json.NewEncoder(w).Encode(receipt); err != nil {
					t.Error(err)
				}
			}))
			defer server.Close()
			// Input-schema validation is exercised by the real discovery/SDK test.
			// Here isolate untrusted API acknowledgements after a committed POST.
			validator, err := (&jsonschema.Schema{Type: "object"}).Resolve(nil)
			if err != nil {
				t.Fatal(err)
			}
			op := operation{ID: createOperation, validator: validator}
			op.HTTP.Method, op.HTTP.Path, op.HTTP.BodyArgument = "POST", "/api/test", "equipment"
			op.HTTP.Headers = map[string]headerMapping{"Idempotency-Key": {Argument: "commandId", Encoding: "raw-string"}}
			b := &bridge{config: configuration{api: server.URL, cookie: "enersy_session"}, client: server.Client()}
			args := json.RawMessage(`{"commandId":"` + command + `","equipment":{"params":{"voltage_nom":"110000.0000"},"parameterUnitDeclaration":{"formatVersion":1,"units":{"voltage_nom":"В"}}}}`)
			_, err = b.invoke(context.Background(), op, args)
			if tc.valid && err != nil || !tc.valid && err != errAPI {
				t.Fatal("incorrect acknowledgement acceptance", err)
			}
			if calls.Load() != 1 {
				t.Fatal("unconfirmed creation was automatically repeated")
			}
		})
	}
}
