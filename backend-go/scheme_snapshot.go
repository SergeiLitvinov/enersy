package main

import (
	"context"
	"database/sql"
	"encoding/json"
	"strconv"
)

// Authorization and the complete graph use one repeatable-read snapshot.
// The reader has no dependency on an HTTP request or response writer.
func readSchemeSnapshot(ctx context.Context, database *sql.DB, id int, project int64, token string, expected *applicationIdentity) (schemeGraph[int], error) {
	var name string
	var description sql.NullString
	var createdAt, updatedAt *string
	var topologyRevision int64
	// Metadata, equipment revisions/parameters and connectivity must describe
	// one committed state, even when another client commits between queries.
	tx, err := database.BeginTx(ctx, &sql.TxOptions{Isolation: sql.LevelRepeatableRead, ReadOnly: true})
	if err != nil {
		return schemeGraph[int]{}, err
	}
	defer rollbackTx(tx)
	query := "SELECT name, description, created_at, updated_at,topology_revision FROM circuit_schemes WHERE id = $1 AND project_id IS NULL"
	var actorHash []byte
	args := []any{id}
	if project > 0 {
		hash, hashErr := sessionTokenHash(token)
		if hashErr != nil {
			return schemeGraph[int]{}, sql.ErrNoRows
		}
		query = `SELECT cs.name,COALESCE(cs.description,''),cs.created_at,cs.updated_at,cs.topology_revision
             FROM circuit_schemes cs JOIN projects p ON p.id=cs.project_id
             JOIN auth_sessions s ON s.token_hash=$3 JOIN auth_accounts a ON a.id=s.account_id
             LEFT JOIN project_members m ON m.project_id=p.id AND m.account_id=a.id
             WHERE cs.id=$1 AND p.id=$2 AND s.revoked_at IS NULL AND s.expires_at>statement_timestamp()
             AND a.disabled_at IS NULL AND (p.owner_account_id=a.id OR m.role IN ('viewer','editor','admin'))`
		actorHash = hash
		args = []any{id, project, hash}
	}
	err = tx.QueryRowContext(ctx, query, args...).
		Scan(&name, &description, &createdAt, &updatedAt, &topologyRevision)
	if err != nil {
		return schemeGraph[int]{}, err
	}

	if expected != nil {
		var matches bool
		if err := tx.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM auth_sessions WHERE token_hash=$1 AND account_id=$2 AND id=$3)`, actorHash, expected.AccountID, expected.SessionID).Scan(&matches); err != nil {
			return schemeGraph[int]{}, err
		}
		if !matches {
			return schemeGraph[int]{}, errApplicationSessionChanged
		}
	}

	components := []schemeComponentSnapshot[int]{}
	compRows, err := tx.QueryContext(ctx, `
			SELECT sc.id, ct.code, sc.pos_x, sc.pos_y, sc.rotation, sc.custom_name,
			       sc.equipment_model_id, ct.id, sc.revision, sc.project_passport_version_id, COALESCE((SELECT jsonb_object_agg(param_key,param_value)
			       FROM scheme_component_params WHERE scheme_component_id=sc.id), '{}'::jsonb),
 COALESCE((SELECT jsonb_object_agg(param_key,declared_unit) FROM scheme_component_params WHERE scheme_component_id=sc.id AND unit_format_version=1),'{}'::jsonb),
 COALESCE((SELECT jsonb_object_agg(param_key,jsonb_build_object('profile',per_unit_base_profile,'s_base_mva',per_unit_s_base_mva,'v_base_kv',per_unit_v_base_kv)) FROM scheme_component_params WHERE scheme_component_id=sc.id AND per_unit_base_profile IS NOT NULL),'{}'::jsonb)
			FROM scheme_components sc
			JOIN component_types ct ON sc.component_type_id = ct.id
			WHERE sc.scheme_id = $1 ORDER BY sc.id`, id)
	if err != nil {
		return schemeGraph[int]{}, err
	}
	defer compRows.Close()

	for compRows.Next() {
		var compID int
		var code string
		var x, y float64
		var rotation int
		var customName sql.NullString
		var modelID sql.NullInt32
		var passportID sql.NullInt64
		var typeID int
		var revision int64
		var paramsJSON, unitsJSON, basesJSON []byte
		if err := compRows.Scan(&compID, &code, &x, &y, &rotation, &customName, &modelID, &typeID, &revision, &passportID, &paramsJSON, &unitsJSON, &basesJSON); err != nil {
			return schemeGraph[int]{}, err
		}
		cname := ""
		if customName.Valid {
			cname = customName.String
		}
		params := map[string]string{}
		if err := json.Unmarshal(paramsJSON, &params); err != nil {
			return schemeGraph[int]{}, err
		}
		var equipmentModelID *int
		if modelID.Valid {
			value := int(modelID.Int32)
			equipmentModelID = &value
		}
		components = append(components, schemeComponentSnapshot[int]{
			ID: compID, Type: code, X: x, Y: y, Rotation: rotation, Name: cname,
			Params: params, EquipmentModelID: equipmentModelID, TypeID: typeID, Revision: strconv.FormatInt(revision, 10),
		})
		declaration, err := decodeParameterUnits(unitsJSON, basesJSON)
		if err != nil {
			return schemeGraph[int]{}, err
		}
		components[len(components)-1].DeclaredParameterUnits = declaration
		if project > 0 {
			var value *string
			if passportID.Valid {
				text := strconv.FormatInt(passportID.Int64, 10)
				value = &text
			}
			components[len(components)-1].ProjectPassportVersionID = &value
		}
	}
	if err := compRows.Err(); err != nil {
		return schemeGraph[int]{}, err
	}

	connections := []schemeConnectionSnapshot[int]{}
	connRows, err := tx.QueryContext(ctx, `
			SELECT c.id, c.from_component_id, c.to_component_id, c.from_port, c.to_port,
			COALESCE(to_json(v.reasons), '[]'::json)
			FROM scheme_connections c LEFT JOIN invalid_scheme_connections v ON v.id=c.id
			WHERE c.scheme_id = $1 ORDER BY c.id`, id)
	if err != nil {
		return schemeGraph[int]{}, err
	}
	defer connRows.Close()

	for connRows.Next() {
		var connectionID, from, to int
		var fromPort, toPort string
		var reasonsJSON []byte
		if err := connRows.Scan(&connectionID, &from, &to, &fromPort, &toPort, &reasonsJSON); err != nil {
			return schemeGraph[int]{}, err
		}
		var reasons []string
		if err := json.Unmarshal(reasonsJSON, &reasons); err != nil {
			return schemeGraph[int]{}, err
		}
		connections = append(connections, schemeConnectionSnapshot[int]{
			ID: connectionID, ValidationErrors: reasons,
			From: from, To: to, FromPort: fromPort, ToPort: toPort,
		})
	}
	if err := connRows.Err(); err != nil {
		return schemeGraph[int]{}, err
	}
	if err := tx.Commit(); err != nil {
		return schemeGraph[int]{}, err
	}

	result := schemeGraph[int]{
		TopologyRevision: strconv.FormatInt(topologyRevision, 10),
		ID:               id, Name: name, Description: description.String,
		CreatedAt: createdAt, UpdatedAt: updatedAt,
		Components: components, Connections: connections,
	}
	if project > 0 {
		result.ProjectID = strconv.FormatInt(project, 10)
	}
	return result, nil
}
