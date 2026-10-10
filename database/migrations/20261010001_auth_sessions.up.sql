-- Legacy users(name) is demo data, not an authenticated identity.
-- Accounts are explicitly provisioned; no demo account/session is enrolled.
CREATE TABLE auth_accounts (
    id BIGSERIAL PRIMARY KEY,
    display_name TEXT NOT NULL CHECK (length(btrim(display_name)) > 0),
    created_at TIMESTAMPTZ NOT NULL DEFAULT statement_timestamp(),
    disabled_at TIMESTAMPTZ
);
CREATE TABLE auth_sessions (
    id BIGSERIAL PRIMARY KEY,
    account_id BIGINT NOT NULL REFERENCES auth_accounts(id) ON DELETE CASCADE,
    token_hash BYTEA NOT NULL UNIQUE CHECK (octet_length(token_hash) = 32),
    issued_at TIMESTAMPTZ NOT NULL DEFAULT statement_timestamp(),
    expires_at TIMESTAMPTZ NOT NULL,
    revoked_at TIMESTAMPTZ,
    CHECK (expires_at > issued_at),
    CHECK (revoked_at IS NULL OR revoked_at >= issued_at)
);
CREATE INDEX auth_sessions_account_idx ON auth_sessions(account_id);
