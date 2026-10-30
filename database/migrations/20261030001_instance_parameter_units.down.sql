-- Refuse to discard explicit user declarations. This validating DDL also takes
-- the table lock before the columns can be removed.
ALTER TABLE scheme_component_params ADD CONSTRAINT instance_units_empty_for_downgrade
    CHECK (unit_format_version IS NULL AND declared_unit IS NULL);
ALTER TABLE scheme_component_params
    DROP CONSTRAINT instance_units_empty_for_downgrade,
    DROP CONSTRAINT instance_parameter_unit_declaration,
    DROP COLUMN declared_unit,
    DROP COLUMN unit_format_version;
