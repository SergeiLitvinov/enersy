-- Historical archives have no evidence for this metadata. Never backfill it
-- from the current graph or catalog.
ALTER TABLE project_calculation_archives
    ADD COLUMN provenance_body BYTEA,
    ADD COLUMN provenance_sha256 TEXT,
    ADD CONSTRAINT archive_provenance_pair CHECK (
        (provenance_body IS NULL AND provenance_sha256 IS NULL) OR
        (provenance_body IS NOT NULL AND provenance_sha256 IS NOT NULL AND
         octet_length(provenance_body) BETWEEN 1 AND 8388608 AND
         provenance_sha256 ~ '^[0-9a-f]{64}$')
    );
