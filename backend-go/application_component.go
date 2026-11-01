package main

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"strconv"
)

var errApplicationCommandConflict = errors.New("command ID already has another intent or actor")
var errApplicationSessionChanged = errors.New("command session changed")

type applicationIdentity struct{ AccountID, SessionID int64 }

type createEquipmentCommand struct {
	ProjectID                int64
	CommandID                string
	ExpectedTopologyRevision int64
	Equipment                createComponentRequest
	// Adapter expectation constrains the authenticated token; it grants no
	// access and is not part of the durable engineering intent's digest.
	ExpectedIdentity *applicationIdentity `json:"-"`
}

type createEquipmentReceipt struct {
	projectComponentCreation
	Replayed         bool
	Deleted          bool
	TopologyRevision int64
}

// CreateEquipment is retryable only with the original command ID and intent.
// Authentication and revocation locks apply to replays as well as new writes.
func (service applicationService) CreateEquipment(ctx context.Context, token string, command createEquipmentCommand) (createEquipmentReceipt, error) {
	empty := createEquipmentReceipt{}
	if command.ProjectID <= 0 || !commandUUID.MatchString(command.CommandID) || command.ExpectedTopologyRevision < 0 {
		return empty, creationError("Некорректная команда создания оборудования", 400)
	}
	if err := validateComponentCreation(command.Equipment); err != nil {
		return empty, err
	}
	// Hash caller intent before copying mutable catalog values or immutable
	// passport data. A replay never consults a newly changed catalog model.
	intent, err := json.Marshal(struct {
		Operation string
		Command   createEquipmentCommand
	}{operationCreateEquipment, command})
	if err != nil {
		return empty, err
	}
	digest := archiveDigest(intent)
	tx, err := service.database.BeginTx(ctx, &sql.TxOptions{Isolation: sql.LevelReadCommitted})
	if err != nil {
		return empty, err
	}
	defer rollbackTx(tx)
	account, err := lockArchiveProject(ctx, tx, token, command.ProjectID, true)
	if err != nil {
		return empty, err
	}
	if expected := command.ExpectedIdentity; expected != nil {
		hash, err := sessionTokenHash(token)
		if err != nil {
			return empty, err
		}
		var matches bool
		if err := tx.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM auth_sessions WHERE token_hash=$1 AND id=$2 AND account_id=$3)`, hash, expected.SessionID, expected.AccountID).Scan(&matches); err != nil {
			return empty, err
		}
		if !matches || account != expected.AccountID {
			return empty, errApplicationSessionChanged
		}
	}
	// One key across all schemes of a project. Serialize before locking a
	// scheme, including simultaneous attempts with a reused key in other scope.
	lockKey := strconv.FormatInt(command.ProjectID, 10) + ":" + command.CommandID
	if _, err := tx.ExecContext(ctx, `SELECT pg_advisory_xact_lock(hashtextextended($1,0))`, lockKey); err != nil {
		return empty, err
	}
	if err := lockProjectSchemeWrite(ctx, tx, token, command.ProjectID, command.Equipment.SchemeID); err != nil {
		return empty, err
	}
	var storedActor int64
	var storedDigest string
	var body []byte
	err = tx.QueryRowContext(ctx, `SELECT account_id,intent_sha256,receipt FROM project_application_commands
 WHERE project_id=$1 AND command_id=$2`, command.ProjectID, command.CommandID).Scan(&storedActor, &storedDigest, &body)
	var receipt createEquipmentReceipt
	switch {
	case err == nil:
		if storedActor != account || storedDigest != digest {
			return empty, errApplicationCommandConflict
		}
		if err := json.Unmarshal(body, &receipt); err != nil {
			return empty, err
		}
		if receipt.ID <= 0 || receipt.Revision <= 0 || receipt.Params == nil || receipt.TopologyRevision <= 0 {
			return empty, errors.New("invalid stored component creation receipt")
		}
		receipt.Replayed = true
		var exists bool
		if err := tx.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM scheme_components WHERE id=$1 AND scheme_id=$2)`, receipt.ID, command.Equipment.SchemeID).Scan(&exists); err != nil {
			return empty, err
		}
		receipt.Deleted = !exists
	case errors.Is(err, sql.ErrNoRows):
		var current int64
		if err := tx.QueryRowContext(ctx, `SELECT topology_revision FROM circuit_schemes WHERE id=$1`, command.Equipment.SchemeID).Scan(&current); err != nil {
			return empty, err
		}
		if current != command.ExpectedTopologyRevision {
			return empty, errTopologyConflict
		}
		created, err := createProjectComponentInTx(ctx, tx, command.ProjectID, command.Equipment)
		if err != nil {
			return empty, err
		}
		receipt.projectComponentCreation = created
		if err := tx.QueryRowContext(ctx, `SELECT topology_revision FROM circuit_schemes WHERE id=$1`, command.Equipment.SchemeID).Scan(&receipt.TopologyRevision); err != nil {
			return empty, err
		}
		body, err = json.Marshal(receipt)
		if err != nil {
			return empty, err
		}
		if _, err := tx.ExecContext(ctx, `INSERT INTO project_application_commands(project_id,command_id,scheme_id,account_id,operation,intent_sha256,receipt)
 VALUES($1,$2,$3,$4,$5,$6,$7)`, command.ProjectID, command.CommandID, command.Equipment.SchemeID, account, operationCreateEquipment, digest, body); err != nil {
			return empty, err
		}
	default:
		return empty, err
	}
	if err := tx.QueryRowContext(ctx, `SELECT topology_revision FROM circuit_schemes WHERE id=$1`, command.Equipment.SchemeID).Scan(&receipt.TopologyRevision); err != nil {
		return empty, err
	}
	if err := tx.Commit(); err != nil {
		return empty, err
	}
	return receipt, nil
}
