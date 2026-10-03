package main

import (
	"database/sql"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strconv"
)

// A single strong entity tag carries the exact BIGINT revision. Wildcards and
// lists would allow an editor to overwrite a state it never actually loaded.
func expectedComponentRevision(w http.ResponseWriter, r *http.Request) (int64, bool) {
	values := r.Header.Values("If-Match")
	if len(values) == 0 {
		componentWriteError(w, http.StatusPreconditionRequired, "component_revision_required", "Загрузите актуальную версию оборудования перед сохранением")
		return 0, false
	}
	if len(values) != 1 || len(values[0]) < 3 {
		componentWriteError(w, http.StatusBadRequest, "invalid_component_revision", "Ожидается одна ревизия оборудования в If-Match")
		return 0, false
	}
	tag := values[0]
	if tag[0] != '"' || tag[len(tag)-1] != '"' {
		componentWriteError(w, http.StatusBadRequest, "invalid_component_revision", "Ревизия должна быть сильным ETag")
		return 0, false
	}
	decimal := tag[1 : len(tag)-1]
	revision, err := strconv.ParseInt(decimal, 10, 64)
	if err != nil || revision <= 0 || strconv.FormatInt(revision, 10) != decimal {
		componentWriteError(w, http.StatusBadRequest, "invalid_component_revision", "Некорректная ревизия оборудования")
		return 0, false
	}
	return revision, true
}

func componentWriteError(w http.ResponseWriter, status int, code, message string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(map[string]any{"success": false, "code": code, "error": message})
}

func decodeComponentMutation(w http.ResponseWriter, r *http.Request, target any) bool {
	r.Body = http.MaxBytesReader(w, r.Body, 1<<20)
	decoder := json.NewDecoder(r.Body)
	decoder.DisallowUnknownFields()
	err := decoder.Decode(target)
	if err == nil {
		err = decoder.Decode(new(any))
		if err == io.EOF {
			return true
		}
	}
	var limit *http.MaxBytesError
	if errors.As(err, &limit) {
		componentWriteError(w, http.StatusRequestEntityTooLarge, "request_too_large", "Запрос слишком большой")
	} else {
		componentWriteError(w, http.StatusBadRequest, "invalid_component_request", "Ожидается один корректный JSON-объект оборудования")
	}
	return false
}

func componentMutationReply(w http.ResponseWriter, revision int64, err error) {
	if err != nil {
		switch {
		case errors.Is(err, errComponentConflict):
			componentWriteError(w, http.StatusPreconditionFailed, "component_revision_conflict", "Оборудование изменено другим клиентом. Сравните изменения и повторно загрузите схему")
		case errors.Is(err, sql.ErrNoRows):
			componentWriteError(w, http.StatusNotFound, "component_not_found", "Оборудование не найдено")
		default:
			componentWriteError(w, http.StatusInternalServerError, "component_write_failed", "Не удалось сохранить оборудование; изменения отменены")
		}
		return
	}
	decimal := strconv.FormatInt(revision, 10)
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("ETag", `"`+decimal+`"`)
	json.NewEncoder(w).Encode(map[string]any{"success": true, "revision": decimal})
}

func handleComponentMutation(w http.ResponseWriter, r *http.Request, database *sql.DB, id int, params bool) {
	method := http.MethodPut
	if params {
		method = http.MethodPost
	}
	if r.Method != method && (params || (r.Method != http.MethodDelete && r.Method != http.MethodPatch)) {
		w.Header().Set("Allow", method)
		if !params {
			w.Header().Set("Allow", "PUT, PATCH, DELETE")
		}
		componentWriteError(w, http.StatusMethodNotAllowed, "method_not_allowed", "Метод не поддерживается")
		return
	}
	if id <= 0 {
		componentWriteError(w, http.StatusBadRequest, "invalid_component_id", "Некорректный ID оборудования")
		return
	}
	expected, ok := expectedComponentRevision(w, r)
	if !ok {
		return
	}
	if r.Method == http.MethodPatch {
		handleComponentPatch(w, r, database, id, expected)
		return
	}
	var mutation func(*sql.Tx) error
	if r.Method == http.MethodDelete {
		mutation = func(tx *sql.Tx) error {
			_, err := tx.ExecContext(r.Context(), "DELETE FROM scheme_components WHERE id=$1", id)
			return err
		}
	} else if params {
		var req struct {
			Key   string  `json:"key"`
			Value *string `json:"value"`
		}
		if !decodeComponentMutation(w, r, &req) {
			return
		}
		if req.Value == nil {
			componentWriteError(w, http.StatusBadRequest, "invalid_component_parameter", "Укажите значение параметра")
			return
		}
		if err := validateComponentParameter(req.Key, *req.Value); err != nil {
			componentWriteError(w, http.StatusBadRequest, "invalid_component_parameter", err.Error())
			return
		}
		mutation = func(tx *sql.Tx) error {
			_, err := tx.ExecContext(r.Context(), `INSERT INTO scheme_component_params(scheme_component_id,param_key,param_value)
			 VALUES($1,$2,$3) ON CONFLICT(scheme_component_id,param_key) DO UPDATE SET param_value=EXCLUDED.param_value`, id, req.Key, *req.Value)
			return err
		}
	} else {
		var req struct {
			X        *float64 `json:"x"`
			Y        *float64 `json:"y"`
			Rotation *int     `json:"rotation"`
			Name     *string  `json:"name"`
		}
		if !decodeComponentMutation(w, r, &req) {
			return
		}
		if req.X == nil || req.Y == nil || req.Rotation == nil || req.Name == nil {
			componentWriteError(w, http.StatusBadRequest, "invalid_component_pose", "Укажите координаты, поворот и название оборудования")
			return
		}
		if err := validateComponentPose(*req.X, *req.Y, *req.Name); err != nil {
			componentWriteError(w, http.StatusBadRequest, "invalid_component_pose", err.Error())
			return
		}
		mutation = func(tx *sql.Tx) error {
			_, err := tx.ExecContext(r.Context(), `UPDATE scheme_components SET pos_x=$2,pos_y=$3,rotation=$4,custom_name=$5 WHERE id=$1`, id, *req.X, *req.Y, *req.Rotation, *req.Name)
			return err
		}
	}
	revision, err := mutateComponentRevision(r.Context(), database, id, expected, mutation, r.Method == http.MethodDelete)
	componentMutationReply(w, revision, err)
}
