-- Losing provenance is not a safe automatic downgrade.
DO $$ BEGIN
    IF EXISTS(SELECT 1 FROM scheme_components WHERE project_passport_version_id IS NOT NULL) THEN
        RAISE EXCEPTION 'Bound project passports require manual recovery before downgrade';
    END IF;
END $$;
DROP TRIGGER bound_scheme_project ON circuit_schemes;
DROP FUNCTION protect_bound_scheme_project();
DROP TRIGGER component_passport_binding ON scheme_components;
DROP FUNCTION check_component_passport_binding();
ALTER TABLE scheme_components DROP CONSTRAINT component_one_passport;
ALTER TABLE scheme_components DROP COLUMN project_passport_version_id;
