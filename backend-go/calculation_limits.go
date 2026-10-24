package main

import (
	"encoding/json"
	"errors"
	"io"
	"math"
	"net/http"
)

type terminalVoltageLimit struct {
	ComponentID int     `json:"component_id"`
	Terminal    int     `json:"terminal"`
	MinKV       float64 `json:"min_kv"`
	MaxKV       float64 `json:"max_kv"`
}

// Only study parameters may come from the caller. Equipment, topology, account
// and model snapshots remain server-owned. Empty legacy requests retain bytes.
func readCalculationLimits(w http.ResponseWriter, r *http.Request) ([]terminalVoltageLimit, bool) {
	body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, 128<<10))
	if err != nil {
		var oversized *http.MaxBytesError
		status := http.StatusBadRequest
		if errors.As(err, &oversized) {
			status = http.StatusRequestEntityTooLarge
		}
		sendError(w, "Could not read calculation options", status)
		return nil, false
	}
	if len(body) == 0 {
		return nil, true
	}
	var fields map[string]json.RawMessage
	var entries []map[string]json.RawMessage
	if json.Unmarshal(body, &fields) != nil || len(fields) != 1 ||
		json.Unmarshal(fields["operatingLimits"], &entries) != nil || entries == nil || len(entries) > 1000 {
		sendError(w, "Expected operatingLimits array with at most 1000 terminal voltage limits", 400)
		return nil, false
	}
	limits := make([]terminalVoltageLimit, 0, len(entries))
	seen := map[[2]int]bool{}
	for _, fields := range entries {
		var value terminalVoltageLimit
		if len(fields) != 4 || json.Unmarshal(fields["component_id"], &value.ComponentID) != nil ||
			json.Unmarshal(fields["terminal"], &value.Terminal) != nil ||
			json.Unmarshal(fields["min_kv"], &value.MinKV) != nil || json.Unmarshal(fields["max_kv"], &value.MaxKV) != nil ||
			value.ComponentID <= 0 || value.ComponentID > math.MaxInt32 || value.Terminal <= 0 || value.Terminal > math.MaxInt32 ||
			value.MinKV <= 0 || value.MaxKV < value.MinKV || math.IsInf(value.MaxKV, 0) {
			sendError(w, "Invalid terminal voltage limit; positive IDs and ordered positive kV bounds required", 400)
			return nil, false
		}
		key := [2]int{value.ComponentID, value.Terminal}
		if seen[key] {
			sendError(w, "Duplicate terminal voltage limit", 400)
			return nil, false
		}
		seen[key] = true
		limits = append(limits, value)
	}
	return limits, true
}

// Never publish/archive a nominal success from a worker which ignored or
// altered explicit caller limits. This checks confirmation, not new physics.
func confirmsCalculationLimits(body []byte, limits []terminalVoltageLimit) bool {
	if limits == nil {
		return true
	}
	var result struct {
		Assessment struct {
			Version   int    `json:"schema_version"`
			Policy    string `json:"policy"`
			Status    string `json:"status"`
			Stability *bool  `json:"stability_assessed"`
			Checks    []struct {
				ComponentID int     `json:"component_id"`
				Terminal    int     `json:"terminal"`
				Bus         int     `json:"bus_id"`
				Min         float64 `json:"min"`
				Max         float64 `json:"max"`
				Measured    float64 `json:"measured"`
				Status      string  `json:"status"`
				Unit        string  `json:"unit"`
				Quantity    string  `json:"quantity"`
			} `json:"checks"`
		} `json:"operating_assessment"`
		Nodes []struct {
			ID      int     `json:"node_id"`
			Voltage float64 `json:"voltage"`
		} `json:"nodes"`
		Topology struct {
			Terminals []struct {
				ComponentID int  `json:"component_id"`
				Terminal    int  `json:"terminal"`
				Bus         *int `json:"bus_id"`
			} `json:"terminals"`
		} `json:"topology"`
	}
	if json.Unmarshal(body, &result) != nil {
		return false
	}
	a := result.Assessment
	if a.Version != 1 || a.Policy != "explicit-terminal-voltage-v1" || a.Stability == nil || *a.Stability || a.Checks == nil || len(a.Checks) != len(limits) {
		return false
	}
	nodes := map[int]float64{}
	for _, node := range result.Nodes {
		nodes[node.ID] = node.Voltage
	}
	bindings := map[[2]int]int{}
	for _, terminal := range result.Topology.Terminals {
		if terminal.Bus != nil {
			bindings[[2]int{terminal.ComponentID, terminal.Terminal}] = *terminal.Bus
		}
	}
	expected := map[[2]int]terminalVoltageLimit{}
	for _, limit := range limits {
		expected[[2]int{limit.ComponentID, limit.Terminal}] = limit
	}
	status := "within_declared_bounds"
	if len(limits) == 0 {
		status = "not_declared"
	}
	for _, check := range a.Checks {
		key := [2]int{check.ComponentID, check.Terminal}
		limit, found := expected[key]
		voltage, hasNode := nodes[check.Bus]
		if !found || check.Min != limit.MinKV || check.Max != limit.MaxKV || !hasNode || check.Measured <= 0 || check.Measured != voltage || bindings[key] != check.Bus ||
			check.Unit != "kV" || check.Quantity != "line_to_line_rms_voltage" {
			return false
		}
		delete(expected, key)
		individual := "within_bounds"
		if check.Measured < limit.MinKV {
			individual = "below_min"
		} else if check.Measured > limit.MaxKV {
			individual = "above_max"
		}
		if individual != "within_bounds" {
			status = "violated"
		}
		if individual != check.Status {
			return false
		}
	}
	return a.Status == status
}

func limitTargetsBelongToInput(limits []terminalVoltageLimit, input calculationInput) bool {
	if len(limits) == 0 {
		return true
	}
	ids := map[int]bool{}
	for _, component := range input.Components {
		ids[component.ID] = true
	}
	for _, limit := range limits {
		if !ids[limit.ComponentID] {
			return false
		}
	}
	return true
}
