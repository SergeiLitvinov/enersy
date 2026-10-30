package main

import (
	"context"
	"database/sql"
	"errors"
)

type copiedProjectPassport struct {
	Params      map[string]string
	Declaration *parameterUnitDeclaration
}

// Called only after locking project -> scheme for a private creation. Copy the
// immutable source, then apply typed explicit instance overrides. No defaults.
func copyProjectPassport(ctx context.Context, tx *sql.Tx, project int64, req createComponentRequest) (copiedProjectPassport, error) {
	version, err := scanPassport(tx.QueryRowContext(ctx, `SELECT `+passportColumns+` FROM project_passports WHERE id=$1 AND project_id=$2`, *req.ProjectPassportVersionID, project))
	if errors.Is(err, sql.ErrNoRows) {
		return copiedProjectPassport{}, creationError("Проектный паспорт недоступен", 404)
	}
	if err != nil {
		return copiedProjectPassport{}, err
	}
	var code string
	if err := tx.QueryRowContext(ctx, `SELECT code FROM component_types WHERE id=$1`, req.TypeID).Scan(&code); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return copiedProjectPassport{}, creationError("Тип оборудования не найден", 400)
		}
		return copiedProjectPassport{}, err
	}
	if version.Document.ComponentTypeCode != code {
		return copiedProjectPassport{}, creationError("Паспорт не соответствует типу оборудования", 400)
	}
	// A changed unit contract must not reinterpret old strings at creation time.
	if err := checkPassportParameters(ctx, tx, version.Document); err != nil {
		if errors.Is(err, errPassportInput) {
			return copiedProjectPassport{}, creationError("Параметры или единицы паспорта несовместимы с текущим шаблоном", 400)
		}
		return copiedProjectPassport{}, err
	}
	params := make(map[string]string, len(version.Document.Parameters)+len(req.Params))
	units := map[string]string{}
	for key, p := range version.Document.Parameters {
		params[key] = p.Value
		if p.Unit != "" {
			if !validParameterUnitLabel(p.Unit) {
				return copiedProjectPassport{}, creationError("Обозначение единицы паспорта не поддерживается форматом декларации", 400)
			}
			units[key] = p.Unit
		}
	}
	if len(req.Params) > 0 {
		rows, err := tx.QueryContext(ctx, `SELECT param_key,coalesce(unit,'') FROM component_params_template WHERE component_type_id=$1`, req.TypeID)
		if err != nil {
			return copiedProjectPassport{}, err
		}
		overrides := passportDocument{ComponentTypeCode: code, Parameters: map[string]passportParameter{}}
		for rows.Next() {
			var key, unit string
			if err := rows.Scan(&key, &unit); err != nil {
				rows.Close()
				return copiedProjectPassport{}, err
			}
			if value, ok := req.Params[key]; ok {
				overrides.Parameters[key] = passportParameter{Value: value, Unit: unit}
			}
		}
		err = rows.Err()
		rows.Close()
		if err != nil {
			return copiedProjectPassport{}, err
		}
		if len(overrides.Parameters) != len(req.Params) {
			return copiedProjectPassport{}, creationError("Неизвестный параметр экземпляра", 400)
		}
		if err := checkPassportParameters(ctx, tx, overrides); err != nil {
			if errors.Is(err, errPassportInput) {
				return copiedProjectPassport{}, creationError("Некорректные параметры экземпляра", 400)
			}
			return copiedProjectPassport{}, err
		}
		for key, value := range req.Params {
			params[key] = value
		}
	}
	result := copiedProjectPassport{Params: params}
	if len(units) > 0 {
		result.Declaration = &parameterUnitDeclaration{1, units}
	}
	return result, nil
}
