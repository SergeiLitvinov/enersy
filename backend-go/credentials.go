package main

import (
	"context"
	"crypto/rand"
	"crypto/subtle"
	"database/sql"
	"encoding/base64"
	"errors"
	"regexp"
	"strings"
	"unicode/utf8"

	"github.com/lib/pq"
	"golang.org/x/crypto/argon2"
)

var errCredentials = errors.New("invalid login or password")
var errCredentialInput = errors.New("invalid credential input")
var errLoginUnavailable = errors.New("login unavailable")
var localLoginPattern = regexp.MustCompile(`^[a-z0-9][a-z0-9._-]{2,63}$`)

const passwordHashPrefix = "$argon2id$v=19$m=65536,t=3,p=4$"

type credentialStore struct{ database *sql.DB }

func normalizeLogin(login string) (string, bool) {
	login = strings.ToLower(strings.TrimSpace(login))
	return login, localLoginPattern.MatchString(login)
}
func validPasswordInput(password string) bool {
	return len(password) > 0 && len(password) <= 1024 && utf8.ValidString(password)
}

func hashPassword(password string) (string, error) {
	var salt [16]byte
	if _, err := rand.Read(salt[:]); err != nil {
		return "", err
	}
	key := argon2.IDKey([]byte(password), salt[:], 3, 65536, 4, 32)
	return passwordHashPrefix + base64.RawStdEncoding.EncodeToString(salt[:]) + "$" + base64.RawStdEncoding.EncodeToString(key), nil
}

// Accept only this bounded profile; database text cannot demand arbitrary RAM.
func verifyPassword(password, encoded string) bool {
	if !validPasswordInput(password) || len(encoded) > 256 || !strings.HasPrefix(encoded, passwordHashPrefix) {
		return false
	}
	parts := strings.Split(strings.TrimPrefix(encoded, passwordHashPrefix), "$")
	if len(parts) != 2 {
		return false
	}
	salt, err := base64.RawStdEncoding.Strict().DecodeString(parts[0])
	if err != nil || len(salt) != 16 || base64.RawStdEncoding.EncodeToString(salt) != parts[0] {
		return false
	}
	expected, err := base64.RawStdEncoding.Strict().DecodeString(parts[1])
	if err != nil || len(expected) != 32 || base64.RawStdEncoding.EncodeToString(expected) != parts[1] {
		return false
	}
	actual := argon2.IDKey([]byte(password), salt, 3, 65536, 4, 32)
	return subtle.ConstantTimeCompare(actual, expected) == 1
}

// Trusted provisioning only. It is deliberately not an anonymous HTTP route.
func (store credentialStore) Provision(ctx context.Context, displayName, login, password string) (int64, error) {
	login, valid := normalizeLogin(login)
	displayName = strings.TrimSpace(displayName)
	if !valid || !validPasswordInput(password) || utf8.RuneCountInString(password) < 12 || !utf8.ValidString(displayName) || strings.ContainsRune(displayName, 0) || utf8.RuneCountInString(displayName) < 1 || utf8.RuneCountInString(displayName) > 200 {
		return 0, errCredentialInput
	}
	if err := ctx.Err(); err != nil {
		return 0, err
	}
	encoded, err := hashPassword(password)
	if err != nil {
		return 0, err
	}
	if err := ctx.Err(); err != nil {
		return 0, err
	}
	tx, err := store.database.BeginTx(ctx, nil)
	if err != nil {
		return 0, err
	}
	defer tx.Rollback()
	var id int64
	if err := tx.QueryRowContext(ctx, `INSERT INTO auth_accounts(display_name) VALUES($1) RETURNING id`, displayName).Scan(&id); err != nil {
		return 0, err
	}
	if _, err := tx.ExecContext(ctx, `INSERT INTO auth_local_credentials(account_id,login,password_hash) VALUES($1,$2,$3)`, id, login, encoded); err != nil {
		var constraint *pq.Error
		if errors.As(err, &constraint) && constraint.Code == "23505" {
			return 0, errLoginUnavailable
		}
		return 0, err
	}
	if err := tx.Commit(); err != nil {
		return 0, err
	}
	return id, nil
}

func (store credentialStore) Authenticate(ctx context.Context, login, password string) (int64, error) {
	login, valid := normalizeLogin(login)
	if !valid || !validPasswordInput(password) {
		return 0, errCredentials
	}
	var account int64
	var encoded string
	err := store.database.QueryRowContext(ctx, `SELECT c.account_id,c.password_hash FROM auth_local_credentials c
 JOIN auth_accounts a ON a.id=c.account_id WHERE c.login=$1 AND a.disabled_at IS NULL`, login).Scan(&account, &encoded)
	missing := errors.Is(err, sql.ErrNoRows)
	if err != nil && !missing {
		return 0, err
	}
	if err := ctx.Err(); err != nil {
		return 0, err
	}
	if missing {
		// Perform the same bounded KDF for an unknown/disabled account. This is not
		// a claim of constant HTTP timing (database and scheduling still vary).
		argon2.IDKey([]byte(password), make([]byte, 16), 3, 65536, 4, 32)
		if err := ctx.Err(); err != nil {
			return 0, err
		}
		return 0, errCredentials
	}
	matches := verifyPassword(password, encoded)
	if err := ctx.Err(); err != nil {
		return 0, err
	}
	if !matches {
		return 0, errCredentials
	}
	return account, nil
}
