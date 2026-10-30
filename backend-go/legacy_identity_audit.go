package main

import (
	"context"
	"database/sql"
	"fmt"

	"github.com/lib/pq"
)

// Identity checks cover fixed legacy tables with surrogate id columns. They
// never choose a surviving row, renumber IDs or infer account ownership.
func auditLegacyIdentities(ctx context.Context, tx *sql.Tx, schema string) (map[string]*int64, error) {
	return auditLegacyIdentityTables(ctx, tx, schema, []string{
		"users", "component_types", "component_params_template", "equipment_models", "equipment_model_params",
		"circuit_schemes", "scheme_components", "scheme_component_params", "scheme_connections", "circuit_nodes",
		"calculation_results", "calculation_node_results", "calculation_branch_results",
	})
}

func auditLegacyIdentityTables(ctx context.Context, tx *sql.Tx, schema string, tables []string) (map[string]*int64, error) {
	columns, err := legacyAuditColumns(ctx, tx, schema)
	if err != nil {
		return nil, err
	}
	counts := make(map[string]*int64)
	for _, table := range tables {
		prefix := table + ".id."
		for _, suffix := range []string{"null", "duplicateGroups", "duplicateRows"} {
			counts[prefix+suffix] = nil
		}
		if !columns[table+".id"] {
			continue
		}
		qualified := pq.QuoteIdentifier(schema) + "." + pq.QuoteIdentifier(table)
		var nulls, groups, duplicateRows int64
		// One grouped scan per table. NULL rows are separate; duplicateRows
		// includes all rows in non-NULL duplicate groups, not just the extras.
		err := tx.QueryRowContext(ctx, `SELECT
COALESCE(sum(n) FILTER (WHERE id IS NULL),0)::bigint,
count(*) FILTER (WHERE id IS NOT NULL AND n>1),
COALESCE(sum(n) FILTER (WHERE id IS NOT NULL AND n>1),0)::bigint
FROM (SELECT id,count(*) n FROM `+qualified+` GROUP BY id) g`).Scan(&nulls, &groups, &duplicateRows)
		if err != nil {
			return nil, fmt.Errorf("legacy identity check %s: %w", table, err)
		}
		counts[prefix+"null"] = &nulls
		counts[prefix+"duplicateGroups"] = &groups
		counts[prefix+"duplicateRows"] = &duplicateRows
	}
	return counts, nil
}
