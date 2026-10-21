package main

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"strconv"
)

var errCalculationProvenanceLimit = errors.New("calculation provenance exceeds archive limit")

// Audit evidence is captured in the same snapshot as the worker input, but is
// never sent to the numerical worker or included in its request digest.
type calculationProvenance struct {
	FormatVersion int                   `json:"formatVersion"`
	Components    []componentProvenance `json:"components"`
}
type componentProvenance struct {
	ID               string              `json:"id"`
	Revision         string              `json:"revision"`
	Name             string              `json:"name"`
	Source           string              `json:"source"`
	EquipmentModelID *string             `json:"equipmentModelId,omitempty"`
	Passport         *passportProvenance `json:"passport,omitempty"`
}
type passportProvenance struct {
	VersionID string           `json:"versionId"`
	Revision  int              `json:"revision"`
	SHA256    string           `json:"sha256"`
	Document  passportDocument `json:"document"`
}

func readCalculationProvenance(ctx context.Context, tx *sql.Tx, project int64, scheme int, components []calculationComponent) ([]byte, error) {
	rows, err := tx.QueryContext(ctx, `SELECT sc.id,sc.revision,coalesce(sc.custom_name,''),sc.equipment_model_id,
 sc.project_passport_version_id,pp.project_id,pp.component_type_code,pp.revision,pp.document,pp.sha256
 FROM scheme_components sc LEFT JOIN project_passports pp ON pp.id=sc.project_passport_version_id
 WHERE sc.scheme_id=$1 ORDER BY sc.id`, scheme)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	provenance := calculationProvenance{FormatVersion: 1, Components: []componentProvenance{}}
	size := 64
	for rows.Next() {
		var id, revision int64
		var model, version, parent, passportRevision sql.NullInt64
		var code, digest sql.NullString
		var document []byte
		item := componentProvenance{Source: "instance"}
		if err := rows.Scan(&id, &revision, &item.Name, &model, &version, &parent, &code, &passportRevision, &document, &digest); err != nil {
			return nil, err
		}
		index := len(provenance.Components)
		if index >= len(components) || int64(components[index].ID) != id {
			return nil, errArchiveCorrupt
		}
		item.ID, item.Revision = strconv.FormatInt(id, 10), strconv.FormatInt(revision, 10)
		if model.Valid {
			value := strconv.FormatInt(model.Int64, 10)
			item.EquipmentModelID, item.Source = &value, "legacy-catalog"
		}
		if version.Valid {
			var doc passportDocument
			if model.Valid || !parent.Valid || parent.Int64 != project || !code.Valid || code.String != components[index].Type ||
				!passportRevision.Valid || passportRevision.Int64 < 1 || !digest.Valid || archiveDigest(document) != digest.String ||
				json.Unmarshal(document, &doc) != nil || validatePassportDocument(doc) != nil || doc.ComponentTypeCode != code.String {
				return nil, errArchiveCorrupt
			}
			item.Source = "project-passport"
			item.Passport = &passportProvenance{VersionID: strconv.FormatInt(version.Int64, 10), Revision: int(passportRevision.Int64), SHA256: digest.String, Document: doc}
		}
		encoded, err := json.Marshal(item)
		if err != nil {
			return nil, err
		}
		size += len(encoded) + 1
		if size > computeBodyLimit {
			return nil, errCalculationProvenanceLimit
		}
		provenance.Components = append(provenance.Components, item)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	if len(provenance.Components) != len(components) {
		return nil, errArchiveCorrupt
	}
	return json.Marshal(provenance)
}
