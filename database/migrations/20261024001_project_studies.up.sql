-- A Study version freezes the coherent source graph and explicit solve options.
-- Scheme ID is historical, like calculation archives: deleting a mutable scheme
-- must not erase its previously captured studies. Project ownership stays live.
CREATE TABLE project_studies (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    project_id BIGINT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    scheme_id INTEGER NOT NULL CHECK(scheme_id > 0),
    current_revision BIGINT NOT NULL CHECK(current_revision > 0),
    created_by BIGINT NOT NULL REFERENCES auth_accounts(id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT statement_timestamp(),
    UNIQUE(id,project_id)
);
CREATE TABLE project_study_versions (
    study_id BIGINT NOT NULL,
    project_id BIGINT NOT NULL,
    revision BIGINT NOT NULL CHECK(revision > 0),
    author_account_id BIGINT NOT NULL REFERENCES auth_accounts(id),
    command_id UUID NOT NULL,
    command_sha256 TEXT NOT NULL CHECK(command_sha256 ~ '^[0-9a-f]{64}$'),
    topology_revision BIGINT NOT NULL CHECK(topology_revision >= 0),
    scheme_name TEXT NOT NULL,
    document JSONB NOT NULL CHECK(jsonb_typeof(document)='object' AND document @> '{"formatVersion":1}'::jsonb AND octet_length(document::text)<=131072),
    input_body BYTEA NOT NULL CHECK(octet_length(input_body) BETWEEN 1 AND 8388608),
    provenance_body BYTEA NOT NULL CHECK(octet_length(provenance_body) BETWEEN 1 AND 8388608),
    input_sha256 TEXT GENERATED ALWAYS AS (encode(sha256(input_body),'hex')) STORED,
    provenance_sha256 TEXT GENERATED ALWAYS AS (encode(sha256(provenance_body),'hex')) STORED,
    created_at TIMESTAMPTZ NOT NULL DEFAULT statement_timestamp(),
    PRIMARY KEY(study_id,revision),
    UNIQUE(project_id,command_id),
    FOREIGN KEY(study_id,project_id) REFERENCES project_studies(id,project_id) ON DELETE CASCADE
);
ALTER TABLE project_studies ADD CONSTRAINT project_study_head
    FOREIGN KEY(id,current_revision) REFERENCES project_study_versions(study_id,revision)
    DEFERRABLE INITIALLY DEFERRED;
CREATE INDEX project_studies_page ON project_studies(project_id,id);
CREATE INDEX project_study_versions_project ON project_study_versions(project_id);
CREATE FUNCTION validate_study_source() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    PERFORM id FROM circuit_schemes WHERE id=NEW.scheme_id AND project_id=NEW.project_id FOR SHARE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Study source must belong to its project at capture' USING ERRCODE='23514';
    END IF;
    RETURN NEW;
END;
$$;
CREATE TRIGGER study_source_guard BEFORE INSERT ON project_studies
    FOR EACH ROW EXECUTE FUNCTION validate_study_source();
CREATE FUNCTION protect_study_version() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    -- A project-wide deletion may remove its private history. There is no
    -- standalone version deletion API, and direct edits/deletes are rejected.
    IF TG_OP='DELETE' AND NOT EXISTS(SELECT 1 FROM projects WHERE id=OLD.project_id) THEN
        RETURN OLD;
    END IF;
    RAISE EXCEPTION 'Study versions are immutable' USING ERRCODE='23514';
END;
$$;
CREATE TRIGGER study_version_immutable BEFORE UPDATE OR DELETE ON project_study_versions
    FOR EACH ROW EXECUTE FUNCTION protect_study_version();
CREATE FUNCTION protect_study_head() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.id IS DISTINCT FROM OLD.id OR NEW.project_id IS DISTINCT FROM OLD.project_id
       OR NEW.scheme_id IS DISTINCT FROM OLD.scheme_id OR NEW.created_by IS DISTINCT FROM OLD.created_by
       OR NEW.created_at IS DISTINCT FROM OLD.created_at OR NEW.current_revision<>OLD.current_revision+1 THEN
        RAISE EXCEPTION 'Study identity is immutable and revisions advance by one' USING ERRCODE='23514';
    END IF;
    RETURN NEW;
END;
$$;
CREATE TRIGGER study_head_guard BEFORE UPDATE ON project_studies
    FOR EACH ROW EXECUTE FUNCTION protect_study_head();
