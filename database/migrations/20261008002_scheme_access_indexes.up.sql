-- PostgreSQL does not automatically index referencing FK columns.
-- Keep scheme reads and equipment deletion local to the requested graph.
CREATE INDEX scheme_components_scheme_idx ON scheme_components(scheme_id);
CREATE INDEX scheme_connections_scheme_idx ON scheme_connections(scheme_id);
CREATE INDEX scheme_connections_from_scheme_idx ON scheme_connections(from_component_id, scheme_id);
CREATE INDEX scheme_connections_to_scheme_idx ON scheme_connections(to_component_id, scheme_id);
