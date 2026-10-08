-- Successful commands outlive deletion of their connection: replay must not recreate it.
-- Scheme scope is not authorization. Enforce project access before lookup when auth is added.
CREATE TABLE connection_commands (
    scheme_id INTEGER NOT NULL REFERENCES circuit_schemes(id) ON DELETE CASCADE,
    command_id UUID NOT NULL,
    payload_hash BYTEA NOT NULL CHECK (octet_length(payload_hash) = 32),
    connection_id INTEGER NOT NULL CHECK (connection_id > 0),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (scheme_id, command_id)
);
