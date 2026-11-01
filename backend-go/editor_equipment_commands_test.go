package main

import (
	"fmt"
	"strings"
	"testing"
)

func TestEditorEquipmentCommandPayload(t *testing.T) {
	const intent = `{"kind":"create-component","commandId":"11111111-1111-4111-8111-111111111111","expectedTopologyRevision":"9007199254740993","typeId":"1","name":"Шина","x":0,"y":0,"rotation":0,"equipmentModelId":null,"params":{"voltage_nom":"110.00"}}`
	for _, version := range []int{1, 2} {
		phase := ""
		if version == 2 {
			phase = `"phase":"prepared",`
		}
		body := fmt.Sprintf(`{"formatVersion":%d,"components":[],"graph":[{%s"intent":%s,"reason":"lost"}]}`, version, phase, intent)
		payload, err := decodeEditorDraft([]byte(body))
		if err != nil || len(payload.Graph) != 1 || payload.Graph[0].Intent.CommandID == nil || *payload.Graph[0].Intent.CommandID != "11111111-1111-4111-8111-111111111111" || string(payload.Graph[0].Intent.ExpectedTopologyRevision) != `"9007199254740993"` {
			t.Fatal("protected equipment intent was not retained", payload, err)
		}
		for _, invalid := range []string{
			strings.Replace(body, `"commandId":"11111111-1111-4111-8111-111111111111",`, "", 1),
			strings.Replace(body, `"expectedTopologyRevision":"9007199254740993",`, "", 1),
			strings.Replace(body, `"expectedTopologyRevision":"9007199254740993"`, `"expectedTopologyRevision":9007199254740993`, 1),
			strings.Replace(body, `"commandId":"11111111-1111-4111-8111-111111111111"`, `"commandId":"invalid"`, 1),
		} {
			if _, err := decodeEditorDraft([]byte(invalid)); err == nil {
				t.Fatal("incomplete command identity admitted", invalid)
			}
		}
		if version == 2 {
			if _, err := decodeEditorDraft([]byte(strings.Replace(body, `"phase":"prepared"`, `"phase":"unprepared"`, 1))); err == nil {
				t.Fatal("unprepared entry claimed an observed command revision")
			}
		}
	}
}
