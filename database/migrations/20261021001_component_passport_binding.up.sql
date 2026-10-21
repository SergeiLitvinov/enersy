ALTER TABLE scheme_components ADD COLUMN project_passport_version_id BIGINT REFERENCES project_passports(id);
ALTER TABLE scheme_components ADD CONSTRAINT component_one_passport CHECK
    (equipment_model_id IS NULL OR project_passport_version_id IS NULL);

-- A global numeric FK alone cannot enforce project/type membership. The
-- passport ID is fixed for the lifetime of the component; parameter edits are
-- instance overrides, never edits of the referenced catalog version.
CREATE FUNCTION check_component_passport_binding() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE scheme_project BIGINT; passport_project BIGINT; passport_code TEXT; component_code TEXT;
BEGIN
    IF TG_OP='UPDATE' AND OLD.project_passport_version_id IS DISTINCT FROM NEW.project_passport_version_id THEN
        RAISE EXCEPTION 'Component passport binding is immutable' USING ERRCODE='23514';
    END IF;
    IF NEW.project_passport_version_id IS NULL THEN RETURN NEW; END IF;
    SELECT project_id INTO scheme_project FROM circuit_schemes WHERE id=NEW.scheme_id;
    SELECT project_id,component_type_code INTO passport_project,passport_code
        FROM project_passports WHERE id=NEW.project_passport_version_id;
    SELECT code INTO component_code FROM component_types WHERE id=NEW.component_type_id;
    IF scheme_project IS NULL OR scheme_project IS DISTINCT FROM passport_project OR component_code IS DISTINCT FROM passport_code THEN
        RAISE EXCEPTION 'Passport does not belong to the component project and type' USING ERRCODE='23514';
    END IF;
    RETURN NEW;
END;
$$;
CREATE TRIGGER component_passport_binding BEFORE INSERT OR UPDATE ON scheme_components
FOR EACH ROW EXECUTE FUNCTION check_component_passport_binding();

CREATE FUNCTION protect_bound_scheme_project() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF OLD.project_id IS DISTINCT FROM NEW.project_id AND EXISTS
        (SELECT 1 FROM scheme_components WHERE scheme_id=OLD.id AND project_passport_version_id IS NOT NULL) THEN
        RAISE EXCEPTION 'A scheme with bound passports cannot change project' USING ERRCODE='23514';
    END IF;
    RETURN NEW;
END;
$$;
CREATE TRIGGER bound_scheme_project BEFORE UPDATE OF project_id ON circuit_schemes
FOR EACH ROW EXECUTE FUNCTION protect_bound_scheme_project();
