package main

import (
	"encoding/json"
	"fmt"
	"strings"
	"unicode"
	"unicode/utf8"
)

// This versions the declaration format, not a mathematical model or evidence
// that a stated unit is physically correct. Solvers validate their own profile.
type parameterUnitDeclaration struct {
	FormatVersion int               `json:"formatVersion"`
	Units         map[string]string `json:"units"`
}

func parseParameterUnitDeclaration(raw []byte, params map[string]string) (*parameterUnitDeclaration, error) {
	fields, err := closedUnitContractObject(raw, "formatVersion", "units")
	if err != nil {
		return nil, fmt.Errorf("Некорректная декларация единиц")
	}
	var value parameterUnitDeclaration
	if json.Unmarshal(fields["formatVersion"], &value.FormatVersion) != nil || value.FormatVersion != 1 ||
		json.Unmarshal(fields["units"], &value.Units) != nil || len(value.Units) == 0 || len(value.Units) > 256 {
		return nil, fmt.Errorf("Некорректная версия или состав декларации единиц")
	}
	keys := make([]string, 0, len(value.Units))
	for key, unit := range value.Units {
		if _, supplied := params[key]; !supplied {
			return nil, fmt.Errorf("Единица требует значение параметра в том же изменении")
		}
		if !validParameterUnitLabel(unit) {
			return nil, fmt.Errorf("Некорректное обозначение единицы")
		}

		keys = append(keys, key)
	}
	if _, err := closedUnitContractObject(fields["units"], keys...); err != nil {
		return nil, fmt.Errorf("Повторяющиеся ключи декларации единиц")
	}
	return &value, nil
}

func validParameterUnitLabel(unit string) bool {
	if !utf8.ValidString(unit) || utf8.RuneCountInString(unit) > 64 || strings.TrimSpace(unit) != unit || strings.Trim(unit, "\uFEFF") != unit || unit == "" {
		return false
	}
	for _, c := range unit {
		if unicode.IsControl(c) {
			return false
		}
	}
	return true
}
