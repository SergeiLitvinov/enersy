package main

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"sort"
	"strings"
	"time"

	"github.com/lib/pq"
)

const catalogRowLimit = 100000

type catalogRecord struct {
	SourceRef string            `json:"sourceRef,omitempty"`
	Key       string            `json:"key"`
	ValidKey  bool              `json:"validKey"`
	Fields    map[string]string `json:"fields"`
}
type catalogEntity struct {
	Name      string          `json:"name"`
	Available bool            `json:"available"`
	Records   []catalogRecord `json:"records"`
}
type catalogSnapshot struct {
	CapturedAt time.Time       `json:"capturedAt"`
	Database   string          `json:"database"`
	Schema     string          `json:"schema"`
	Entities   []catalogEntity `json:"entities"`
}
type catalogQuery struct {
	name, table, locator, joins string
	keys                        []string
	fields                      map[string]string
	required                    map[string][]string
}

// Fixed declarations are shared by reference generation, runtime comparison and CI.
// Keys use stored, case-sensitive text. Hashes preserve NULL vs empty string and
// exact textual values; this is not a numerical or engineering normalization.
func catalogQueries(qualified func(string) string) []catalogQuery {
	parent := ` LEFT JOIN ` + qualified("component_types") + ` t ON t.id=x.component_type_id`
	return []catalogQuery{
		{"types", "component_types", "x.id::text", "", []string{"x.code"}, map[string]string{"name": "x.name", "category": "x.category", "description": "x.description"}, map[string][]string{"component_types": {"id", "code", "name", "category", "description"}}},
		{"templates", "component_params_template", "x.id::text", parent, []string{"t.code", "x.param_key"}, map[string]string{"param_name": "x.param_name", "param_type": "x.param_type", "default_value": "x.default_value", "unit": "x.unit"}, map[string][]string{"component_types": {"id", "code"}, "component_params_template": {"id", "component_type_id", "param_key", "param_name", "param_type", "default_value", "unit"}}},
		{"models", "equipment_models", "x.id::text", parent, []string{"t.code", "x.model_name"}, map[string]string{"manufacturer": "x.manufacturer", "description": "x.description"}, map[string][]string{"component_types": {"id", "code"}, "equipment_models": {"id", "component_type_id", "model_name", "manufacturer", "description"}}},
		{"model_params", "equipment_model_params", "x.id::text", ` LEFT JOIN ` + qualified("equipment_models") + ` m ON m.id=x.equipment_model_id LEFT JOIN ` + qualified("component_types") + ` t ON t.id=m.component_type_id`, []string{"t.code", "m.model_name", "x.param_key"}, map[string]string{"param_value": "x.param_value"}, map[string][]string{"component_types": {"id", "code"}, "equipment_models": {"id", "component_type_id", "model_name"}, "equipment_model_params": {"id", "equipment_model_id", "param_key", "param_value"}}},
		{"ports", "component_type_ports", `x.component_type_id::text || '/' || encode(sha256(convert_to(x.port_name::text,'UTF8')),'hex')`, parent, []string{"t.code", "x.port_name"}, map[string]string{"domain": "x.domain"}, map[string][]string{"component_types": {"id", "code"}, "component_type_ports": {"component_type_id", "port_name", "domain"}}},
	}
}

func catalogFieldHash(expression string) string {
	return `encode(sha256(CASE WHEN ` + expression + ` IS NULL THEN decode('00','hex') ELSE decode('01','hex') || convert_to((` + expression + `)::text,'UTF8') END),'hex')`
}

func readCatalogSnapshot(ctx context.Context, db *sql.DB) (catalogSnapshot, error) {
	tx, err := beginReadOnlyAudit(ctx, db)
	if err != nil {
		return catalogSnapshot{}, err
	}
	defer rollbackTx(tx)
	result, err := readCatalogSnapshotTx(ctx, tx)
	if err != nil {
		return result, err
	}
	return result, tx.Commit()
}

