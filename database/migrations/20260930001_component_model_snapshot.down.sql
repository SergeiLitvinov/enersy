ALTER TABLE scheme_components DROP CONSTRAINT IF EXISTS scheme_component_model_type_fk;
ALTER TABLE scheme_components DROP COLUMN IF EXISTS equipment_model_id;
DROP INDEX IF EXISTS equipment_models_id_type_idx;
