-- Keep catalogue provenance while parameters remain an editable instance snapshot.
ALTER TABLE scheme_components ADD COLUMN IF NOT EXISTS equipment_model_id INTEGER;
CREATE UNIQUE INDEX IF NOT EXISTS equipment_models_id_type_idx
    ON equipment_models (id, component_type_id);
DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint
        WHERE conname = 'scheme_component_model_type_fk' AND conrelid = 'scheme_components'::regclass) THEN
        ALTER TABLE scheme_components ADD CONSTRAINT scheme_component_model_type_fk
            FOREIGN KEY (equipment_model_id, component_type_id)
            REFERENCES equipment_models (id, component_type_id);
    END IF;
END $$;
