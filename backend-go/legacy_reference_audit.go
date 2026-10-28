package main

import (
	"context"
	"database/sql"
	"fmt"

	"github.com/lib/pq"
)

// Fixed legacy relationships only: no claim about external files, arbitrary
// extension tables or modern authorization. NULL is reported separately from
// a non-NULL reference whose target is absent.
func auditLegacyReferences(ctx context.Context, tx *sql.Tx, schema string) (map[string]*int64, error) {
	columns := map[string]bool{}
	rows, err := tx.QueryContext(ctx, `SELECT c.table_name,c.column_name FROM information_schema.columns c
		JOIN pg_namespace n ON n.nspname=c.table_schema JOIN pg_class t ON t.relnamespace=n.oid AND t.relname=c.table_name
		WHERE c.table_schema=$1 AND t.relkind IN ('r','p')`, schema)
	if err != nil {
		return nil, err
	}
	for rows.Next() {
		var table, column string
		if err = rows.Scan(&table, &column); err != nil {
			rows.Close()
			return nil, err
		}
		columns[table+"."+column] = true
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return nil, err
	}
	qualified := func(table string) string { return pq.QuoteIdentifier(schema) + "." + pq.QuoteIdentifier(table) }
	type relation struct{ table, column, target string }
	relations := []relation{
		{"component_params_template", "component_type_id", "component_types"},
		{"equipment_models", "component_type_id", "component_types"},
		{"equipment_model_params", "equipment_model_id", "equipment_models"},
		{"scheme_components", "scheme_id", "circuit_schemes"},
		{"scheme_components", "component_type_id", "component_types"},
		{"scheme_component_params", "scheme_component_id", "scheme_components"},
		{"scheme_connections", "scheme_id", "circuit_schemes"},
		{"scheme_connections", "from_component_id", "scheme_components"},
		{"scheme_connections", "to_component_id", "scheme_components"},
		{"circuit_nodes", "scheme_id", "circuit_schemes"},
		{"calculation_results", "scheme_id", "circuit_schemes"},
		{"calculation_node_results", "calculation_id", "calculation_results"},
		{"calculation_node_results", "node_id", "circuit_nodes"},
		{"calculation_branch_results", "calculation_id", "calculation_results"},
		{"calculation_branch_results", "from_component_id", "scheme_components"},
		{"calculation_branch_results", "to_component_id", "scheme_components"},
	}
	counts := map[string]*int64{}
	check := func(key, query string, required ...string) error {
		counts[key] = nil
		for _, column := range required {
			if !columns[column] {
				return nil
			}
		}
		var count int64
		if err := tx.QueryRowContext(ctx, query).Scan(&count); err != nil {
			return fmt.Errorf("legacy reference check %s: %w", key, err)
		}
		counts[key] = &count
		return nil
	}
	for _, r := range relations {
		key := r.table + "." + r.column
		column := pq.QuoteIdentifier(r.column)
		if err := check(key+".null", `SELECT count(*) FROM `+qualified(r.table)+` s WHERE s.`+column+` IS NULL`, key); err != nil {
			return nil, err
		}
		if err := check(key+".dangling", `SELECT count(*) FROM `+qualified(r.table)+` s LEFT JOIN `+qualified(r.target)+` t ON t.id=s.`+column+` WHERE s.`+column+` IS NOT NULL AND t.id IS NULL`, key, r.target+".id"); err != nil {
			return nil, err
		}
	}
	// Both referenced rows may exist while belonging to different schemes.
	for _, r := range []struct{ code, result, targetColumn, target string }{
		{"nodeResults.schemeMismatch", "calculation_node_results", "node_id", "circuit_nodes"},
		{"branchResults.fromSchemeMismatch", "calculation_branch_results", "from_component_id", "scheme_components"},
		{"branchResults.toSchemeMismatch", "calculation_branch_results", "to_component_id", "scheme_components"},
	} {
		if err := check(r.code, `SELECT count(*) FROM `+qualified(r.result)+` r JOIN `+qualified("calculation_results")+` c ON c.id=r.calculation_id JOIN `+qualified(r.target)+` t ON t.id=r.`+pq.QuoteIdentifier(r.targetColumn)+` WHERE c.scheme_id<>t.scheme_id`,
			r.result+".calculation_id", r.result+"."+r.targetColumn, "calculation_results.id", "calculation_results.scheme_id", r.target+".id", r.target+".scheme_id"); err != nil {
			return nil, err
		}
	}
	for _, column := range []string{"from_component_id", "to_component_id"} {
		if err := check("scheme_connections."+column+".schemeMismatch", `SELECT count(*) FROM `+qualified("scheme_connections")+` c JOIN `+qualified("scheme_components")+` t ON t.id=c.`+pq.QuoteIdentifier(column)+` WHERE c.scheme_id<>t.scheme_id`,
			"scheme_connections."+column, "scheme_connections.scheme_id", "scheme_components.id", "scheme_components.scheme_id"); err != nil {
			return nil, err
		}
	}
	return counts, nil
}
