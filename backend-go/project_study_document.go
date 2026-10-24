package main

import (
	"encoding/json"
	"errors"
	"math"
)

var errStudyInput = errors.New("invalid Study request")
var errStudyConflict = errors.New("Study revision conflict")
var errStudyTopology = errors.New("Study source topology conflict")
var errStudyCommand = errors.New("Study command reused with different input")
var errStudyQuota = errors.New("Study project quota exceeded")

type studyBase struct {
	Power   float64 `json:"s_base_mva"`
	Voltage float64 `json:"v_base_kv"`
}
type studySolverOptions struct {
	Tolerance     float64 `json:"tolerance"`
	MaxIterations int     `json:"max_iterations"`
}
type studyDocument struct {
	FormatVersion  int                    `json:"formatVersion"`
	Name           string                 `json:"name"`
	ModelGroup     string                 `json:"modelGroup"`
	Method         string                 `json:"method"`
	ComputeBackend string                 `json:"computeBackend"`
	MaxTimeMS      int64                  `json:"maxTimeMs"`
	Base           studyBase              `json:"base"`
	Solver         studySolverOptions     `json:"solverOptions"`
	Limits         []terminalVoltageLimit `json:"operatingLimits"`
}

func positiveStudyNumber(value float64) bool {
	return value > 0 && !math.IsNaN(value) && !math.IsInf(value, 0)
}
func validateStudyDocument(doc studyDocument) error {
	if doc.FormatVersion != 1 || !passportText(doc.Name, 200, true) || doc.ModelGroup != "three-phase" || doc.Method != "newton-raphson" ||
		(doc.ComputeBackend != "julia" && doc.ComputeBackend != "julia-rust-jacobian") || doc.MaxTimeMS < 1 || doc.MaxTimeMS > 20000 ||
		!positiveStudyNumber(doc.Base.Power) || !positiveStudyNumber(doc.Base.Voltage) || !positiveStudyNumber(doc.Solver.Tolerance) ||
		doc.Solver.MaxIterations < 1 || doc.Solver.MaxIterations > 1000 || doc.Limits == nil || len(doc.Limits) > 1000 {
		return errStudyInput
	}
	seen := map[[2]int]bool{}
	for _, limit := range doc.Limits {
		key := [2]int{limit.ComponentID, limit.Terminal}
		if limit.ComponentID <= 0 || limit.ComponentID > math.MaxInt32 || limit.Terminal <= 0 || limit.Terminal > math.MaxInt32 ||
			!positiveStudyNumber(limit.MinKV) || !positiveStudyNumber(limit.MaxKV) || limit.MaxKV < limit.MinKV || seen[key] {
			return errStudyInput
		}
		seen[key] = true
	}
	return nil
}

func studyWorkerInput(input calculationInput, doc studyDocument, id, revision string) ([]byte, error) {
	return json.Marshal(map[string]any{
		"components": input.Components, "connections": input.Connections, "modelGroup": doc.ModelGroup, "method": doc.Method,
		"computeBackend": doc.ComputeBackend, "executionOptions": map[string]int64{"max_time_ms": doc.MaxTimeMS},
		"base": doc.Base, "solverOptions": doc.Solver, "operatingLimits": doc.Limits,
		"studyReference": map[string]any{"formatVersion": 1, "id": id, "revision": revision},
	})
}
