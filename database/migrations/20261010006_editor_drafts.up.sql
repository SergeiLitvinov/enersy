-- Private recovery intentions, independent of shared physical scheme revisions.
CREATE TABLE project_editor_drafts (
    account_id BIGINT NOT NULL REFERENCES auth_accounts(id) ON DELETE CASCADE,
    scheme_id INTEGER NOT NULL REFERENCES circuit_schemes(id) ON DELETE CASCADE,
    workspace_id UUID NOT NULL,
    revision BIGINT NOT NULL CHECK (revision > 0),
    payload JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT statement_timestamp(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT statement_timestamp(),
    deleted_at TIMESTAMPTZ,
    PRIMARY KEY (account_id, scheme_id, workspace_id),
    CHECK ((deleted_at IS NULL AND payload IS NOT NULL) OR (deleted_at IS NOT NULL AND payload IS NULL)),
    CHECK (payload IS NULL OR (jsonb_typeof(payload) = 'object' AND payload @> '{"formatVersion":1}'::jsonb AND octet_length(payload::text) <= 524288))
);
CREATE INDEX project_editor_drafts_account_active ON project_editor_drafts(account_id, scheme_id, updated_at DESC, workspace_id)
    WHERE deleted_at IS NULL;
