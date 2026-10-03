package main

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"math"
	"net/http"
	"sort"
)

type componentPatchRequest struct {
	Pose   json.RawMessage `json:"pose"`
	Params json.RawMessage `json:"params"`
}

type componentPatch struct {
	X, Y     *float64
	Rotation *int
	Name     *string
	Params   map[string]string
}

func (patch componentPatch) hasPose() bool {
	return patch.X != nil || patch.Y != nil || patch.Rotation != nil || patch.Name != nil
}

// Null is not an omitted field or an empty parameter value. Decode explicitly
// before taking the parent lock so invalid requests can never partly mutate data.
func parseComponentPatch(request componentPatchRequest) (componentPatch, error) {
	patch := componentPatch{Params: map[string]string{}}
	decodeObject := func(raw json.RawMessage) (map[string]json.RawMessage, error) {
		var fields map[string]json.RawMessage
		if err := json.Unmarshal(raw, &fields); err != nil || fields == nil {
			return nil, fmt.Errorf("Ожидается JSON-объект, null недопустим")
		}
		return fields, nil
	}
	decodeValue := func(raw json.RawMessage, target any) error {
		if bytes.Equal(bytes.TrimSpace(raw), []byte("null")) {
			return fmt.Errorf("null недопустим в изменяемом поле")
		}
		if err := json.Unmarshal(raw, target); err != nil {
			return fmt.Errorf("Некорректное значение изменяемого поля")
		}
		return nil
	}
	if len(request.Pose) > 0 {
		fields, err := decodeObject(request.Pose)
		if err != nil {
			return patch, err
		}
		for field, raw := range fields {
			switch field {
			case "x", "y":
				var value float64
				if err := decodeValue(raw, &value); err != nil {
					return patch, err
				}
				if math.IsNaN(value) || math.IsInf(value, 0) || math.Abs(value) > math.MaxFloat32 {
					return patch, fmt.Errorf("Некорректные координаты оборудования")
				}
				if field == "x" {
					patch.X = &value
				} else {
					patch.Y = &value
				}
			case "rotation":
				var value int
				if err := decodeValue(raw, &value); err != nil {
					return patch, err
				}
				if value < math.MinInt32 || value > math.MaxInt32 {
					return patch, fmt.Errorf("Поворот вне допустимого диапазона")
				}
				patch.Rotation = &value
			case "name":
				var value string
				if err := decodeValue(raw, &value); err != nil {
					return patch, err
				}
				if err := validateComponentPose(0, 0, value); err != nil {
					return patch, err
				}
				patch.Name = &value
			default:
				return patch, fmt.Errorf("Неизвестное поле положения оборудования")
			}
		}
	}
	if len(request.Params) > 0 {
		fields, err := decodeObject(request.Params)
		if err != nil {
			return patch, err
		}
		if len(fields) > 256 {
			return patch, fmt.Errorf("Слишком много параметров")
		}
		for key, raw := range fields {
			var value string
			if err := decodeValue(raw, &value); err != nil {
				return patch, err
			}
			if err := validateComponentParameter(key, value); err != nil {
				return patch, err
			}
			patch.Params[key] = value
		}
	}
	if !patch.hasPose() && len(patch.Params) == 0 {
		return patch, fmt.Errorf("Выберите хотя бы одно изменяемое поле")
	}
	return patch, nil
}

// The caller already holds the parent lock and has checked If-Match. All
// selected geometry fields and parameters commit together. Unselected fields
// come from the locked server row, never from the client's old full snapshot.
func applyComponentPatch(ctx context.Context, tx *sql.Tx, id int, patch componentPatch) error {
	if patch.hasPose() {
		_, err := tx.ExecContext(ctx, `UPDATE scheme_components SET
		 pos_x=COALESCE($2,pos_x),pos_y=COALESCE($3,pos_y),rotation=COALESCE($4,rotation),custom_name=COALESCE($5,custom_name)
		 WHERE id=$1`, id, patch.X, patch.Y, patch.Rotation, patch.Name)
		if err != nil {
			return err
		}
	}
	keys := make([]string, 0, len(patch.Params))
	for key := range patch.Params {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	for _, key := range keys {
		if _, err := tx.ExecContext(ctx, `INSERT INTO scheme_component_params(scheme_component_id,param_key,param_value)
		 VALUES($1,$2,$3) ON CONFLICT(scheme_component_id,param_key) DO UPDATE SET param_value=EXCLUDED.param_value`, id, key, patch.Params[key]); err != nil {
			return err
		}
	}
	return nil
}

func handleComponentPatch(w http.ResponseWriter, r *http.Request, database *sql.DB, id int, expected int64) {
	var request componentPatchRequest
	if !decodeComponentMutation(w, r, &request) {
		return
	}
	patch, err := parseComponentPatch(request)
	if err != nil {
		componentWriteError(w, http.StatusBadRequest, "invalid_component_patch", err.Error())
		return
	}
	revision, err := mutateComponentRevision(r.Context(), database, id, expected, func(tx *sql.Tx) error {
		return applyComponentPatch(r.Context(), tx, id, patch)
	}, false)
	componentMutationReply(w, revision, err)
}
