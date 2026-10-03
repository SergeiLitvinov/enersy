-- Administrative rollback only: dropping revisions loses concurrency history.
DROP TRIGGER component_parameter_revision ON scheme_component_params;
DROP FUNCTION enersy_bump_parameter_revision();
DROP TRIGGER component_revision ON scheme_components;
DROP FUNCTION enersy_bump_component_revision();
ALTER TABLE scheme_components DROP COLUMN revision;
