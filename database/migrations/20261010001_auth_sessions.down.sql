-- Destructive maintenance only: removes identities and revocation history.
DROP TABLE auth_sessions;
DROP TABLE auth_accounts;
