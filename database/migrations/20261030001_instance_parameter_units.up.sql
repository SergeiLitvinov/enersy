-- Explicit declarations only. Existing values have no proven historical unit.
ALTER TABLE scheme_component_params
    ADD COLUMN unit_format_version SMALLINT,
    ADD COLUMN declared_unit TEXT,
    ADD CONSTRAINT instance_parameter_unit_declaration CHECK (
        (unit_format_version IS NULL AND declared_unit IS NULL) OR
        (unit_format_version IS NOT NULL AND unit_format_version = 1 AND
         declared_unit IS NOT NULL AND length(declared_unit) BETWEEN 1 AND 64 AND
         declared_unit = btrim(declared_unit) AND declared_unit !~ '[[:cntrl:]]')
    );
-- The existing parameter revision trigger compares the whole row, so unit-only
-- changes also advance the component revision and invalidate stale captures.
