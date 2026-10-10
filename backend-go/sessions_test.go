package main

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"
)

func TestSessionTokenEncoding(t *testing.T) {
	for _, token := range []string{"", "alice", "1", strings.Repeat("A", 100000), "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=", "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAB", "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA\n"} {
		if _, err := sessionTokenHash(token); !errors.Is(err, errSessionUnavailable) {
			t.Fatal("noncanonical token accepted")
		}
	}
	// All-zero bytes are a valid encoding, but don't grant a database identity.
	hash, err := sessionTokenHash("AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA")
	if err != nil || len(hash) != 32 {
		t.Fatal("valid token encoding rejected")
	}
}

func TestSessionStorePostgres(t *testing.T) {
	database := migrationTestDatabase(t)
	if err := runMigrationsFromSource(database, migrationSourceURL(t)); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	store := sessionStore{database: database}
	var enrolled int
	if err := database.QueryRowContext(ctx, `SELECT count(*) FROM auth_accounts`).Scan(&enrolled); err != nil || enrolled != 0 {
		t.Fatalf("demo users became authenticated accounts: count=%d err=%v", enrolled, err)
	}
	var alice, bob int64
	for _, id := range []*int64{&alice, &bob} {
		if err := database.QueryRowContext(ctx, `INSERT INTO auth_accounts(display_name) VALUES('Same display name') RETURNING id`).Scan(id); err != nil {
			t.Fatal(err)
		}
	}
	issue := func(account int64) issuedSession {
		t.Helper()
		result, err := store.Issue(ctx, account, time.Hour)
		if err != nil {
			t.Fatal(err)
		}
		if result.Token == "" || result.Identity.AccountID != account || result.Identity.SessionID <= 0 {
			t.Fatal("invalid issued identity")
		}
		return result
	}
	first, second, other := issue(alice), issue(alice), issue(bob)
	if first.Token == second.Token || first.Token == other.Token || second.Token == other.Token {
		t.Fatal("tokens are not independent")
	}
	valid := func(session issuedSession) {
		t.Helper()
		// Recreate the store: identities are read from PostgreSQL, not a Go map.
		identity, err := (sessionStore{database: database}).Authenticate(ctx, session.Token)
		if err != nil || identity.AccountID != session.Identity.AccountID || identity.SessionID != session.Identity.SessionID || !identity.ExpiresAt.Equal(session.Identity.ExpiresAt) {
			t.Fatal("persisted session did not authenticate correctly")
		}
	}
	invalid := func(session issuedSession) {
		t.Helper()
		if _, err := store.Authenticate(ctx, session.Token); !errors.Is(err, errSessionUnavailable) {
			t.Fatalf("unavailable session accepted: %v", err)
		}
	}
	for _, session := range []issuedSession{first, second, other} {
		valid(session)
		expected, err := sessionTokenHash(session.Token)
		if err != nil {
			t.Fatal(err)
		}
		var matches bool
		if err := database.QueryRowContext(ctx, `SELECT token_hash=$2 AND octet_length(token_hash)=32 FROM auth_sessions WHERE id=$1`, session.Identity.SessionID, expected).Scan(&matches); err != nil || !matches {
			t.Fatal("session does not store the expected digest")
		}
	}
	if err := store.Revoke(ctx, first.Token, other.Identity.SessionID); !errors.Is(err, errSessionUnavailable) {
		t.Fatal("foreign session revocation accepted")
	}
	valid(other)
	for i := 0; i < 2; i++ {
		if err := store.Revoke(ctx, first.Token, second.Identity.SessionID); err != nil {
			t.Fatal(err)
		}
	}
	invalid(second)
	valid(first)
	valid(other)
	if err := store.Revoke(ctx, second.Token, first.Identity.SessionID); !errors.Is(err, errSessionUnavailable) {
		t.Fatal("revoked actor accepted")
	}
	expired := issue(bob)
	if _, err := database.ExecContext(ctx, `UPDATE auth_sessions SET issued_at=statement_timestamp()-interval '2 hours',expires_at=statement_timestamp()-interval '1 hour' WHERE id=$1`, expired.Identity.SessionID); err != nil {
		t.Fatal(err)
	}
	invalid(expired)
	if err := store.RevokeAll(ctx, expired.Token); !errors.Is(err, errSessionUnavailable) {
		t.Fatal("expired actor accepted")
	}
	valid(other)
	if err := store.RevokeAll(ctx, first.Token); err != nil {
		t.Fatal(err)
	}
	invalid(first)
	invalid(second)
	valid(other)
	if err := store.RevokeAll(ctx, first.Token); !errors.Is(err, errSessionUnavailable) {
		t.Fatal("revoked actor accepted for bulk revocation")
	}
	for _, ttl := range []time.Duration{0, time.Second - 1, maxSessionLifetime + 1} {
		if _, err := store.Issue(ctx, bob, ttl); !errors.Is(err, errSessionLifetime) {
			t.Fatal("invalid lifetime accepted")
		}
	}
	if _, err := store.Issue(ctx, -1, time.Hour); !errors.Is(err, errSessionUnavailable) {
		t.Fatal("missing account accepted")
	}
	canceled, stop := context.WithCancel(ctx)
	stop()
	if _, err := store.Authenticate(canceled, other.Token); !errors.Is(err, context.Canceled) {
		t.Fatalf("authentication ignored context: %v", err)
	}
	if _, err := database.ExecContext(ctx, `UPDATE auth_accounts SET disabled_at=statement_timestamp() WHERE id=$1`, bob); err != nil {
		t.Fatal(err)
	}
	invalid(other)
	if _, err := store.Issue(ctx, bob, time.Hour); !errors.Is(err, errSessionUnavailable) {
		t.Fatal("disabled account received a session")
	}
	if err := store.RevokeAll(ctx, other.Token); !errors.Is(err, errSessionUnavailable) {
		t.Fatal("disabled actor accepted")
	}
}

func TestConcurrentSessionIssuancePostgres(t *testing.T) {
	database := migrationTestDatabase(t)
	if err := runMigrationsFromSource(database, migrationSourceURL(t)); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	var account int64
	if err := database.QueryRowContext(ctx, `INSERT INTO auth_accounts(display_name) VALUES('Concurrent fixture') RETURNING id`).Scan(&account); err != nil {
		t.Fatal(err)
	}
	store := sessionStore{database: database}
	type outcome struct {
		session issuedSession
		err     error
	}
	outcomes := make(chan outcome, 8)
	for i := 0; i < 8; i++ {
		go func() { session, err := store.Issue(ctx, account, time.Hour); outcomes <- outcome{session, err} }()
	}
	tokens := map[string]bool{}
	for i := 0; i < 8; i++ {
		result := <-outcomes
		if result.err != nil {
			t.Error(result.err)
			continue
		}
		if tokens[result.session.Token] {
			t.Error("concurrent sessions share a token")
		}
		tokens[result.session.Token] = true
		if identity, err := store.Authenticate(ctx, result.session.Token); err != nil || identity.AccountID != account {
			t.Error("concurrent session failed authentication")
		}
	}
	if len(tokens) != 8 {
		t.Fatal("concurrent issuance lost sessions")
	}
}
