package main

import (
	"context"
	"database/sql"
	"fmt"

	"github.com/lib/pq"
)

// Inventory declared incoming FKs, including other schemas. This is metadata,
// not proof that unconstrained references, files or application links are absent.
// Partition-generated copies are excluded; independent constraints remain counted.
func auditLegacyDependencies(ctx context.Context, tx *sql.Tx, schema string) (map[string]*int64, error) {
	counts := map[string]*int64{}
	sources := append(legacyIdentityTables(), "component_type_ports")
	for _, table := range legacyIdentityTables() {
		for _, suffix := range []string{"total", "unvalidated", "otherRelations"} {
			counts[table+".incomingFKs."+suffix] = nil
		}
		var present, total, unvalidated, other int64
		err := tx.QueryRowContext(ctx, `SELECT count(DISTINCT target.oid),
count(fk.oid),
count(fk.oid) FILTER (WHERE NOT fk.convalidated),
count(fk.oid) FILTER (WHERE source.relnamespace<>target.relnamespace OR source.relname<>ALL($3::text[]))
FROM pg_class target JOIN pg_namespace n ON n.oid=target.relnamespace
LEFT JOIN pg_constraint fk ON fk.confrelid=target.oid AND fk.contype='f' AND fk.conparentid=0
LEFT JOIN pg_class source ON source.oid=fk.conrelid
WHERE n.nspname=$1 AND target.relname=$2 AND target.relkind IN ('r','p')`, schema, table, pq.Array(sources)).Scan(&present, &total, &unvalidated, &other)
		if err != nil {
			return nil, fmt.Errorf("legacy dependency check %s: %w", table, err)
		}
		if present == 0 {
			continue
		}
		counts[table+".incomingFKs.total"] = &total
		counts[table+".incomingFKs.unvalidated"] = &unvalidated
		counts[table+".incomingFKs.otherRelations"] = &other
	}
	return counts, nil
}
