package main

import (
	"os"
	"strings"
	"testing"
)

func TestEditorDraftPassportSharedFixture(t *testing.T) {
	data, err := os.ReadFile("../tests/fixtures/editor-draft-passport-v2.json")
	if err != nil {
		t.Fatal(err)
	}
	payload, err := decodeEditorDraft(data)
	if err != nil {
		t.Fatal(err)
	}
	if payload.Components[0].Base.ProjectPassportVersionID == nil || *payload.Components[0].Base.ProjectPassportVersionID != "9007199254740993" {
		t.Fatal("base passport lost")
	}
	for _, entry := range payload.Graph {
		if entry.Intent.ProjectPassportVersionID == nil || *entry.Intent.ProjectPassportVersionID != "9007199254740993" {
			t.Fatal("creation passport lost")
		}
	}
	for _, replacement := range []string{`0`, `"0"`, `"9223372036854775808"`} {
		if _, err := decodeEditorDraft([]byte(strings.ReplaceAll(string(data), `"9007199254740993"`, replacement))); err == nil {
			t.Fatal("invalid passport accepted")
		}
	}
	if _, err := decodeEditorDraft([]byte(strings.ReplaceAll(string(data), `"equipmentModelId": null`, `"equipmentModelId": "2"`))); err == nil {
		t.Fatal("two passport sources accepted")
	}
}
