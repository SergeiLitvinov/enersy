package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"math"
	"regexp"
	"strconv"
	"strings"
	"unicode/utf8"
)

const editorDraftMaxBytes = 256 << 10

var errEditorDraftPayload = errors.New("invalid editor draft payload")
var editorWorkspacePattern = regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`)

type editorDraftPayload struct {
	FormatVersion int                    `json:"formatVersion"`
	Components    []editorComponentDraft `json:"components"`
	Graph         []editorGraphDraft     `json:"graph"`
}
type editorComponentBase struct {
	ID               string            `json:"id"`
	TypeID           string            `json:"typeId"`
	Type             string            `json:"type"`
	EquipmentModelID *string           `json:"equipmentModelId"`
	Revision         string            `json:"revision"`
	Name             string            `json:"name"`
	X                *float64          `json:"x"`
	Y                *float64          `json:"y"`
	Rotation         *int              `json:"rotation"`
	Params           map[string]string `json:"params"`
}
type editorComponentDraft struct {
	ComponentID string                  `json:"componentId"`
	Base        editorComponentBase     `json:"base"`
	Intents     []editorComponentIntent `json:"intents"`
	Reason      string                  `json:"reason"`
}
type editorComponentIntent struct {
	Kind   string          `json:"kind"`
	Values json.RawMessage `json:"values,omitempty"`
	Key    *string         `json:"key,omitempty"`
	Value  *string         `json:"value,omitempty"`
}
type editorGraphDraft struct {
	Intent editorGraphIntent `json:"intent"`
	Reason string            `json:"reason"`
}
type editorGraphIntent struct {
	Kind                     string            `json:"kind"`
	TypeID                   *string           `json:"typeId,omitempty"`
	Name                     *string           `json:"name,omitempty"`
	X                        *float64          `json:"x,omitempty"`
	Y                        *float64          `json:"y,omitempty"`
	Rotation                 *int              `json:"rotation,omitempty"`
	EquipmentModelID         *string           `json:"equipmentModelId,omitempty"`
	Params                   map[string]string `json:"params,omitempty"`
	CommandID                *string           `json:"commandId,omitempty"`
	From                     *string           `json:"from,omitempty"`
	To                       *string           `json:"to,omitempty"`
	FromPort                 *string           `json:"fromPort,omitempty"`
	ToPort                   *string           `json:"toPort,omitempty"`
	ID                       *string           `json:"id,omitempty"`
	ExpectedTopologyRevision *string           `json:"expectedTopologyRevision,omitempty"`
}

func draftText(value string, limit int) bool {
	return utf8.ValidString(value) && !strings.ContainsRune(value, 0) && utf8.RuneCountInString(value) <= limit
}
func draftRevision(value string, zero bool) bool {
	n, err := strconv.ParseInt(value, 10, 64)
	return err == nil && (n > 0 || (zero && n == 0)) && strconv.FormatInt(n, 10) == value
}
func draftID(value string) bool { _, err := intProjectID(value); return err == nil }
func draftParams(values map[string]string) bool {
	if values == nil || len(values) > 256 {
		return false
	}
	for key, value := range values {
		if validateComponentParameter(key, value) != nil {
			return false
		}
	}
	return true
}
func decodeEditorDraft(data []byte) (editorDraftPayload, error) {
	var payload editorDraftPayload
	if len(data) > editorDraftMaxBytes || !utf8.Valid(data) {
		return payload, errEditorDraftPayload
	}
	if !unambiguousDraftJSON(data) || !draftUnicodeEscapes(data) {
		return payload, errEditorDraftPayload
	}
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&payload); err != nil {
		return payload, errEditorDraftPayload
	}
	if decoder.Decode(&struct{}{}) != io.EOF {
		return payload, errEditorDraftPayload
	}
	if payload.FormatVersion != 1 || payload.Components == nil || payload.Graph == nil || len(payload.Components) > 128 || len(payload.Graph) > 128 {
		return payload, errEditorDraftPayload
	}
	seen := map[string]bool{}
	for _, draft := range payload.Components {
		base := draft.Base
		if !draftID(draft.ComponentID) || seen[draft.ComponentID] || base.ID != draft.ComponentID || !draftID(base.TypeID) || !draftRevision(base.Revision, false) || !draftText(base.Type, 50) || base.Type == "" || base.X == nil || base.Y == nil || base.Rotation == nil || !draftParams(base.Params) || len(draft.Intents) == 0 || len(draft.Intents) > 64 || !draftText(draft.Reason, 1024) {
			return payload, errEditorDraftPayload
		}
		if base.EquipmentModelID != nil && !draftID(*base.EquipmentModelID) {
			return payload, errEditorDraftPayload
		}
		if validateComponentPose(*base.X, *base.Y, base.Name) != nil || *base.Rotation < math.MinInt32 || *base.Rotation > math.MaxInt32 {
			return payload, errEditorDraftPayload
		}
		seen[draft.ComponentID] = true
		for _, intent := range draft.Intents {
			switch intent.Kind {
			case "pose":
				if len(intent.Values) == 0 || intent.Key != nil || intent.Value != nil {
					return payload, errEditorDraftPayload
				}
				patch := componentPatchRequest{Pose: intent.Values}
				if _, err := parseComponentPatch(patch); err != nil {
					return payload, errEditorDraftPayload
				}
			case "parameter":
				if len(intent.Values) != 0 || intent.Key == nil || intent.Value == nil || validateComponentParameter(*intent.Key, *intent.Value) != nil {
					return payload, errEditorDraftPayload
				}
			case "delete":
				if len(intent.Values) != 0 || intent.Key != nil || intent.Value != nil {
					return payload, errEditorDraftPayload
				}
			default:
				return payload, errEditorDraftPayload
			}
		}
	}
	commands := map[string]bool{}
	for _, draft := range payload.Graph {
		if !draftText(draft.Reason, 1024) {
			return payload, errEditorDraftPayload
		}
		i := draft.Intent
		creation := i.TypeID != nil || i.Name != nil || i.X != nil || i.Y != nil || i.Rotation != nil || i.EquipmentModelID != nil || i.Params != nil
		connection := i.CommandID != nil || i.From != nil || i.To != nil || i.FromPort != nil || i.ToPort != nil
		switch i.Kind {
		case "create-component":
			if connection || i.ID != nil || i.ExpectedTopologyRevision != nil || i.TypeID == nil || !draftID(*i.TypeID) || i.Name == nil || i.X == nil || i.Y == nil || i.Rotation == nil || !draftParams(i.Params) || validateComponentPose(*i.X, *i.Y, *i.Name) != nil || (i.EquipmentModelID != nil && !draftID(*i.EquipmentModelID)) {
				return payload, errEditorDraftPayload
			}
			if *i.Rotation < math.MinInt32 || *i.Rotation > math.MaxInt32 {
				return payload, errEditorDraftPayload
			}
		case "create-connection":
			if creation || i.ID != nil || i.CommandID == nil || !editorWorkspacePattern.MatchString(*i.CommandID) || commands[*i.CommandID] || i.From == nil || i.To == nil || !draftID(*i.From) || !draftID(*i.To) || i.FromPort == nil || i.ToPort == nil || *i.FromPort == "" || *i.ToPort == "" || !draftText(*i.FromPort, 64) || !draftText(*i.ToPort, 64) || i.ExpectedTopologyRevision == nil || !draftRevision(*i.ExpectedTopologyRevision, true) {
				return payload, errEditorDraftPayload
			}
			commands[*i.CommandID] = true
		case "delete-connection":
			if creation || connection || i.ID == nil || !draftID(*i.ID) || i.ExpectedTopologyRevision == nil || !draftRevision(*i.ExpectedTopologyRevision, true) {
				return payload, errEditorDraftPayload
			}
		default:
			return payload, errEditorDraftPayload
		}
	}
	return payload, nil
}

// Duplicate keys are not an instruction to overwrite part of a recovery
// journal. Bound depth before recursive decoding and reject trailing documents.
func unambiguousDraftJSON(data []byte) bool {
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.UseNumber()
	fields := map[string]bool{}
	for _, field := range strings.Split("formatVersion components graph componentId base intents reason id typeId type equipmentModelId revision name x y rotation params kind values key value intent commandId from to fromPort toPort expectedTopologyRevision", " ") {
		fields[field] = true
	}
	var value func(int, bool) bool
	value = func(depth int, parameters bool) bool {
		if depth > 16 {
			return false
		}
		token, err := decoder.Token()
		if err != nil {
			return false
		}
		delimiter, compound := token.(json.Delim)
		if !compound {
			return true
		}
		switch delimiter {
		case '{':
			seen := map[string]bool{}
			for decoder.More() {
				key, err := decoder.Token()
				name, ok := key.(string)
				if err != nil || !ok || seen[name] || (!parameters && !fields[name]) {
					return false
				}
				seen[name] = true
				if !value(depth+1, !parameters && name == "params") {
					return false
				}
			}
			end, err := decoder.Token()
			return err == nil && end == json.Delim('}')
		case '[':
			for decoder.More() {
				if !value(depth+1, false) {
					return false
				}
			}
			end, err := decoder.Token()
			return err == nil && end == json.Delim(']')
		default:
			return false
		}
	}
	if !value(0, false) {
		return false
	}
	_, err := decoder.Token()
	return err == io.EOF
}

// PostgreSQL rejects unpaired UTF-16 escapes. Detect them before storage rather
// than replacing the user's recovery values or reporting a service failure.
func draftUnicodeEscapes(data []byte) bool {
	quoted := false
	for i := 0; i < len(data); i++ {
		if data[i] == '"' {
			quoted = !quoted
			continue
		}
		if !quoted || data[i] != '\\' {
			continue
		}
		i++
		if i >= len(data) {
			return false
		}
		if data[i] != 'u' {
			continue
		}
		if i+4 >= len(data) {
			return false
		}
		code, err := strconv.ParseUint(string(data[i+1:i+5]), 16, 16)
		if err != nil {
			return false
		}
		i += 4
		if code >= 0xdc00 && code <= 0xdfff {
			return false
		}
		if code >= 0xd800 && code <= 0xdbff {
			if i+6 >= len(data) || data[i+1] != '\\' || data[i+2] != 'u' {
				return false
			}
			low, err := strconv.ParseUint(string(data[i+3:i+7]), 16, 16)
			if err != nil || low < 0xdc00 || low > 0xdfff {
				return false
			}
			i += 6
		}
	}
	return !quoted
}
