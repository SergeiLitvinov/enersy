package main

import (
	"bytes"
	"encoding/json"
	"fmt"
)

// Unlike decoding directly into map[string]string, null must not silently
// become an empty string. Reject ambiguous duplicate keys before intent hashing.
type creationParameters map[string]string

func (params *creationParameters) UnmarshalJSON(raw []byte) error {
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(raw, &fields); err != nil || fields == nil {
		return fmt.Errorf("Параметры создания должны быть JSON-объектом строк")
	}
	values := make(creationParameters, len(fields))
	keys := make([]string, 0, len(fields))
	for key, rawValue := range fields {
		var value string
		if bytes.Equal(bytes.TrimSpace(rawValue), []byte("null")) || json.Unmarshal(rawValue, &value) != nil {
			return fmt.Errorf("Значение параметра создания должно быть строкой, null недопустим")
		}
		values[key] = value
		keys = append(keys, key)
	}
	if _, err := closedUnitContractObject(raw, keys...); err != nil {
		return fmt.Errorf("Повторяющиеся ключи параметров создания")
	}
	*params = values
	return nil
}

func (req *createComponentRequest) UnmarshalJSON(raw []byte) error {
	type requestFields createComponentRequest
	var input struct {
		requestFields
		Params creationParameters `json:"params"`
	}
	if err := json.Unmarshal(raw, &input); err != nil {
		return err
	}
	*req = createComponentRequest(input.requestFields)
	req.Params = map[string]string(input.Params)
	return nil
}

// A value wrapper distinguishes an omitted declaration from explicit JSON null.
// omitzero keeps the durable intent of older commands byte-for-byte unchanged.
// MarshalJSON emits the parsed map, not caller key order or raw JSON whitespace.
type creationUnitDeclaration struct {
	declaration *parameterUnitDeclaration
}

func (value creationUnitDeclaration) IsZero() bool { return value.declaration == nil }

func (value creationUnitDeclaration) MarshalJSON() ([]byte, error) {
	return json.Marshal(value.declaration)
}

func (value *creationUnitDeclaration) UnmarshalJSON(raw []byte) error {
	// Extract only keys for the shared closed-object/duplicate/label validator.
	// Actual value co-presence is checked after the whole request is decoded.
	var keys struct {
		Units map[string]json.RawMessage `json:"units"`
	}
	if err := json.Unmarshal(raw, &keys); err != nil {
		return err
	}
	params := make(map[string]string, len(keys.Units))
	for key := range keys.Units {
		params[key] = ""
	}
	declaration, err := parseParameterUnitDeclaration(raw, params)
	if err != nil {
		return err
	}
	value.declaration = declaration
	return nil
}

func (value creationUnitDeclaration) validate(params map[string]string) error {
	declaration := value.declaration
	if declaration == nil {
		return nil
	}
	if declaration.FormatVersion != 1 && declaration.FormatVersion != 2 || len(declaration.Units) == 0 || len(declaration.Units) > 256 {
		return fmt.Errorf("Некорректная декларация единиц создания оборудования")
	}
	if declaration.FormatVersion == 1 && len(declaration.Bases) != 0 || declaration.FormatVersion == 2 && (len(declaration.Bases) == 0 || len(declaration.Bases) > 256) {
		return fmt.Errorf("Базисы требуют декларацию v2")
	}
	for key, base := range declaration.Bases {
		if declaration.Units[key] != "p.u." || base != nil && !base.valid() {
			return fmt.Errorf("Некорректный базис параметра")
		}
	}
	for key, unit := range declaration.Units {
		if _, supplied := params[key]; !supplied {
			return fmt.Errorf("Единица требует явное значение параметра в том же запросе создания")
		}
		if !validParameterUnitLabel(unit) {
			return fmt.Errorf("Некорректное обозначение единицы")
		}
	}
	return nil
}

// Never infer shared-catalog units from today's template. Only immutable
// passport declarations and explicit value/unit pairs can enter the instance.
func creationParameterUnits(req createComponentRequest) *parameterUnitDeclaration {
	return mergeParameterUnits(req.unitDeclaration, req.UnitDeclaration.declaration)
}
