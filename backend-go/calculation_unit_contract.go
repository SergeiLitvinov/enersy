package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"net/url"
)

const acInputUnitProfile = "legacy-ac-three-phase-rms-v1"

var errUnitContract = errors.New("invalid input unit contract")

type inputUnitContract struct {
	FormatVersion int    `json:"formatVersion"`
	Profile       string `json:"profile"`
}

func validInputUnitContract(value *inputUnitContract) bool {
	return value == nil || (value.FormatVersion == 1 && value.Profile == acInputUnitProfile)
}

func closedUnitContractObject(data []byte, names ...string) (map[string]json.RawMessage, error) {
	decoder := json.NewDecoder(bytes.NewReader(data))
	if token, err := decoder.Token(); err != nil || token != json.Delim('{') {
		return nil, errUnitContract
	}
	fields := map[string]json.RawMessage{}
	for decoder.More() {
		token, err := decoder.Token()
		key, ok := token.(string)
		allowed := false
		for _, name := range names {
			allowed = allowed || key == name
		}
		if err != nil || !ok || fields[key] != nil || !allowed {
			return nil, errUnitContract
		}
		var raw json.RawMessage
		if decoder.Decode(&raw) != nil {
			return nil, errUnitContract
		}
		fields[key] = raw
	}
	if _, err := decoder.Token(); err != nil || len(fields) != len(names) {
		return nil, errUnitContract
	}
	return fields, nil
}

func (value *inputUnitContract) UnmarshalJSON(data []byte) error {
	fields, err := closedUnitContractObject(data, "formatVersion", "profile")
	if err != nil {
		return err
	}
	var parsed inputUnitContract
	if json.Unmarshal(fields["formatVersion"], &parsed.FormatVersion) != nil || json.Unmarshal(fields["profile"], &parsed.Profile) != nil || !validInputUnitContract(&parsed) {
		return errUnitContract
	}
	*value = parsed
	return nil
}

func calculationUnitContractOption(query url.Values) (*inputUnitContract, error) {
	values, present := query["unitContract"]
	if !present {
		return nil, nil
	}
	if len(values) != 1 || values[0] != acInputUnitProfile {
		return nil, errUnitContract
	}
	return &inputUnitContract{1, acInputUnitProfile}, nil
}

// Empty maps must remain explicit in a complete declaration (e.g. a busbar
// without stored parameters). The legacy component encoding omits empty maps.
func applyInputUnitContract(payload map[string]any, contract *inputUnitContract, components []calculationComponent) {
	if contract == nil {
		return
	}
	type completeUnitComponent struct {
		calculationComponent
		Units map[string]string `json:"parameterUnits"`
	}
	values := make([]completeUnitComponent, len(components))
	for i, component := range components {
		units := component.ParameterUnits
		if units == nil {
			units = map[string]string{}
		}
		values[i] = completeUnitComponent{component, units}
	}
	payload["unitContract"] = contract
	payload["components"] = values
}

// A worker must acknowledge the exact selected profile and coverage. An older
// worker's generic success must never be archived as a strict-unit result.
func confirmsRequestedUnitContract(request, result []byte) bool {
	var input struct {
		Contract   *inputUnitContract     `json:"unitContract"`
		Components []calculationComponent `json:"components"`
	}
	if json.Unmarshal(request, &input) != nil {
		return false
	}
	if input.Contract == nil {
		return true
	}
	var output struct {
		Contract json.RawMessage `json:"input_unit_contract"`
	}
	if json.Unmarshal(result, &output) != nil {
		return false
	}
	if _, err := closedUnitContractObject(output.Contract, "formatVersion", "profile", "validation_scope", "component_count", "parameter_count"); err != nil {
		return false
	}
	var confirmation struct {
		FormatVersion int    `json:"formatVersion"`
		Profile       string `json:"profile"`
		Scope         string `json:"validation_scope"`
		Components    int    `json:"component_count"`
		Parameters    int    `json:"parameter_count"`
	}
	if json.Unmarshal(output.Contract, &confirmation) != nil {
		return false
	}
	parameters := 0
	for _, component := range input.Components {
		parameters += len(component.Params)
	}
	return confirmation.FormatVersion == input.Contract.FormatVersion && confirmation.Profile == input.Contract.Profile &&
		confirmation.Scope == "request-declarations-only" && confirmation.Components == len(input.Components) && confirmation.Parameters == parameters
}
