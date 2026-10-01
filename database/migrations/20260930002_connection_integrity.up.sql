-- Legacy port descriptors. This does not declare mathematical model support.
CREATE TABLE IF NOT EXISTS component_type_ports (
    component_type_id INTEGER NOT NULL REFERENCES component_types(id),
    port_name VARCHAR(50) NOT NULL,
    domain VARCHAR(50) NOT NULL,
    PRIMARY KEY (component_type_id, port_name)
);
INSERT INTO component_type_ports(component_type_id,port_name,domain)
SELECT ct.id, p.port_name, 'electrical-ac'
FROM component_types ct JOIN (VALUES
 ('generator','top'),('generator','bottom'),
 ('transformer','top'),('transformer','bottom'),('transformer','left'),('transformer','right'),('transformer','a'),('transformer','b'),
 ('autotransformer','top'),('autotransformer','bottom'),('autotransformer','left'),('autotransformer','right'),('autotransformer','a'),('autotransformer','b'),
 ('transformer_3w','top'),('transformer_3w','bl'),('transformer_3w','br'),('transformer_3w','left'),('transformer_3w','right'),('transformer_3w','bottom'),
 ('transmission_line','left'),('transmission_line','right'),('transmission_line','top'),('transmission_line','bottom'),
 ('breaker','top'),('breaker','bottom'),('disconnector','top'),('disconnector','bottom'),
 ('busbar','left'),('busbar','right'),('load','top'),('ground','top'),('grounding_switch','top'),('capacitor','top'),('reactor','top')
) AS p(code,port_name) ON p.code=ct.code ON CONFLICT DO NOTHING;

CREATE UNIQUE INDEX IF NOT EXISTS scheme_components_id_scheme_idx ON scheme_components(id,scheme_id);
-- NOT VALID preserves legacy data for an explicit audit; new writes are enforced.
DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='connection_from_scheme_fk' AND conrelid='scheme_connections'::regclass) THEN
        ALTER TABLE scheme_connections ADD CONSTRAINT connection_from_scheme_fk
            FOREIGN KEY(from_component_id,scheme_id) REFERENCES scheme_components(id,scheme_id) ON DELETE CASCADE NOT VALID;
        ALTER TABLE scheme_connections ADD CONSTRAINT connection_to_scheme_fk
            FOREIGN KEY(to_component_id,scheme_id) REFERENCES scheme_components(id,scheme_id) ON DELETE CASCADE NOT VALID;
    END IF;
END $$;

CREATE OR REPLACE FUNCTION check_connection_ports() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE from_domain TEXT; to_domain TEXT;
BEGIN
    SELECT p.domain INTO from_domain FROM scheme_components c JOIN component_type_ports p
        ON p.component_type_id=c.component_type_id WHERE c.id=NEW.from_component_id AND c.scheme_id=NEW.scheme_id AND p.port_name=NEW.from_port;
    SELECT p.domain INTO to_domain FROM scheme_components c JOIN component_type_ports p
        ON p.component_type_id=c.component_type_id WHERE c.id=NEW.to_component_id AND c.scheme_id=NEW.scheme_id AND p.port_name=NEW.to_port;
    IF from_domain IS NULL OR to_domain IS NULL OR from_domain <> to_domain OR
       (NEW.from_component_id=NEW.to_component_id AND NEW.from_port=NEW.to_port) THEN
        RAISE EXCEPTION 'Unknown, incompatible or identical connection ports' USING ERRCODE='23514';
    END IF;
    RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS connection_ports_check ON scheme_connections;
CREATE TRIGGER connection_ports_check BEFORE INSERT OR UPDATE ON scheme_connections
    FOR EACH ROW EXECUTE FUNCTION check_connection_ports();

CREATE OR REPLACE VIEW invalid_scheme_connections AS
SELECT c.*, array_remove(ARRAY[
    CASE WHEN c.scheme_id IS NULL OR f.scheme_id IS DISTINCT FROM c.scheme_id OR t.scheme_id IS DISTINCT FROM c.scheme_id THEN 'scheme_mismatch' END,
    CASE WHEN fp.domain IS NULL OR tp.domain IS NULL THEN 'unknown_port' END,
    CASE WHEN fp.domain IS NOT NULL AND tp.domain IS NOT NULL AND fp.domain <> tp.domain THEN 'domain_mismatch' END,
    CASE WHEN c.from_component_id=c.to_component_id AND c.from_port=c.to_port THEN 'identical_port' END
], NULL) AS reasons
FROM scheme_connections c
LEFT JOIN scheme_components f ON f.id=c.from_component_id
LEFT JOIN scheme_components t ON t.id=c.to_component_id
LEFT JOIN component_type_ports fp ON fp.component_type_id=f.component_type_id AND fp.port_name=c.from_port
LEFT JOIN component_type_ports tp ON tp.component_type_id=t.component_type_id AND tp.port_name=c.to_port
WHERE c.scheme_id IS NULL OR f.scheme_id IS DISTINCT FROM c.scheme_id OR t.scheme_id IS DISTINCT FROM c.scheme_id
   OR fp.domain IS NULL OR tp.domain IS NULL OR fp.domain <> tp.domain
   OR (c.from_component_id=c.to_component_id AND c.from_port=c.to_port);
