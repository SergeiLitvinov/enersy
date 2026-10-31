package main

import (
	"encoding/json"
	"os"
	"strings"
	"testing"
)

func TestEditorDraftUnitIntentSharedFixture(t *testing.T) {
	data, err := os.ReadFile("../tests/fixtures/editor-draft-units-v2.json")
	if err != nil {
		t.Fatal(err)
	}
	parsed, err := decodeEditorDraft(data)
	if err != nil {
		t.Fatal(err)
	}
	if string(parsed.Components[0].Intents[0].Unit) != `"Вт"` || parsed.Components[0].Base.Params["p"] != "10" {
		t.Fatal("lost unit edit or original value")
	}
	encoded, err := json.Marshal(parsed)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := decodeEditorDraft(encoded); err != nil {
		t.Fatal(err)
	}
	for _, raw := range []string{`null`, `""`, `" MW"`, `"MW\n"`, `"\ud800"`, `1`, `{}`} {
		invalid := strings.Replace(string(data), `"unit": "Вт"`, `"unit": `+raw, 1)
		if _, err := decodeEditorDraft([]byte(invalid)); err == nil {
			t.Fatalf("accepted invalid intent unit %s", raw)
		}
	}
	for _, kind := range []string{`"kind":"delete","unit":"1"`, `"kind":"pose","values":{"x":12},"unit":"1"`} {
		invalid := strings.Replace(draftFixture, `"kind":"delete"`, kind, 1)
		if _, err := decodeEditorDraft([]byte(invalid)); err == nil {
			t.Fatal("unit accepted outside a parameter edit")
		}
	}
}

func TestEditorDraftUnitDeclarations(t *testing.T) {
	for _, version := range []int{1, 2} {
		source := strings.Replace(draftFixture, `"params":{"p":"10"}`, `"params":{"p":"10"},"declaredParameterUnits":{"formatVersion":1,"units":{"p":"МВт"}}`, 1)
		if version == 2 {
			source = strings.Replace(source, `"formatVersion":1`, `"formatVersion":2`, 1)
			source = strings.Replace(source, `"graph":[{`, `"graph":[{"phase":"prepared",`, 1)
		}
		parsed, err := decodeEditorDraft([]byte(source))
		if err != nil {
			t.Fatal(err)
		}
		var units parameterUnitDeclaration
		if json.Unmarshal(parsed.Components[0].Base.DeclaredParameterUnits, &units) != nil || units.Units["p"] != "МВт" {
			t.Fatal("lost original units")
		}
		encoded, err := json.Marshal(parsed)
		if err != nil {
			t.Fatal(err)
		}
		restored, err := decodeEditorDraft(encoded)
		if err != nil || string(restored.Components[0].Base.DeclaredParameterUnits) != string(parsed.Components[0].Base.DeclaredParameterUnits) {
			t.Fatal("lost units on re-encoding", err)
		}
	}
	old, err := decodeEditorDraft([]byte(draftFixture))
	if err != nil || len(old.Components[0].Base.DeclaredParameterUnits) != 0 {
		t.Fatal("invented legacy unit")
	}
	for _, raw := range []string{
		`null`, `{}`, `{"formatVersion":2,"units":{"p":"MW"}}`, `{"formatVersion":1,"units":{}}`,
		`{"formatVersion":1,"units":{"absent":"MW"}}`, `{"formatVersion":1,"units":{"p":" "}}`,
		`{"formatVersion":1,"units":{"p":"MW","p":"W"}}`, `{"formatVersion":1,"units":{"p":"\ud800"}}`,
		`{"formatVersion":1,"units":{"p":"MW"},"unknown":true}`, `{"formatVersion":1,"units":{"p":"MW"},"formatVersion":1}`,
	} {
		source := strings.Replace(draftFixture, `"params":{"p":"10"}`, `"params":{"p":"10"},"declaredParameterUnits":`+raw, 1)
		if _, err := decodeEditorDraft([]byte(source)); err == nil {
			t.Fatalf("accepted invalid declaration %s", raw)
		}
	}
}
