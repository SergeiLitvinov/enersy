package main

import (
	"context"
	"database/sql"
	"mime"
	"net/http"
	"strconv"
	"strings"
)

func intProjectID(value string) (int, error) {
	id, err := positiveProjectID(value)
	// Scheme/component/type/model IDs are PostgreSQL INTEGER in this schema.
	if err != nil || id > 2147483647 || int64(int(id)) != id {
		return 0, errProjectUnavailable
	}
	return int(id), nil
}

func (handler projectsHTTP) components(w http.ResponseWriter, r *http.Request) bool {
	parts := strings.Split(strings.TrimPrefix(r.URL.Path, "/api/projects/"), "/")
	if len(parts) < 4 || parts[1] != "schemes" || parts[3] != "components" {
		return false
	}
	if len(parts) > 6 || (len(parts) == 6 && parts[5] != "params") {
		sendError(w, "Not found", 404)
		return true
	}
	project, err := positiveProjectID(parts[0])
	if err != nil {
		sendError(w, "Not found", 404)
		return true
	}
	scheme, err := intProjectID(parts[2])
	if err != nil {
		sendError(w, "Not found", 404)
		return true
	}
	token, err := handler.auth.token(r)
	if err != nil {
		sendError(w, "Session unavailable", 401)
		return true
	}
	allowed := "PUT, PATCH, DELETE"
	validMethod := r.Method == http.MethodPut || r.Method == http.MethodPatch || r.Method == http.MethodDelete
	if len(parts) == 4 || len(parts) == 6 {
		allowed = "POST"
		validMethod = r.Method == http.MethodPost
	}
	if !validMethod {
		w.Header().Set("Allow", allowed)
		sendError(w, "Method not allowed", 405)
		return true
	}
	if r.Method != http.MethodDelete {
		contentType, _, err := mime.ParseMediaType(r.Header.Get("Content-Type"))
		if err != nil || contentType != "application/json" {
			sendError(w, "JSON content type required", 415)
			return true
		}
	}
	store := projectStore{database: handler.auth.database}
	if len(parts) == 4 {
		if !requireMethod(w, r, http.MethodPost) {
			return true
		}
		var input struct {
			TypeID                   string            `json:"typeId"`
			EquipmentModelID         *string           `json:"equipmentModelId"`
			ProjectPassportVersionID *string           `json:"projectPassportVersionId"`
			X                        float64           `json:"x"`
			Y                        float64           `json:"y"`
			Rotation                 int               `json:"rotation"`
			Name                     string            `json:"name"`
			Params                   map[string]string `json:"params"`
		}
		if !decodeComponentMutation(w, r, &input) {
			return true
		}
		typeID, err := intProjectID(input.TypeID)
		if err != nil {
			componentWriteError(w, 400, "invalid_component_type", "Некорректный ID типа оборудования")
			return true
		}
		var model *int
		if input.EquipmentModelID != nil {
			id, err := intProjectID(*input.EquipmentModelID)
			if err != nil {
				componentWriteError(w, 400, "invalid_equipment_model", "Некорректный ID паспортной модели")
				return true
			}
			model = &id
		}
		var passport *int64
		if input.ProjectPassportVersionID != nil {
			value, err := positiveProjectID(*input.ProjectPassportVersionID)
			if err != nil {
				componentWriteError(w, 400, "invalid_project_passport", "Некорректный ID проектного паспорта")
				return true
			}
			passport = &value
		}
		created, err := store.CreateComponent(r.Context(), token, project, createComponentRequest{SchemeID: scheme, TypeID: typeID, EquipmentModelID: model, ProjectPassportVersionID: passport, X: input.X, Y: input.Y, Rotation: input.Rotation, Name: input.Name, Params: input.Params})
		if err != nil {
			status, message := projectComponentCreationError(err)
			componentWriteError(w, status, "component_creation_failed", message)
			return true
		}
		var modelID any
		if model != nil {
			modelID = strconv.Itoa(*model)
		}
		var passportID any
		if passport != nil {
			passportID = strconv.FormatInt(*passport, 10)
		}
		decimal := strconv.FormatInt(created.Revision, 10)
		w.Header().Set("ETag", `"`+decimal+`"`)
		w.WriteHeader(201)
		body := map[string]any{"id": strconv.Itoa(created.ID), "revision": decimal, "params": created.Params, "equipmentModelId": modelID, "projectPassportVersionId": passportID, "success": true}
		if created.DeclaredParameterUnits != nil {
			body["declaredParameterUnits"] = created.DeclaredParameterUnits
		}
		writeJSON(w, body)
		return true
	}
	id, err := intProjectID(parts[4])
	if err != nil {
		sendError(w, "Not found", 404)
		return true
	}
	write := func(ctx context.Context, _ *sql.DB, id int, expected int64, mutate func(*sql.Tx) error, deleting bool) (int64, error) {
		return store.MutateComponent(ctx, token, project, scheme, id, expected, mutate, deleting)
	}
	handleComponentMutationWith(w, r, handler.auth.database, id, len(parts) == 6, write)
	return true
}