// Also used under the operator map transaction, so validation and writes cannot
// observe different catalog snapshots.
func readCatalogSnapshotTx(ctx context.Context, tx *sql.Tx) (catalogSnapshot, error) {
	result := catalogSnapshot{Entities: []catalogEntity{}}
	var schema string
	if err := tx.QueryRowContext(ctx, `SELECT current_database(),current_schema(),transaction_timestamp()`).Scan(&result.Database, &schema, &result.CapturedAt); err != nil {
		return result, err
	}
	result.Schema = schema
	qualified := func(table string) string { return pq.QuoteIdentifier(schema) + "." + pq.QuoteIdentifier(table) }
	columns := map[string]map[string]bool{}
	meta, err := tx.QueryContext(ctx, `SELECT c.table_name,c.column_name FROM information_schema.columns c JOIN pg_namespace n ON n.nspname=c.table_schema JOIN pg_class r ON r.relnamespace=n.oid AND r.relname=c.table_name WHERE c.table_schema=$1 AND r.relkind IN ('r','p')`, schema)
	if err != nil {
		return result, err
	}
	for meta.Next() {
		var table, column string
		if err = meta.Scan(&table, &column); err != nil {
			meta.Close()
			return result, err
		}
		if columns[table] == nil {
			columns[table] = map[string]bool{}
		}
		columns[table][column] = true
	}
	err = meta.Err()
	meta.Close()
	if err != nil {
		return result, err
	}
	for _, def := range catalogQueries(qualified) {
		entity := catalogEntity{Name: def.name, Available: true, Records: []catalogRecord{}}
		for table, required := range def.required {
			for _, column := range required {
				if !columns[table][column] {
					entity.Available = false
				}
			}
		}
		if !entity.Available {
			result.Entities = append(result.Entities, entity)
			continue
		}
		fieldNames := make([]string, 0, len(def.fields))
		for key := range def.fields {
			fieldNames = append(fieldNames, key)
		}
		sort.Strings(fieldNames)
		pairs := []string{}
		for _, key := range fieldNames {
			pairs = append(pairs, "'"+key+"'", catalogFieldHash(def.fields[key]))
		}
		valid := []string{}
		for _, key := range def.keys {
			valid = append(valid, "("+key+" IS NOT NULL AND ("+key+")::text <> '')")
		}
		// #nosec G202 -- Query fragments are fixed definitions; schema/table
		// identifiers are quoted, and no HTTP input enters this query.
		query := `SELECT ` + def.locator + `,encode(sha256(convert_to(jsonb_build_array(` + strings.Join(def.keys, ",") + `)::text,'UTF8')),'hex'),(` + strings.Join(valid, " AND ") + `),jsonb_build_object(` + strings.Join(pairs, ",") + `)::text FROM ` + qualified(def.table) + ` x` + def.joins + fmt.Sprintf(" LIMIT %d", catalogRowLimit+1)
		rows, err := tx.QueryContext(ctx, query)
		if err != nil {
			return result, fmt.Errorf("catalog %s unavailable: %w", def.name, err)
		}
		for rows.Next() {
			var record catalogRecord
			var fields string
			var ref sql.NullString
			if err = rows.Scan(&ref, &record.Key, &record.ValidKey, &fields); err != nil {
				rows.Close()
				return result, err
			}
			record.SourceRef = ref.String
			if !ref.Valid || ref.String == "" {
				record.ValidKey = false
			}
			if err = json.Unmarshal([]byte(fields), &record.Fields); err != nil {
				rows.Close()
				return result, err
			}
			entity.Records = append(entity.Records, record)
			if len(entity.Records) > catalogRowLimit {
				rows.Close()
				return result, fmt.Errorf("catalog %s exceeds audit row limit", def.name)
			}
		}
		err = rows.Err()
		rows.Close()
		if err != nil {
			return result, err
		}
		sortCatalogRecords(entity.Records)
		result.Entities = append(result.Entities, entity)
	}
	return result, nil
}

func sortCatalogRecords(records []catalogRecord) {
	sort.Slice(records, func(i, j int) bool {
		if records[i].Key != records[j].Key {
			return records[i].Key < records[j].Key
		}
		if records[i].SourceRef != records[j].SourceRef {
			return records[i].SourceRef < records[j].SourceRef
		}
		return catalogDigest(records[i].Fields) < catalogDigest(records[j].Fields)
	})
}
