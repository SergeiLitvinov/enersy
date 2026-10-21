-- Successful synchronous calculations only. Job orchestration is a later stage.
CREATE TABLE project_calculation_archives (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    project_id BIGINT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    -- Historical identifier, intentionally not a mutable scheme FK. A deleted
    -- scheme must not erase or rewrite the request that produced this result.
    scheme_id INTEGER NOT NULL CHECK (scheme_id > 0),
    scheme_name TEXT NOT NULL,
    author_account_id BIGINT NOT NULL REFERENCES auth_accounts(id),
    topology_revision BIGINT NOT NULL CHECK (topology_revision >= 0),
    model_group TEXT NOT NULL CHECK (length(model_group) BETWEEN 1 AND 64),
    method TEXT NOT NULL CHECK (length(method) BETWEEN 1 AND 64),
    created_at TIMESTAMPTZ NOT NULL DEFAULT statement_timestamp(),
    -- BYTEA retains exact JSON bytes, including decimal digits and exponents.
    input_body BYTEA NOT NULL CHECK (octet_length(input_body) BETWEEN 1 AND 8388608),
    result_body BYTEA NOT NULL CHECK (octet_length(result_body) BETWEEN 1 AND 8388608),
    input_sha256 TEXT NOT NULL CHECK (input_sha256 ~ '^[0-9a-f]{64}$'),
    result_sha256 TEXT NOT NULL CHECK (result_sha256 ~ '^[0-9a-f]{64}$')
);
CREATE INDEX project_calculation_archives_page ON project_calculation_archives(project_id, id DESC);
CREATE FUNCTION reject_calculation_archive_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    RAISE EXCEPTION 'Calculation archives are immutable' USING ERRCODE = '23514';
END;
$$;
CREATE TRIGGER calculation_archive_immutable BEFORE UPDATE ON project_calculation_archives
FOR EACH ROW EXECUTE FUNCTION reject_calculation_archive_update();
