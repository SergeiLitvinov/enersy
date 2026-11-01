-- v1 remains immutable. Receipts and graph changes commit in one transaction.
ALTER TABLE circuit_schemes ADD CONSTRAINT circuit_schemes_id_project_key UNIQUE (id, project_id);

CREATE TABLE project_application_commands (
    project_id bigint NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    command_id uuid NOT NULL,
    scheme_id integer NOT NULL,
    account_id bigint NOT NULL REFERENCES auth_accounts(id),
    operation text NOT NULL CHECK (operation IN ('component.create.v1')),
    intent_sha256 text NOT NULL CHECK (intent_sha256 ~ '^[0-9a-f]{64}$'),
    receipt jsonb NOT NULL CHECK (jsonb_typeof(receipt) = 'object' AND octet_length(receipt::text) <= 8388608),
    created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
    PRIMARY KEY (project_id, command_id),
    FOREIGN KEY (scheme_id, project_id) REFERENCES circuit_schemes(id, project_id) ON DELETE CASCADE
);
CREATE INDEX project_application_commands_scheme_idx ON project_application_commands(scheme_id, project_id);

CREATE FUNCTION protect_application_command() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    -- Deleting the owning diagram/project removes its receipts. Ordinary
    -- receipt deletion would silently permit executing the same command again.
    IF TG_OP = 'DELETE' AND NOT EXISTS (SELECT 1 FROM circuit_schemes WHERE id = OLD.scheme_id AND project_id = OLD.project_id) THEN
        RETURN OLD;
    END IF;
    RAISE EXCEPTION 'Application command receipts are immutable' USING ERRCODE = '55000';
END;
$$;
CREATE TRIGGER application_command_immutable BEFORE UPDATE OR DELETE ON project_application_commands
FOR EACH ROW EXECUTE FUNCTION protect_application_command();
