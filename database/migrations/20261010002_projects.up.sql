CREATE TABLE projects (
    id BIGSERIAL PRIMARY KEY,
    owner_account_id BIGINT NOT NULL REFERENCES auth_accounts(id) ON DELETE RESTRICT,
    name TEXT NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 200),
    created_at TIMESTAMPTZ NOT NULL DEFAULT statement_timestamp()
);
CREATE INDEX projects_owner_idx ON projects(owner_account_id);
CREATE TABLE project_members (
    project_id BIGINT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    account_id BIGINT NOT NULL REFERENCES auth_accounts(id) ON DELETE CASCADE,
    role TEXT NOT NULL CHECK (role IN ('viewer','editor','admin')),
    PRIMARY KEY(project_id,account_id)
);
CREATE INDEX project_members_account_idx ON project_members(account_id,project_id);

-- Existing owner_id points to demo users, not authenticated accounts.
-- Leave legacy schemes unassigned until explicit ownership migration exists.
ALTER TABLE circuit_schemes ADD COLUMN project_id BIGINT REFERENCES projects(id) ON DELETE RESTRICT;
CREATE INDEX circuit_schemes_project_idx ON circuit_schemes(project_id);
