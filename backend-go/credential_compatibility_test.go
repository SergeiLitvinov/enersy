package main

import (
	"context"
	"errors"
	"testing"
	"time"
)

// Public synthetic fixtures captured before the dependency update with
// golang.org/x/crypto v0.46.0 and Go 1.26.10. Fixed salts are for this
// compatibility test only; production hashPassword always uses crypto/rand.
const legacyPassword = "Legacy test password phrase"
const legacyPasswordHash = "$argon2id$v=19$m=65536,t=3,p=4$AAECAwQFBgcICQoLDA0ODw$MhrYE2HLPT4H3yn7l+ugCT9mqQXWfROHHAV+hp2YRZE"

func TestLegacyPasswordCompatibility(t *testing.T) {
	for _, fixture := range []struct{ password, encoded string }{
		{legacyPassword, legacyPasswordHash},
		{"Пароль только для проверки 🔌", "$argon2id$v=19$m=65536,t=3,p=4$AAECAwQFBgcICQoLDA0ODw$IB11flGhRIhJWFcCRwkBu9UcStrs5R2zWjV2kH1+6gg"},
	} {
		if !verifyPassword(fixture.password, fixture.encoded) || verifyPassword(fixture.password+"!", fixture.encoded) {
			t.Fatal("legacy PHC compatibility or password discrimination changed")
		}
	}
}

func TestLegacyCredentialsAndSessionPostgres(t *testing.T) {
	database := migrationTestDatabase(t)
	if err := runMigrationsFromSource(database, migrationSourceURL(t)); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	var account, oldSession int64
	if err := database.QueryRowContext(ctx, `INSERT INTO auth_accounts(display_name) VALUES('Legacy compatibility fixture') RETURNING id`).Scan(&account); err != nil {
		t.Fatal(err)
	}
	if _, err := database.ExecContext(ctx, `INSERT INTO auth_local_credentials(account_id,login,password_hash) VALUES($1,'legacy-fixture',$2)`, account, legacyPasswordHash); err != nil {
		t.Fatal(err)
	}
	// Public synthetic token bytes 00..1f. Its stored SHA-256 was independently
	// calculated with .NET SHA256, not sessionTokenHash under test.
	const oldToken = "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8"
	if err := database.QueryRowContext(ctx, `INSERT INTO auth_sessions(account_id,token_hash,expires_at)
 VALUES($1,decode('630dcd2966c4336691125448bbb25b4ff412a49c732db2c8abc1b8581bd710dd','hex'),statement_timestamp()+interval '1 hour') RETURNING id`, account).Scan(&oldSession); err != nil {
		t.Fatal(err)
	}
	credentials := credentialStore{database: database}
	if got, err := credentials.Authenticate(ctx, "legacy-fixture", legacyPassword); err != nil || got != account {
		t.Fatalf("persisted old credential rejected: %v", err)
	}
	var preserved string
	if err := database.QueryRowContext(ctx, `SELECT password_hash FROM auth_local_credentials WHERE account_id=$1`, account).Scan(&preserved); err != nil || preserved != legacyPasswordHash {
		t.Fatal("legacy credential was implicitly rewritten")
	}
	store := sessionStore{database: database}
	if identity, err := store.Authenticate(ctx, oldToken); err != nil || identity.AccountID != account || identity.SessionID != oldSession {
		t.Fatalf("persisted session rejected: %v", err)
	}
	newSession, err := store.Issue(ctx, account, time.Hour)
	if err != nil {
		t.Fatal(err)
	}
	if err := store.Revoke(ctx, newSession.Token, oldSession); err != nil {
		t.Fatal(err)
	}
	if _, err := store.Authenticate(ctx, oldToken); !errors.Is(err, errSessionUnavailable) {
		t.Fatal("legacy session revocation was ineffective")
	}
	if identity, err := store.Authenticate(ctx, newSession.Token); err != nil || identity.SessionID != newSession.Identity.SessionID {
		t.Fatal("revoking the old session affected the new one")
	}
}
