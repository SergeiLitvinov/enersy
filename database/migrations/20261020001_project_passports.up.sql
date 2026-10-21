-- Project drafts are separate from the shared legacy catalog. A draft does not
-- assert verified physics or publication rights and cannot yet bind equipment.
CREATE TABLE project_passports (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    project_id BIGINT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    author_account_id BIGINT NOT NULL REFERENCES auth_accounts(id),
    command_id UUID NOT NULL,
    predecessor_id BIGINT,
    revision INTEGER NOT NULL CHECK (revision > 0),
    component_type_code VARCHAR(50) NOT NULL REFERENCES component_types(code),
    document BYTEA NOT NULL CHECK (octet_length(document) BETWEEN 1 AND 65536),
    sha256 TEXT NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
    created_at TIMESTAMPTZ NOT NULL DEFAULT statement_timestamp(),
    UNIQUE(project_id, id),
    UNIQUE(project_id, command_id),
    UNIQUE(predecessor_id),
    FOREIGN KEY(project_id, predecessor_id) REFERENCES project_passports(project_id, id),
    CHECK ((predecessor_id IS NULL AND revision=1) OR (predecessor_id IS NOT NULL AND revision>1))
);
CREATE INDEX project_passports_page ON project_passports(project_id, id);
CREATE FUNCTION reject_project_passport_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    RAISE EXCEPTION 'Project passport versions are immutable' USING ERRCODE = '23514';
END;
$$;
CREATE TRIGGER project_passport_immutable BEFORE UPDATE ON project_passports
FOR EACH ROW EXECUTE FUNCTION reject_project_passport_update();
