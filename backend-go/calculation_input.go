package main

import (
	"context"
	"database/sql"
	"encoding/json"
)

type calculationComponent struct {
	Revision       int64             `json:"-"` // Internal capture guard; provenance retains the wire revision.
	ID             int               `json:"id"`
	Type           string            `json:"type"`
	X              float64           `json:"x"`
	Y              float64           `json:"y"`
	Rotation       int               `json:"rotation"`
	Params         map[string]string `json:"params"`
	ParameterUnits map[string]string `json:"parameterUnits,omitempty"`
}

type calculationConnection struct {
	From     int    `json:"from"`
	To       int    `json:"to"`
	FromPort string `json:"fromPort"`
	ToPort   string `json:"toPort"`
}

type calculationInput struct {
	Provenance       []byte
	Components       []calculationComponent
	Connections      []calculationConnection
	TopologyRevision int64
	AuthorAccountID  int64
	SchemeName       string
}

// Read a coherent input and release the database before contacting the worker.
// This is an in-memory request snapshot, not a persisted Study/Run revision.
func readCalculationInput(ctx context.Context, database *sql.DB, schemeID int) (calculationInput, error) {
	return readCalculationInputScope(ctx, database, schemeID, 0, "", false)
}

func readCalculationInputScope(ctx context.Context, database *sql.DB, schemeID int, project int64, token string, captureProvenance bool) (calculationInput, error) {
	input := calculationInput{Components: []calculationComponent{}, Connections: []calculationConnection{}}
	tx, err := database.BeginTx(ctx, &sql.TxOptions{Isolation: sql.LevelRepeatableRead, ReadOnly: true})
	if err != nil {
		return input, err
	}
	defer rollbackTx(tx)
	var id int
	query := `SELECT id FROM circuit_schemes WHERE id=$1 AND project_id IS NULL`
	args := []any{schemeID}
	if project > 0 {
		hash, err := sessionTokenHash(token)
		if err != nil {
			return input, sql.ErrNoRows
		}
		query = `SELECT cs.id,cs.topology_revision,a.id,cs.name FROM circuit_schemes cs JOIN projects p ON p.id=cs.project_id
 JOIN auth_sessions s ON s.token_hash=$3 JOIN auth_accounts a ON a.id=s.account_id
 LEFT JOIN project_members m ON m.project_id=p.id AND m.account_id=a.id
 WHERE cs.id=$1 AND p.id=$2 AND s.revoked_at IS NULL AND s.expires_at>statement_timestamp() AND a.disabled_at IS NULL
 AND (p.owner_account_id=a.id OR m.role IN ('admin','editor'))`
		if err := tx.QueryRowContext(ctx, query, schemeID, project, hash).Scan(&id, &input.TopologyRevision, &input.AuthorAccountID, &input.SchemeName); err != nil {
			return input, err
		}
	} else if err := tx.QueryRowContext(ctx, query, args...).Scan(&id); err != nil {
		return input, err
	}
	components, err := tx.QueryContext(ctx, `SELECT sc.id,ct.code,sc.pos_x,sc.pos_y,sc.rotation,sc.revision,
	 COALESCE((SELECT jsonb_object_agg(param_key,param_value) FROM scheme_component_params
	 WHERE scheme_component_id=sc.id),'{}'::jsonb)
	 FROM scheme_components sc JOIN component_types ct ON ct.id=sc.component_type_id WHERE sc.scheme_id=$1 ORDER BY sc.id`, schemeID)
	if err != nil {
		return input, err
	}
	defer components.Close()
	for components.Next() {
		var component calculationComponent
		var params []byte
		if err := components.Scan(&component.ID, &component.Type, &component.X, &component.Y, &component.Rotation, &component.Revision, &params); err != nil {
			return input, err
		}
		if err := json.Unmarshal(params, &component.Params); err != nil {
			return input, err
		}
		input.Components = append(input.Components, component)
	}
	if err := components.Err(); err != nil {
		return input, err
	}
	if err := components.Close(); err != nil {
		return input, err
	}
	// Capture labels in the same database snapshot as values. One bulk read,
	// independent of graph size; only stored parameter keys are transmitted.
	unitRows, err := tx.QueryContext(ctx, `SELECT ct.code,t.param_key,coalesce(t.unit,'')
 FROM component_params_template t JOIN component_types ct ON ct.id=t.component_type_id
 WHERE t.component_type_id IN (SELECT component_type_id FROM scheme_components WHERE scheme_id=$1)`, schemeID)
	if err != nil {
		return input, err
	}
	units := map[string]map[string]string{}
	for unitRows.Next() {
		var code, key, unit string
		if err := unitRows.Scan(&code, &key, &unit); err != nil {
			_ = unitRows.Close()
			return input, err
		}
		if units[code] == nil {
			units[code] = map[string]string{}
		}
		units[code][key] = unit
	}
	if err := unitRows.Err(); err != nil {
		_ = unitRows.Close()
		return input, err
	}
	if err := unitRows.Close(); err != nil {
		return input, err
	}
	for i := range input.Components {
		component := &input.Components[i]
		component.ParameterUnits = map[string]string{}
		for key := range component.Params {
			if unit, ok := units[component.Type][key]; ok {
				component.ParameterUnits[key] = unit
			}
		}
	}
	connections, err := tx.QueryContext(ctx, `SELECT from_component_id,to_component_id,from_port,to_port
	 FROM scheme_connections WHERE scheme_id=$1 ORDER BY id`, schemeID)
	if err != nil {
		return input, err
	}
	defer connections.Close()
	for connections.Next() {
		var connection calculationConnection
		if err := connections.Scan(&connection.From, &connection.To, &connection.FromPort, &connection.ToPort); err != nil {
			return input, err
		}
		input.Connections = append(input.Connections, connection)
	}
	if err := connections.Err(); err != nil {
		return input, err
	}
	if project > 0 && captureProvenance {
		input.Provenance, err = readCalculationProvenance(ctx, tx, project, schemeID, input.Components)
		if err != nil {
			return input, err
		}
	}
	if err := tx.Commit(); err != nil {
		return input, err
	}
	return input, nil
}
