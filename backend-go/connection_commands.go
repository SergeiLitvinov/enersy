package main

import (
	"bytes"
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"regexp"
	"strings"
)

var commandUUID = regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`)
var errConnectionCommandConflict = errors.New("command payload changed")

// A dedicated route prevents an older CRUD server from silently ignoring the
// command key. It must not dispatch creation without a valid identity.
func handleConnectionCommands(w http.ResponseWriter, r *http.Request) {
	if !requireMethod(w, r, http.MethodPost) {
		return
	}
	key, err := connectionCommandKey(r)
	if err != nil || key == "" {
		sendError(w, "Для команды создания связи требуется один UUID Idempotency-Key", 400)
		return
	}
	handleConnections(w, r)
}

func connectionAcknowledgement(w http.ResponseWriter, id int, key string) {
	w.Header().Set("Content-Type", "application/json")
	result := map[string]any{"id": id, "success": true}
	if key != "" {
		result["commandId"] = key
	}
	json.NewEncoder(w).Encode(result)
}

func connectionCommandKey(r *http.Request) (string, error) {
	values := r.Header.Values("Idempotency-Key")
	if len(values) == 0 {
		return "", nil // Legacy clients have no replay protection.
	}
	if len(values) != 1 {
		return "", errors.New("expected one command UUID")
	}
	key := strings.ToLower(values[0])
	if !commandUUID.MatchString(key) {
		return "", errors.New("invalid command UUID")
	}
	return key, nil
}

func connectionPayloadHash(req connectionRequest) []byte {
	// The caller normalizes port case first. Field order is fixed by the DTO.
	data, _ := json.Marshal(req) // Only integers and strings; encoding cannot fail.
	hash := sha256.Sum256(data)
	return hash[:]
}

// Lock before lookup, including an absent row. Concurrent same-key requests wait
// for commit/rollback and then see the durable result. Hash collisions serialize
// unrelated commands but never identify them: lookup uses the exact UUID + scheme.
func replayConnectionCommand(ctx context.Context, tx *sql.Tx, req connectionRequest, key string) (int, bool, error) {
	lock := fmt.Sprintf("enersy:create-connection:%d:%s", req.SchemeID, key)
	if _, err := tx.ExecContext(ctx, `SELECT pg_advisory_xact_lock(hashtextextended($1,0))`, lock); err != nil {
		return 0, false, err
	}
	var storedHash []byte
	var id int
	err := tx.QueryRowContext(ctx, `SELECT payload_hash,connection_id FROM connection_commands WHERE scheme_id=$1 AND command_id=$2`, req.SchemeID, key).Scan(&storedHash, &id)
	if errors.Is(err, sql.ErrNoRows) {
		return 0, false, nil
	}
	if err != nil {
		return 0, false, err
	}
	if !bytes.Equal(storedHash, connectionPayloadHash(req)) {
		return 0, false, errConnectionCommandConflict
	}
	return id, true, nil
}
