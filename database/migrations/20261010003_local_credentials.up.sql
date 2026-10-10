CREATE TABLE auth_local_credentials (
    account_id BIGINT PRIMARY KEY REFERENCES auth_accounts(id) ON DELETE CASCADE,
    login TEXT NOT NULL UNIQUE CHECK (login ~ '^[a-z0-9][a-z0-9._-]{2,63}$'),
    password_hash TEXT NOT NULL CHECK (length(password_hash) BETWEEN 1 AND 256),
    created_at TIMESTAMPTZ NOT NULL DEFAULT statement_timestamp()
);
-- No default credentials, registration endpoint, or demo-user enrollment.
