package main

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"io"
	"math"
	"net/http"
	"sort"
	"strings"
	"unicode/utf8"
)

type createComponentRequest struct {
	SchemeID         int               `json:"schemeId"`
	TypeID           int               `json:"typeId"`
	X                float64           `json:"x"`
	Y                float64           `json:"y"`
	Rotation         int               `json:"rotation"`
	Name             string            `json:"name"`
	EquipmentModelID *int              `json:"equipmentModelId"`
	Params           map[string]string `json:"params"`
}

type componentCreationError struct {
	message string
	status  int
}

func (e *componentCreationError) Error() string      { return e.message }
func creationError(message string, status int) error { return &componentCreationError{message, status} }

func validateComponentCreation(req createComponentRequest) error {
	if req.SchemeID <= 0 || req.TypeID <= 0 || strings.TrimSpace(req.Name) == "" || utf8.RuneCountInString(req.Name) > 100 {
		return creationError("Укажите схему, тип и название оборудования (до 100 символов)", http.StatusBadRequest)
	}
	if math.IsNaN(req.X) || math.IsInf(req.X, 0) || math.IsNaN(req.Y) || math.IsInf(req.Y, 0) || math.Abs(req.X) > math.MaxFloat32 || math.Abs(req.Y) > math.MaxFloat32 {
		return creationError("Некорректные координаты оборудования", http.StatusBadRequest)
	}
	if req.EquipmentModelID != nil && *req.EquipmentModelID <= 0 {
		return creationError("Некорректный идентификатор паспортной модели", http.StatusBadRequest)
	}
	if len(req.Params) > 256 {
		return creationError("Слишком много параметров", http.StatusBadRequest)
	}
	for key, value := range req.Params {
		if strings.TrimSpace(key) == "" || utf8.RuneCountInString(key) > 50 || len(value) > 16384 || strings.ContainsRune(key, 0) || strings.ContainsRune(value, 0) {
			return creationError("Некорректный ключ или значение параметра", http.StatusBadRequest)
		}
	}
	return nil
}

// The stored parameters are a snapshot, not a live link to mutable catalogue values.
// A repeatable-read transaction makes model validation, copying and creation atomic.
func createComponent(ctx context.Context, database *sql.DB, req createComponentRequest) (int, map[string]string, error) {
	if err := validateComponentCreation(req); err != nil {
		return 0, nil, err
	}
	tx, err := database.BeginTx(ctx, &sql.TxOptions{Isolation: sql.LevelRepeatableRead})
	if err != nil {
		return 0, nil, err
	}
	defer tx.Rollback()
	var exists bool
	if err = tx.QueryRowContext(ctx, "SELECT EXISTS(SELECT 1 FROM circuit_schemes WHERE id=$1)", req.SchemeID).Scan(&exists); err != nil {
		return 0, nil, err
	}
	if !exists {
		return 0, nil, creationError("Схема не найдена", http.StatusNotFound)
	}
	if err = tx.QueryRowContext(ctx, "SELECT EXISTS(SELECT 1 FROM component_types WHERE id=$1)", req.TypeID).Scan(&exists); err != nil {
		return 0, nil, err
	}
	if !exists {
		return 0, nil, creationError("Тип оборудования не найден", http.StatusBadRequest)
	}
	params := map[string]string{}
	if req.EquipmentModelID != nil {
		var modelType int
		err = tx.QueryRowContext(ctx, "SELECT component_type_id FROM equipment_models WHERE id=$1", *req.EquipmentModelID).Scan(&modelType)
		if errors.Is(err, sql.ErrNoRows) {
			return 0, nil, creationError("Паспортная модель не найдена", http.StatusNotFound)
		}
		if err != nil {
			return 0, nil, err
		}
		if modelType != req.TypeID {
			return 0, nil, creationError("Паспортная модель не соответствует типу оборудования", http.StatusBadRequest)
		}
		rows, err := tx.QueryContext(ctx, "SELECT param_key, param_value FROM equipment_model_params WHERE equipment_model_id=$1", *req.EquipmentModelID)
		if err != nil {
			return 0, nil, err
		}
		for rows.Next() {
			var key, value string
			if err = rows.Scan(&key, &value); err != nil {
				rows.Close()
				return 0, nil, err
			}
			params[key] = value
		}
		err = rows.Err()
		rows.Close()
		if err != nil {
			return 0, nil, err
		}
	}
	for key, value := range req.Params {
		params[key] = value
	}
	var id int
	err = tx.QueryRowContext(ctx, `INSERT INTO scheme_components
		(scheme_id, component_type_id, pos_x, pos_y, rotation, custom_name, equipment_model_id)
		VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`, req.SchemeID, req.TypeID, req.X, req.Y, req.Rotation, req.Name, req.EquipmentModelID).Scan(&id)
	if err != nil {
		return 0, nil, err
	}
	keys := make([]string, 0, len(params))
	for key := range params {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	for _, key := range keys {
		if _, err = tx.ExecContext(ctx, "INSERT INTO scheme_component_params (scheme_component_id,param_key,param_value) VALUES ($1,$2,$3)", id, key, params[key]); err != nil {
			return 0, nil, err
		}
	}
	if err = tx.Commit(); err != nil {
		return 0, nil, err
	}
	return id, params, nil
}

func handleComponents(w http.ResponseWriter, r *http.Request) {
	if !requireMethod(w, r, http.MethodPost) {
		return
	}
	if db == nil {
		sendError(w, "Database not available", http.StatusServiceUnavailable)
		return
	}
	r.Body = http.MaxBytesReader(w, r.Body, 1<<20)
	decoder := json.NewDecoder(r.Body)
	var req createComponentRequest
	if err := decoder.Decode(&req); err != nil {
		var limit *http.MaxBytesError
		if errors.As(err, &limit) {
			sendError(w, "Запрос слишком большой", http.StatusRequestEntityTooLarge)
		} else {
			sendError(w, "Некорректный запрос оборудования", http.StatusBadRequest)
		}
		return
	}
	if err := decoder.Decode(new(any)); err != io.EOF {
		sendError(w, "Ожидается один JSON-объект", http.StatusBadRequest)
		return
	}
	id, params, err := createComponent(r.Context(), db, req)
	if err != nil {
		var validation *componentCreationError
		if errors.As(err, &validation) {
			sendError(w, validation.message, validation.status)
		} else {
			sendError(w, "Не удалось сохранить оборудование; изменения отменены", http.StatusInternalServerError)
		}
		return
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]any{"id": id, "success": true, "params": params, "equipmentModelId": req.EquipmentModelID})
}
