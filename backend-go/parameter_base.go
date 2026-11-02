package main

import (
	"encoding/json"
	"fmt"
	"math"
)

const parameterBaseProfile = "ac-three-phase-rms-v1"

// Source representation of one coefficient, independent of the Study base.
// Power is three-phase MVA; voltage is line-to-line RMS kV.
type parameterBase struct {
	Profile  string  `json:"profile"`
	SBaseMVA float64 `json:"s_base_mva"`
	VBaseKV  float64 `json:"v_base_kv"`
}

func (base parameterBase) valid() bool {
	return base.Profile == parameterBaseProfile && base.SBaseMVA > 0 && base.VBaseKV > 0 &&
		!math.IsInf(base.SBaseMVA, 0) && !math.IsNaN(base.SBaseMVA) && !math.IsInf(base.VBaseKV, 0) && !math.IsNaN(base.VBaseKV)
}

func (base *parameterBase) UnmarshalJSON(raw []byte) error {
	fields, err := closedUnitContractObject(raw, "profile", "s_base_mva", "v_base_kv")
	if err != nil || len(fields) != 3 {
		return fmt.Errorf("ожидаются профиль и два явных базиса")
	}
	type wire parameterBase
	var value wire
	if json.Unmarshal(raw, &value) != nil || !parameterBase(value).valid() {
		return fmt.Errorf("некорректный исходный базис относительной величины")
	}
	*base = parameterBase(value)
	return nil
}

func parameterUnits(units map[string]string, bases map[string]*parameterBase) *parameterUnitDeclaration {
	if len(units) == 0 {
		return nil
	}
	value := &parameterUnitDeclaration{FormatVersion: 1, Units: make(map[string]string, len(units))}
	for key, unit := range units {
		value.Units[key] = unit
	}
	for key, base := range bases {
		if base == nil {
			continue
		}
		if value.Bases == nil {
			value.Bases = map[string]*parameterBase{}
		}
		cloned := *base
		value.Bases[key] = &cloned
	}
	if len(value.Bases) > 0 {
		value.FormatVersion = 2
	}
	return value
}

func decodeParameterUnits(unitsJSON, basesJSON []byte) (*parameterUnitDeclaration, error) {
	var units map[string]string
	var bases map[string]*parameterBase
	if err := json.Unmarshal(unitsJSON, &units); err != nil {
		return nil, err
	}
	if err := json.Unmarshal(basesJSON, &bases); err != nil {
		return nil, err
	}
	return parameterUnits(units, bases), nil
}

func mergeParameterUnits(original, override *parameterUnitDeclaration) *parameterUnitDeclaration {
	units, bases := map[string]string{}, map[string]*parameterBase{}
	if original != nil {
		for key, unit := range original.Units {
			units[key] = unit
		}
		for key, base := range original.Bases {
			bases[key] = base
		}
	}
	if override != nil {
		for key, unit := range override.Units {
			units[key] = unit
			if unit != "p.u." {
				delete(bases, key)
			}
		}
		for key, base := range override.Bases {
			if base == nil {
				delete(bases, key)
			} else {
				bases[key] = base
			}
		}
	}
	return parameterUnits(units, bases)
}

// Presence is distinct from nil: explicit null clears a basis; absence retains
// the basis for a value edit in the same unit. A dimensional label clears it.
func parameterBaseSQL(declaration *parameterUnitDeclaration, key string) (bool, any, any, any) {
	if declaration == nil {
		return false, nil, nil, nil
	}
	base, present := declaration.Bases[key]
	if !present || base == nil {
		return present, nil, nil, nil
	}
	return true, base.Profile, base.SBaseMVA, base.VBaseKV
}
