ALTER TABLE circuit_schemes ADD COLUMN topology_revision BIGINT NOT NULL DEFAULT 0 CHECK(topology_revision >= 0);

CREATE FUNCTION increment_scheme_topology() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE affected INTEGER[];
BEGIN
    IF TG_OP='INSERT' THEN
        SELECT array_agg(DISTINCT scheme_id) INTO affected FROM new_rows;
    ELSIF TG_OP='DELETE' THEN
        SELECT array_agg(DISTINCT scheme_id) INTO affected FROM old_rows;
    ELSIF TG_TABLE_NAME='scheme_components' THEN
        SELECT array_agg(DISTINCT id) INTO affected FROM (
            SELECT unnest(ARRAY[o.scheme_id,n.scheme_id]) AS id FROM old_rows o JOIN new_rows n USING(id)
            WHERE o.scheme_id IS DISTINCT FROM n.scheme_id OR o.component_type_id IS DISTINCT FROM n.component_type_id
        ) changed;
    ELSE
        SELECT array_agg(DISTINCT id) INTO affected FROM (
            SELECT unnest(ARRAY[o.scheme_id,n.scheme_id]) AS id FROM old_rows o JOIN new_rows n USING(id)
            WHERE o.scheme_id IS DISTINCT FROM n.scheme_id OR o.from_component_id IS DISTINCT FROM n.from_component_id
               OR o.to_component_id IS DISTINCT FROM n.to_component_id OR o.from_port IS DISTINCT FROM n.from_port
               OR o.to_port IS DISTINCT FROM n.to_port
        ) changed;
    END IF;
    -- One increment per affected scheme/statement, including bulk imports.
    PERFORM id FROM circuit_schemes WHERE id=ANY(affected) ORDER BY id FOR UPDATE;
    UPDATE circuit_schemes SET topology_revision=topology_revision+1 WHERE id=ANY(affected);
    RETURN NULL;
END; $$;

CREATE TRIGGER component_topology_insert AFTER INSERT ON scheme_components REFERENCING NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION increment_scheme_topology();
CREATE TRIGGER component_topology_delete AFTER DELETE ON scheme_components REFERENCING OLD TABLE AS old_rows FOR EACH STATEMENT EXECUTE FUNCTION increment_scheme_topology();
CREATE TRIGGER component_topology_update AFTER UPDATE ON scheme_components REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION increment_scheme_topology();
CREATE TRIGGER connection_topology_insert AFTER INSERT ON scheme_connections REFERENCING NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION increment_scheme_topology();
CREATE TRIGGER connection_topology_delete AFTER DELETE ON scheme_connections REFERENCING OLD TABLE AS old_rows FOR EACH STATEMENT EXECUTE FUNCTION increment_scheme_topology();
CREATE TRIGGER connection_topology_update AFTER UPDATE ON scheme_connections REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION increment_scheme_topology();
