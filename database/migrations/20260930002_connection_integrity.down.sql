DROP VIEW IF EXISTS invalid_scheme_connections;
DROP TRIGGER IF EXISTS connection_ports_check ON scheme_connections;
DROP FUNCTION IF EXISTS check_connection_ports();
ALTER TABLE scheme_connections DROP CONSTRAINT IF EXISTS connection_from_scheme_fk;
ALTER TABLE scheme_connections DROP CONSTRAINT IF EXISTS connection_to_scheme_fk;
DROP INDEX IF EXISTS scheme_components_id_scheme_idx;
DROP TABLE IF EXISTS component_type_ports;
