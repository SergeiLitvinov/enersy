package main

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"database/sql"
	"encoding/base64"
	"errors"
	"time"
)

var errSessionUnavailable = errors.New("session unavailable")
var errSessionLifetime = errors.New("session lifetime must be between one second and 30 days")

const maxSessionLifetime = 30 * 24 * time.Hour

// Issue requires a trusted login or provisioning flow;
// knowing an account ID must never grant a session.
type sessionStore struct{ database *sql.DB }
type sessionIdentity struct {
	AccountID int64
	SessionID int64
	ExpiresAt time.Time
}

// Token is returned once to the trusted issuer and never stored or logged.
type issuedSession struct {
	Identity sessionIdentity
	Token    string
}

func sessionTokenHash(token string) ([]byte, error) {
	// Fixed-size credential: reject oversized input before decoding allocates.
	if len(token) != 43 {
		return nil, errSessionUnavailable
	}
	decoded, err := base64.RawURLEncoding.Strict().DecodeString(token)
	if err != nil || len(decoded) != 32 || base64.RawURLEncoding.EncodeToString(decoded) != token {
		return nil, errSessionUnavailable
	}
	digest := sha256.Sum256(decoded)
	return digest[:], nil
}

func (store sessionStore) Issue(ctx context.Context, accountID int64, lifetime time.Duration) (issuedSession, error) {
	if lifetime < time.Second || lifetime > maxSessionLifetime {
		return issuedSession{}, errSessionLifetime
	}
	var random [32]byte
	if _, err := rand.Read(random[:]); err != nil {
		return issuedSession{}, err
	}
	token := base64.RawURLEncoding.EncodeToString(random[:])
	hash := sha256.Sum256(random[:])
	identity := sessionIdentity{AccountID: accountID}
	err := store.database.QueryRowContext(ctx, `INSERT INTO auth_sessions(account_id,token_hash,expires_at)
 SELECT id,$2,statement_timestamp()+$3::bigint*interval '1 microsecond'
 FROM auth_accounts WHERE id=$1 AND disabled_at IS NULL
 RETURNING id,expires_at`, accountID, hash[:], lifetime.Microseconds()).Scan(&identity.SessionID, &identity.ExpiresAt)
	if errors.Is(err, sql.ErrNoRows) {
		return issuedSession{}, errSessionUnavailable
	}
	if err != nil {
		return issuedSession{}, err
	}
	return issuedSession{Identity: identity, Token: token}, nil
}

func (store sessionStore) Authenticate(ctx context.Context, token string) (sessionIdentity, error) {
	hash, err := sessionTokenHash(token)
	if err != nil {
		return sessionIdentity{}, err
	}
	var identity sessionIdentity
	err = store.database.QueryRowContext(ctx, `SELECT s.account_id,s.id,s.expires_at
 FROM auth_sessions s JOIN auth_accounts a ON a.id=s.account_id
 WHERE s.token_hash=$1 AND s.revoked_at IS NULL AND s.expires_at>statement_timestamp()
 AND a.disabled_at IS NULL`, hash).Scan(&identity.AccountID, &identity.SessionID, &identity.ExpiresAt)
	if errors.Is(err, sql.ErrNoRows) {
		return sessionIdentity{}, errSessionUnavailable
	}
	if err != nil {
		return sessionIdentity{}, err
	}
	return identity, nil
}

// Verify the actor in the same statement; caller-supplied account IDs cannot
// authorize revoking somebody else's session. Repeated own revocation is
// idempotent while the actor still has a valid session.
func (store sessionStore) Revoke(ctx context.Context, actorToken string, targetSessionID int64) error {
	hash, err := sessionTokenHash(actorToken)
	if err != nil {
		return err
	}
	var id int64
	err = store.database.QueryRowContext(ctx, `UPDATE auth_sessions target
 SET revoked_at=COALESCE(target.revoked_at,statement_timestamp())
 FROM auth_sessions actor JOIN auth_accounts account ON account.id=actor.account_id
 WHERE actor.token_hash=$1 AND actor.revoked_at IS NULL AND actor.expires_at>statement_timestamp()
 AND account.disabled_at IS NULL AND target.account_id=actor.account_id AND target.id=$2
 RETURNING target.id`, hash, targetSessionID).Scan(&id)
	if errors.Is(err, sql.ErrNoRows) {
		return errSessionUnavailable
	}
	return err
}

func (store sessionStore) RevokeAll(ctx context.Context, actorToken string) error {
	hash, err := sessionTokenHash(actorToken)
	if err != nil {
		return err
	}
	result, err := store.database.ExecContext(ctx, `UPDATE auth_sessions target
 SET revoked_at=COALESCE(target.revoked_at,statement_timestamp())
 FROM auth_sessions actor JOIN auth_accounts account ON account.id=actor.account_id
 WHERE actor.token_hash=$1 AND actor.revoked_at IS NULL AND actor.expires_at>statement_timestamp()
 AND account.disabled_at IS NULL AND target.account_id=actor.account_id`, hash)
	if err != nil {
		return err
	}
	changed, err := result.RowsAffected()
	if err != nil {
		return err
	}
	if changed == 0 {
		return errSessionUnavailable
	}
	return nil
}
