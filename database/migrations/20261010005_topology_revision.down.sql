DROP TRIGGER connection_topology_update ON scheme_connections;
DROP TRIGGER connection_topology_delete ON scheme_connections;
DROP TRIGGER connection_topology_insert ON scheme_connections;
DROP TRIGGER component_topology_update ON scheme_components;
DROP TRIGGER component_topology_delete ON scheme_components;
DROP TRIGGER component_topology_insert ON scheme_components;
DROP FUNCTION increment_scheme_topology();
ALTER TABLE circuit_schemes DROP COLUMN topology_revision;
