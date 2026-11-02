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

func TestCreationBaseAcknowledgement(t *testing.T) {
	for _, tc := range []struct {
		name   string
		mutate func(map[string]any)
		valid  bool
	}{
		{"exact", func(map[string]any) {}, true},
		{"unknown declaration field", func(r map[string]any) { r["sourceStudy"] = "unrequested" }, false},
		{"inherited", func(map[string]any) {}, true},
		{"clear", func(r map[string]any) { delete(r, "bases"); r["formatVersion"] = 1 }, true},
		{"missing", func(r map[string]any) { delete(r, "bases"); r["formatVersion"] = 1 }, false},
		{"null map", func(r map[string]any) { r["bases"] = nil }, false},
		{"null base", func(r map[string]any) { r["bases"] = map[string]any{"voltage_nom": nil} }, false},
		{"different S", func(r map[string]any) { r["bases"].(map[string]any)["voltage_nom"].(map[string]any)["s_base_mva"] = 20 }, false},
		{"different U", func(r map[string]any) { r["bases"].(map[string]any)["voltage_nom"].(map[string]any)["v_base_kv"] = 35 }, false},
		{"invalid profile", func(r map[string]any) {
			r["bases"].(map[string]any)["voltage_nom"].(map[string]any)["profile"] = "unknown"
		}, false},
		{"incorrect field case", func(r map[string]any) {
			base := r["bases"].(map[string]any)["voltage_nom"].(map[string]any)
			base["PROFILE"] = base["profile"]
			delete(base, "profile")
		}, false},
		{"zero", func(r map[string]any) { r["bases"].(map[string]any)["voltage_nom"].(map[string]any)["s_base_mva"] = 0 }, false},
		{"unknown field", func(r map[string]any) { r["bases"].(map[string]any)["voltage_nom"].(map[string]any)["extra"] = 1 }, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			const command = "11111111-1111-4111-8111-000000000997"
			var calls atomic.Int32
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
				calls.Add(1)
				units := map[string]any{"formatVersion": 2, "units": map[string]string{"voltage_nom": "p.u."}, "bases": map[string]any{"voltage_nom": map[string]any{"profile": "ac-three-phase-rms-v1", "s_base_mva": 10, "v_base_kv": 110}}}
				tc.mutate(units)
				w.Header().Set("Content-Type", "application/json")
				if err := json.NewEncoder(w).Encode(map[string]any{"success": true, "id": "1", "revision": "2", "topologyRevision": "3", "commandId": command, "deleted": false, "params": map[string]string{"voltage_nom": "1.0000"}, "declaredParameterUnits": units}); err != nil {
					t.Error(err)
				}
			}))
			defer server.Close()
			validator, err := (&jsonschema.Schema{Type: "object"}).Resolve(nil)
			if err != nil {
				t.Fatal(err)
			}
			op := operation{ID: createOperation, validator: validator}
			op.HTTP.Method, op.HTTP.Path, op.HTTP.BodyArgument = "POST", "/api/test", "equipment"
			op.HTTP.Headers = map[string]headerMapping{"Idempotency-Key": {Argument: "commandId", Encoding: "raw-string"}}
			b := &bridge{config: configuration{api: server.URL, cookie: "enersy_session"}, client: server.Client()}
			args := json.RawMessage(`{"commandId":"` + command + `","equipment":{"params":{"voltage_nom":"1.0000"},"parameterUnitDeclaration":{"formatVersion":2,"units":{"voltage_nom":"p.u."},"bases":{"voltage_nom":{"profile":"ac-three-phase-rms-v1","s_base_mva":10,"v_base_kv":110}}}}}`)
			if tc.name == "clear" || tc.name == "inherited" {
				var input map[string]any
				if err := json.Unmarshal(args, &input); err != nil {
					t.Fatal(err)
				}
				declaration := input["equipment"].(map[string]any)["parameterUnitDeclaration"].(map[string]any)
				if tc.name == "clear" {
					declaration["bases"] = map[string]any{"voltage_nom": nil}
				} else {
					delete(declaration, "bases")
					declaration["formatVersion"] = 1
				}
				encoded, err := json.Marshal(input)
				if err != nil {
					t.Fatal(err)
				}
				args = encoded
			}
			_, err = b.invoke(context.Background(), op, args)
			if tc.valid && err != nil || !tc.valid && err != errAPI {
				t.Fatal("incorrect source base confirmation", err)
			}
			if calls.Load() != 1 {
				t.Fatal("unconfirmed write automatically repeated")
			}
		})
	}
}
