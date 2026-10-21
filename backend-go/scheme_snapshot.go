package main

import (
	"database/sql"
	"encoding/json"
	"net/http"
	"strconv"
)

// Authorization and the complete graph use one repeatable-read snapshot.
func serveSchemeSnapshot(w http.ResponseWriter, r *http.Request, database *sql.DB, id int, project int64, token string) {
	var name, description string
	var createdAt, updatedAt string
	var ownerID int
	var topologyRevision int64
	// Metadata, equipment revisions/parameters and connectivity must describe
	// one committed state, even when another client commits between queries.
	tx, err := database.BeginTx(r.Context(), &sql.TxOptions{Isolation: sql.LevelRepeatableRead, ReadOnly: true})
	if err != nil {
		sendError(w, "Could not read scheme snapshot", http.StatusInternalServerError)
		return
	}
	defer tx.Rollback()
	query := "SELECT name, description, created_at, updated_at, owner_id,topology_revision FROM circuit_schemes WHERE id = $1 AND project_id IS NULL"
	args := []any{id}
	if project > 0 {
		hash, hashErr := sessionTokenHash(token)
		if hashErr != nil {
			sendError(w, "Scheme not found", 404)
			return
		}
		query = `SELECT cs.name,COALESCE(cs.description,''),cs.created_at,cs.updated_at,COALESCE(cs.owner_id,0),cs.topology_revision
             FROM circuit_schemes cs JOIN projects p ON p.id=cs.project_id
             JOIN auth_sessions s ON s.token_hash=$3 JOIN auth_accounts a ON a.id=s.account_id
             LEFT JOIN project_members m ON m.project_id=p.id AND m.account_id=a.id
             WHERE cs.id=$1 AND p.id=$2 AND s.revoked_at IS NULL AND s.expires_at>statement_timestamp()
             AND a.disabled_at IS NULL AND (p.owner_account_id=a.id OR m.role IN ('viewer','editor','admin'))`
		args = []any{id, project, hash}
	}
	err = tx.QueryRowContext(r.Context(), query, args...).
		Scan(&name, &description, &createdAt, &updatedAt, &ownerID, &topologyRevision)
	if err == sql.ErrNoRows {
		sendError(w, "Scheme not found", http.StatusNotFound)
		return
	}
	if err != nil {
		sendError(w, "Could not read scheme snapshot", http.StatusInternalServerError)
		return
	}

	components := []map[string]interface{}{}
	compRows, err := tx.QueryContext(r.Context(), `
			SELECT sc.id, ct.code, sc.pos_x, sc.pos_y, sc.rotation, sc.custom_name,
			       sc.equipment_model_id, ct.id, sc.revision, sc.project_passport_version_id, COALESCE((SELECT jsonb_object_agg(param_key,param_value)
			       FROM scheme_component_params WHERE scheme_component_id=sc.id), '{}'::jsonb)
			FROM scheme_components sc
			JOIN component_types ct ON sc.component_type_id = ct.id
			WHERE sc.scheme_id = $1`, id)
	if err != nil {
		sendError(w, "Could not read scheme snapshot", http.StatusInternalServerError)
		return
	}
	defer compRows.Close()

	for compRows.Next() {
		var compID int
		var code string
		var x, y float64
		var rotation int
		var customName sql.NullString
		var modelID sql.NullInt64
		var passportID sql.NullInt64
		var typeID int
		var revision int64
		var paramsJSON []byte
		if err := compRows.Scan(&compID, &code, &x, &y, &rotation, &customName, &modelID, &typeID, &revision, &passportID, &paramsJSON); err != nil {
			sendError(w, "Could not read scheme snapshot", http.StatusInternalServerError)
			return
		}
		cname := ""
		if customName.Valid {
			cname = customName.String
		}
		params := map[string]string{}
		if err := json.Unmarshal(paramsJSON, &params); err != nil {
			sendError(w, "Invalid stored parameters", http.StatusInternalServerError)
			return
		}
		var equipmentModelID any
		if modelID.Valid {
			equipmentModelID = modelID.Int64
		}
		components = append(components, map[string]interface{}{
			"id": compID, "type": code, "x": x, "y": y, "rotation": rotation, "name": cname,
			"params": params, "equipmentModelId": equipmentModelID, "typeId": typeID, "revision": strconv.FormatInt(revision, 10),
		})
		if project > 0 {
			var value any
			if passportID.Valid {
				value = strconv.FormatInt(passportID.Int64, 10)
			}
			components[len(components)-1]["projectPassportVersionId"] = value
		}
	}
	if err := compRows.Err(); err != nil {
		sendError(w, "Could not read scheme snapshot", http.StatusInternalServerError)
		return
	}

	connections := []map[string]interface{}{}
	connRows, err := tx.QueryContext(r.Context(), `
			SELECT c.id, c.from_component_id, c.to_component_id, c.from_port, c.to_port,
			COALESCE(to_json(v.reasons), '[]'::json)
			FROM scheme_connections c LEFT JOIN invalid_scheme_connections v ON v.id=c.id
			WHERE c.scheme_id = $1`, id)
	if err != nil {
		sendError(w, "Could not read scheme snapshot", http.StatusInternalServerError)
		return
	}
	defer connRows.Close()

	for connRows.Next() {
		var connectionID, from, to int
		var fromPort, toPort string
		var reasonsJSON []byte
		if err := connRows.Scan(&connectionID, &from, &to, &fromPort, &toPort, &reasonsJSON); err != nil {
			sendError(w, "Could not read scheme snapshot", http.StatusInternalServerError)
			return
		}
		var reasons []string
		if err := json.Unmarshal(reasonsJSON, &reasons); err != nil {
			sendError(w, "Connection diagnostics error", http.StatusInternalServerError)
			return
		}
		connections = append(connections, map[string]interface{}{
			"id": connectionID, "validationErrors": reasons,
			"from": from, "to": to, "fromPort": fromPort, "toPort": toPort,
		})
	}
	if err := connRows.Err(); err != nil {
		sendError(w, "Could not read scheme snapshot", http.StatusInternalServerError)
		return
	}
	if err := tx.Commit(); err != nil {
		sendError(w, "Could not complete scheme snapshot", http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	result := map[string]interface{}{
		"topologyRevision": strconv.FormatInt(topologyRevision, 10),
		"id":               id, "name": name, "description": description,
		"created_at": createdAt, "updated_at": updatedAt, "owner_id": ownerID,
		"components": components, "connections": connections,
	}
	if project > 0 {
		result["id"] = strconv.Itoa(id)
		result["projectId"] = strconv.FormatInt(project, 10)
		delete(result, "owner_id")
		for _, component := range components {
			component["id"] = strconv.Itoa(component["id"].(int))
			component["typeId"] = strconv.Itoa(component["typeId"].(int))
			if model, ok := component["equipmentModelId"].(int64); ok {
				component["equipmentModelId"] = strconv.FormatInt(model, 10)
			}
		}
		for _, connection := range connections {
			for _, field := range []string{"id", "from", "to"} {
				connection[field] = strconv.Itoa(connection[field].(int))
			}
		}
	}
	json.NewEncoder(w).Encode(result)
}
