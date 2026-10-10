package main

import (
	"context"
	"database/sql"
	"errors"
	"strings"
	"unicode/utf8"
)

var errProjectUnavailable = errors.New("project resource unavailable")
var errProjectName = errors.New("project name must contain 1 to 200 characters")

type projectPermission string

const (
	projectRead   projectPermission = "read"
	projectWrite  projectPermission = "write"
	projectManage projectPermission = "manage"
)

type projectResource string

const (
	projectScope    projectResource = "project"
	schemeScope     projectResource = "scheme"
	componentScope  projectResource = "component"
	connectionScope projectResource = "connection"
)

type projectAccess struct {
	Identity  sessionIdentity
	ProjectID int64
	Role      string
}
type projectStore struct{ database *sql.DB }

// No caller-supplied owner ID. This requires an already issued trusted session.
// Project HTTP routes have not been wired yet.
func (store projectStore) Create(ctx context.Context, token, name string) (int64, error) {
	name = strings.TrimSpace(name)
	if !utf8.ValidString(name) || strings.ContainsRune(name, 0) || utf8.RuneCountInString(name) < 1 || utf8.RuneCountInString(name) > 200 {
		return 0, errProjectName
	}
	hash, err := sessionTokenHash(token)
	if err != nil {
		return 0, errProjectUnavailable
	}
	var id int64
	err = store.database.QueryRowContext(ctx, `INSERT INTO projects(owner_account_id,name)
 SELECT a.id,$2 FROM auth_sessions s JOIN auth_accounts a ON a.id=s.account_id
 WHERE s.token_hash=$1 AND s.revoked_at IS NULL AND s.expires_at>statement_timestamp()
 AND a.disabled_at IS NULL RETURNING id`, hash, name).Scan(&id)
	if errors.Is(err, sql.ErrNoRows) {
		return 0, errProjectUnavailable
	}
	if err != nil {
		return 0, err
	}
	return id, nil
}

// Resolve the actual resource -> scheme -> project on the server. Verifying a
// separately supplied project ID must never authorize an unrelated object ID.
// A guard alone isn't a protected mutation; future writes must check access in
// their transaction and define conflicts with concurrent membership changes.
func (store projectStore) Access(ctx context.Context, token string, scope projectResource, id int64, permission projectPermission) (projectAccess, error) {
	if id <= 0 || (permission != projectRead && permission != projectWrite && permission != projectManage) {
		return projectAccess{}, errProjectUnavailable
	}
	hash, err := sessionTokenHash(token)
	if err != nil {
		return projectAccess{}, errProjectUnavailable
	}
	var joins, filter string
	switch scope {
	case projectScope:
		filter = "p.id=$2"
	case schemeScope:
		joins = " JOIN circuit_schemes cs ON cs.project_id=p.id"
		filter = "cs.id=$2"
	case componentScope:
		joins = " JOIN circuit_schemes cs ON cs.project_id=p.id JOIN scheme_components sc ON sc.scheme_id=cs.id"
		filter = "sc.id=$2"
	case connectionScope:
		joins = ` JOIN circuit_schemes cs ON cs.project_id=p.id JOIN scheme_connections c ON c.scheme_id=cs.id
   JOIN scheme_components f ON f.id=c.from_component_id AND f.scheme_id=cs.id
   JOIN scheme_components t ON t.id=c.to_component_id AND t.scheme_id=cs.id`
		filter = "c.id=$2"
	default:
		return projectAccess{}, errProjectUnavailable
	}
	// All SQL fragments above are fixed internal constants, not client input.
	query := `SELECT s.account_id,s.id,s.expires_at,p.id,
 CASE WHEN p.owner_account_id=s.account_id THEN 'owner' ELSE m.role END
 FROM auth_sessions s JOIN auth_accounts a ON a.id=s.account_id
 JOIN projects p ON true LEFT JOIN project_members m ON m.project_id=p.id AND m.account_id=s.account_id` + joins + `
 WHERE s.token_hash=$1 AND s.revoked_at IS NULL AND s.expires_at>statement_timestamp()
 AND a.disabled_at IS NULL AND ` + filter + `
 AND (p.owner_account_id=s.account_id OR m.role='admin'
 OR ($3='read' AND m.role IN ('editor','viewer')) OR ($3='write' AND m.role='editor'))`
	var access projectAccess
	err = store.database.QueryRowContext(ctx, query, hash, id, string(permission)).Scan(&access.Identity.AccountID, &access.Identity.SessionID, &access.Identity.ExpiresAt, &access.ProjectID, &access.Role)
	if errors.Is(err, sql.ErrNoRows) {
		return projectAccess{}, errProjectUnavailable
	}
	if err != nil {
		return projectAccess{}, err
	}
	return access, nil
}
