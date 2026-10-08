package main

import (
	"context"
	"encoding/json"
	"fmt"
	"math"
	"os"
	"runtime"
	"sort"
	"testing"
	"time"
)

// Opt-in storage profile. No worker, physical solver, or user database is used.
func TestCalculationSnapshotProfilePostgres(t *testing.T) {
	output := os.Getenv("ENERSY_SNAPSHOT_PROFILE_OUTPUT")
	if output == "" {
		t.Skip("Set ENERSY_SNAPSHOT_PROFILE_OUTPUT and TEST_DATABASE_URL for storage profiling")
	}
	if os.Getenv("TEST_DATABASE_URL") == "" {
		t.Fatal("Storage profiling requires an explicit disposable TEST_DATABASE_URL")
	}
	type sample struct {
		Milliseconds   float64 `json:"milliseconds"`
		AllocatedBytes uint64  `json:"allocated_bytes"`
	}
	type measurement struct {
		Components        int      `json:"components"`
		Connections       int      `json:"connections"`
		FirstRead         sample   `json:"first_read"`
		Samples           []sample `json:"samples"`
		P50Milliseconds   float64  `json:"p50_milliseconds"`
		P95Milliseconds   float64  `json:"p95_milliseconds"`
		P50AllocatedBytes float64  `json:"p50_allocated_bytes"`
	}
	report := struct {
		StartedUTC   string        `json:"started_utc"`
		Version      string        `json:"contract"`
		Go           string        `json:"go"`
		OS           string        `json:"os"`
		Arch         string        `json:"arch"`
		CPUs         int           `json:"visible_cpus"`
		GoProcs      int           `json:"gomaxprocs"`
		PostgreSQL   string        `json:"postgresql"`
		Fixture      string        `json:"fixture"`
		Measurements []measurement `json:"measurements"`
	}{StartedUTC: time.Now().UTC().Format(time.RFC3339), Version: "enersy.storage-snapshot-profile.v1", Go: runtime.Version(), OS: runtime.GOOS, Arch: runtime.GOARCH, CPUs: runtime.NumCPU(), GoProcs: runtime.GOMAXPROCS(0), Fixture: "deterministic busbar chain, IDs 1..N, voltage_nom=110 kV, N-1 right-to-left links; storage only"}
	percentile := func(values []float64, fraction float64) float64 {
		sort.Float64s(values)
		return values[int(math.Ceil(fraction*float64(len(values))))-1]
	}
	for _, count := range []int{1000, 10000, 100000} {
		t.Run(fmt.Sprint(count), func(t *testing.T) {
			database := migrationTestDatabase(t)
			if err := runMigrationsFromSource(database, migrationSourceURL(t)); err != nil {
				t.Fatal(err)
			}
			database.SetMaxOpenConns(1)
			if err := database.QueryRow(`SELECT version()`).Scan(&report.PostgreSQL); err != nil {
				t.Fatal(err)
			}
			ctx, cancel := context.WithTimeout(context.Background(), 3*time.Minute)
			defer cancel()
			if _, err := database.ExecContext(ctx, `INSERT INTO circuit_schemes(id,name) VALUES(1,'Disposable snapshot profile')`); err != nil {
				t.Fatal(err)
			}
			if _, err := database.ExecContext(ctx, `
 INSERT INTO scheme_components(id,scheme_id,component_type_id,pos_x,pos_y,rotation)
 SELECT n,1,ct.id,n,0,0 FROM generate_series(1,$1::integer) n
 CROSS JOIN component_types ct WHERE ct.code='busbar'`, count); err != nil {
				t.Fatal(err)
			}
			if _, err := database.ExecContext(ctx, `INSERT INTO scheme_component_params(scheme_component_id,param_key,param_value)
 SELECT id,'voltage_nom','110' FROM scheme_components`); err != nil {
				t.Fatal(err)
			}
			if _, err := database.ExecContext(ctx, `
 INSERT INTO scheme_connections(scheme_id,from_component_id,to_component_id,from_port,to_port)
 SELECT 1,id,id+1,'right','left' FROM scheme_components WHERE id < $1`, count); err != nil {
				t.Fatal(err)
			}
			if _, err := database.ExecContext(ctx, `ANALYZE scheme_components; ANALYZE scheme_component_params; ANALYZE scheme_connections;`); err != nil {
				t.Fatal(err)
			}
			read := func() sample {
				runtime.GC() // Excluded from timing; allocation counter covers only the read.
				var before, after runtime.MemStats
				runtime.ReadMemStats(&before)
				started := time.Now()
				input, err := readCalculationInput(ctx, database, 1)
				elapsed := time.Since(started)
				runtime.ReadMemStats(&after)
				if err != nil {
					t.Fatal(err)
				}
				// Validate all values outside the timing; don't accept fast partial reads.
				if len(input.Components) != count || len(input.Connections) != count-1 {
					t.Fatalf("partial snapshot: %d/%d", len(input.Components), len(input.Connections))
				}
				seen := make([]bool, count+1)
				for _, component := range input.Components {
					if component.ID < 1 || component.ID > count || seen[component.ID] || component.Type != "busbar" || component.X != float64(component.ID) || component.Y != 0 || component.Rotation != 0 || len(component.Params) != 1 || component.Params["voltage_nom"] != "110" {
						t.Fatalf("incorrect component: %+v", component)
					}
					seen[component.ID] = true
				}
				links := make([]bool, count)
				for _, connection := range input.Connections {
					if connection.From < 1 || connection.From >= count || links[connection.From] || connection.To != connection.From+1 || connection.FromPort != "right" || connection.ToPort != "left" {
						t.Fatalf("incorrect connection: %+v", connection)
					}
					links[connection.From] = true
				}
				return sample{Milliseconds: float64(elapsed) / float64(time.Millisecond), AllocatedBytes: after.TotalAlloc - before.TotalAlloc}
			}
			result := measurement{Components: count, Connections: count - 1, FirstRead: read()}
			times, allocations := make([]float64, 0, 20), make([]float64, 0, 20)
			for i := 0; i < 20; i++ {
				value := read()
				result.Samples = append(result.Samples, value)
				times = append(times, value.Milliseconds)
				allocations = append(allocations, float64(value.AllocatedBytes))
			}
			result.P50Milliseconds = percentile(times, .50)
			result.P95Milliseconds = percentile(times, .95)
			result.P50AllocatedBytes = percentile(allocations, .50)
			report.Measurements = append(report.Measurements, result)
			t.Logf("N=%d links=%d first=%.3f ms p50=%.3f ms p95=%.3f ms allocated-p50=%.0f B/read", count, count-1, result.FirstRead.Milliseconds, result.P50Milliseconds, result.P95Milliseconds, result.P50AllocatedBytes)
		})
	}
	if t.Failed() {
		return
	} // Never publish a partial successful-looking report.
	encoded, err := json.MarshalIndent(report, "", "  ")
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(output, append(encoded, '\n'), 0600); err != nil {
		t.Fatal(err)
	}
}
