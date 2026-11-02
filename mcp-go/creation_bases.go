package main

import (
	"encoding/json"
	"math"
)

type creationBase struct {
	Profile  string  `json:"profile"`
	SBaseMVA float64 `json:"s_base_mva"`
	VBaseKV  float64 `json:"v_base_kv"`
}

func (units *creationUnits) UnmarshalJSON(raw []byte) error {
	var fields map[string]json.RawMessage
	if !validJSON(raw) || json.Unmarshal(raw, &fields) != nil {
		return errAPI
	}
	type wire creationUnits
	var value wire
	if json.Unmarshal(raw, &value) != nil || fields["formatVersion"] == nil || fields["units"] == nil {
		return errAPI
	}
	if value.FormatVersion == 1 {
		if len(fields) != 2 {
			return errAPI
		}
	} else if value.FormatVersion == 2 {
		if len(fields) != 3 || fields["bases"] == nil {
			return errAPI
		}
	} else {
		return errAPI
	}
	*units = creationUnits(value)
	return nil
}

func (base *creationBase) UnmarshalJSON(raw []byte) error {
	var fields map[string]json.RawMessage
	if !validJSON(raw) || json.Unmarshal(raw, &fields) != nil || len(fields) != 3 || fields["profile"] == nil || fields["s_base_mva"] == nil || fields["v_base_kv"] == nil {
		return errAPI
	}
	type wire creationBase
	var value wire
	if json.Unmarshal(raw, &value) != nil || value.Profile != "ac-three-phase-rms-v1" ||
		value.SBaseMVA <= 0 || value.VBaseKV <= 0 || math.IsInf(value.SBaseMVA, 0) || math.IsInf(value.VBaseKV, 0) ||
		math.IsNaN(value.SBaseMVA) || math.IsNaN(value.VBaseKV) {
		return errAPI
	}
	*base = creationBase(value)
	return nil
}

func validCreationUnits(units *creationUnits, stored bool) bool {
	if units == nil || len(units.Units) == 0 {
		return false
	}
	if units.FormatVersion == 1 {
		return len(units.Bases) == 0
	}
	if units.FormatVersion != 2 || len(units.Bases) == 0 {
		return false
	}
	for key, base := range units.Bases {
		if units.Units[key] != "p.u." || stored && base == nil {
			return false
		}
	}
	return true
}
