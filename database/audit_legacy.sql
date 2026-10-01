-- Read-only audit. No DELETE, renumbering or automatic repair.
-- users is a legacy demonstration table, not an implemented access system.
SELECT name, count(*) AS duplicate_count, array_agg(id ORDER BY id) AS ids
FROM users GROUP BY name HAVING count(*) > 1 ORDER BY name;

SELECT id, scheme_id, reasons FROM invalid_scheme_connections ORDER BY scheme_id,id;

SELECT version,dirty FROM schema_migrations;
