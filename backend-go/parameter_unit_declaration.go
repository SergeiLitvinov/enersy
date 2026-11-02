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
	FormatVersion int                       `json:"formatVersion"`
	Units         map[string]string         `json:"units"`
	Bases         map[string]*parameterBase `json:"bases,omitempty"`
}

func parseParameterUnitDeclaration(raw []byte, params map[string]string) (*parameterUnitDeclaration, error) {
	if !utf8.Valid(raw) || !draftUnicodeEscapes(raw) {
		return nil, fmt.Errorf("Некорректный Unicode в декларации единиц")
	}
	var version struct {
		FormatVersion int `json:"formatVersion"`
	}
	if json.Unmarshal(raw, &version) != nil || version.FormatVersion != 1 && version.FormatVersion != 2 {
		return nil, fmt.Errorf("Неподдержанная версия декларации единиц")
	}
	allowed := []string{"formatVersion", "units"}
	if version.FormatVersion == 2 {
		allowed = append(allowed, "bases")
	}
	fields, err := closedUnitContractObject(raw, allowed...)
	if err != nil {
		return nil, fmt.Errorf("Некорректная декларация единиц")
	}
	var value parameterUnitDeclaration
	if json.Unmarshal(fields["formatVersion"], &value.FormatVersion) != nil ||
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
	if value.FormatVersion == 2 {
		if json.Unmarshal(fields["bases"], &value.Bases) != nil || len(value.Bases) == 0 || len(value.Bases) > 256 {
			return nil, fmt.Errorf("Ожидаются явные базисы декларации v2")
		}
		baseKeys := make([]string, 0, len(value.Bases))
		for key := range value.Bases {
			if value.Units[key] != "p.u." {
				return nil, fmt.Errorf("Базис требует p.u. и явное значение того же параметра")
			}
			baseKeys = append(baseKeys, key)
		}
		if _, err := closedUnitContractObject(fields["bases"], baseKeys...); err != nil {
			return nil, fmt.Errorf("Повторяющиеся ключи базисов")
		}
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
