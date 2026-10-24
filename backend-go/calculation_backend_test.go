package main

import (
	"net/url"
	"testing"
)

func TestCalculationBackendOption(t *testing.T) {
	for _, value := range []string{"julia", "julia-rust-jacobian"} {
		got, err := calculationBackendOption(url.Values{"computeBackend": {value}})
		if err != nil || got != value {
			t.Fatalf("explicit backend lost: %q, %v", got, err)
		}
	}
	if got, err := calculationBackendOption(url.Values{}); err != nil || got != "" {
		t.Fatalf("omitted backend must preserve legacy snapshot: %q, %v", got, err)
	}
	for _, values := range [][]string{nil, {}, {""}, {"/tmp/lib.so"}, {"JULIA"}, {"julia", "julia-rust-jacobian"}} {
		if _, err := calculationBackendOption(url.Values{"computeBackend": values}); err == nil {
			t.Fatalf("accepted invalid backend option: %q", values)
		}
	}
}

func TestCalculationExecutionOption(t *testing.T) {
	if budget, err := calculationExecutionOption(url.Values{}); err != nil || budget != 0 {
		t.Fatalf("omitted budget changed legacy request bytes: %d %v", budget, err)
	}
	for _, value := range []string{"1", "20000"} {
		if budget, err := calculationExecutionOption(url.Values{"maxTimeMs": {value}}); err != nil || budget < 1 {
			t.Fatalf("valid budget rejected: %q %d %v", value, budget, err)
		}
	}
	for _, values := range [][]string{nil, {}, {""}, {"0"}, {"-1"}, {"20001"}, {"1.5"}, {"01"}, {"+1"}, {" 1"}, {"999999999999999999999999999"}, {"1", "2"}} {
		if _, err := calculationExecutionOption(url.Values{"maxTimeMs": values}); err == nil {
			t.Fatalf("invalid budget accepted: %q", values)
		}
	}
}
