package main

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"
)

func TestProjectAccessPostgres(t *testing.T) {
	database := migrationTestDatabase(t)
	if err := runMigrationsFromSource(database, migrationSourceURL(t)); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	sessions := sessionStore{database: database}
	projects := projectStore{database: database}
	var accounts [3]int64
	var tokens [3]issuedSession
	for i := range accounts {
		if err := database.QueryRowContext(ctx, `INSERT INTO auth_accounts(display_name) VALUES('Project fixture') RETURNING id`).Scan(&accounts[i]); err != nil {
			t.Fatal(err)
		}
		value, err := sessions.Issue(ctx, accounts[i], time.Hour)
		if err != nil {
			t.Fatal(err)
		}
		tokens[i] = value
	}
	secondOwnerSession, err := sessions.Issue(ctx, accounts[0], time.Hour)
	if err != nil {
		t.Fatal(err)
	}
	own, err := projects.Create(ctx, tokens[0].Token, " Shared project ")
	if err != nil {
		t.Fatal(err)
	}
	foreign, err := projects.Create(ctx, tokens[1].Token, "Other project")
	if err != nil {
		t.Fatal(err)
	}
	var schemes [2]int64
	var equipment [2][2]int64
	var connections [2]int64
	for i, project := range []int64{own, foreign} {
		if err := database.QueryRowContext(ctx, `INSERT INTO circuit_schemes(name,project_id) VALUES('Project graph',$1) RETURNING id`, project).Scan(&schemes[i]); err != nil {
			t.Fatal(err)
		}
		for j := range equipment[i] {
			if err := database.QueryRowContext(ctx, `INSERT INTO scheme_components(scheme_id,component_type_id,pos_x,pos_y,rotation)
 SELECT $1,id,0,0,0 FROM component_types WHERE code='busbar' RETURNING id`, schemes[i]).Scan(&equipment[i][j]); err != nil {
				t.Fatal(err)
			}
		}
		if err := database.QueryRowContext(ctx, `INSERT INTO scheme_connections(scheme_id,from_component_id,to_component_id,from_port,to_port)
 VALUES($1,$2,$3,'right','left') RETURNING id`, schemes[i], equipment[i][0], equipment[i][1]).Scan(&connections[i]); err != nil {
			t.Fatal(err)
		}
	}
	resources := []struct {
		scope        projectResource
		own, foreign int64
	}{
		{projectScope, own, foreign}, {schemeScope, schemes[0], schemes[1]},
		{componentScope, equipment[0][0], equipment[1][0]}, {connectionScope, connections[0], connections[1]},
	}
	allowed := func(token string, resource projectResource, id int64, permission projectPermission, account int64, role string) {
		t.Helper()
		result, err := projects.Access(ctx, token, resource, id, permission)
		if err != nil || result.ProjectID != own || result.Identity.AccountID != account || result.Role != role {
			t.Fatalf("incorrect project access: scope=%s permission=%s role=%s err=%v", resource, permission, result.Role, err)
		}
	}
	denied := func(token string, resource projectResource, id int64, permission projectPermission) {
		t.Helper()
		result, err := projects.Access(ctx, token, resource, id, permission)
		if !errors.Is(err, errProjectUnavailable) || result.ProjectID != 0 || result.Identity.AccountID != 0 {
			t.Fatalf("unauthorized resource resolved: %s/%s err=%v", resource, permission, err)
		}
	}
	for _, resource := range resources {
		for _, permission := range []projectPermission{projectRead, projectWrite, projectManage} {
			allowed(tokens[0].Token, resource.scope, resource.own, permission, accounts[0], "owner")
			denied(tokens[0].Token, resource.scope, resource.foreign, permission)
			denied(tokens[1].Token, resource.scope, resource.own, permission)
			denied(tokens[2].Token, resource.scope, resource.own, permission)
		}
	}
	for _, role := range []string{"viewer", "editor", "admin"} {
		// Fixture provisioning only. No unprotected membership HTTP command exists.
		if _, err := database.ExecContext(ctx, `INSERT INTO project_members(project_id,account_id,role) VALUES($1,$2,$3)
 ON CONFLICT(project_id,account_id) DO UPDATE SET role=EXCLUDED.role`, own, accounts[1], role); err != nil {
			t.Fatal(err)
		}
		for _, resource := range resources {
			allowed(tokens[1].Token, resource.scope, resource.own, projectRead, accounts[1], role)
			if role == "viewer" {
				denied(tokens[1].Token, resource.scope, resource.own, projectWrite)
			} else {
				allowed(tokens[1].Token, resource.scope, resource.own, projectWrite, accounts[1], role)
			}
			if role == "admin" {
				allowed(tokens[1].Token, resource.scope, resource.own, projectManage, accounts[1], role)
			} else {
				denied(tokens[1].Token, resource.scope, resource.own, projectManage)
			}
			denied(tokens[2].Token, resource.scope, resource.own, projectRead)
		}
	}
	if _, err := database.ExecContext(ctx, `DELETE FROM project_members WHERE project_id=$1 AND account_id=$2`, own, accounts[1]); err != nil {
		t.Fatal(err)
	}
	denied(tokens[1].Token, projectScope, own, projectRead)
	var legacy int64
	if err := database.QueryRowContext(ctx, `INSERT INTO circuit_schemes(name,owner_id) VALUES('Legacy unassigned',1) RETURNING id`).Scan(&legacy); err != nil {
		t.Fatal(err)
	}
	for _, token := range tokens {
		denied(token.Token, schemeScope, legacy, projectRead)
	}
	denied("invalid", projectScope, own, projectRead)
	denied(tokens[0].Token, projectResource("unknown"), own, projectRead)
	denied(tokens[0].Token, projectScope, own, projectPermission("unknown"))
	denied(tokens[0].Token, projectScope, -1, projectRead)
	if err := sessions.Revoke(ctx, secondOwnerSession.Token, tokens[0].Identity.SessionID); err != nil {
		t.Fatal(err)
	}
	denied(tokens[0].Token, componentScope, equipment[0][0], projectWrite)
	allowed(secondOwnerSession.Token, componentScope, equipment[0][0], projectWrite, accounts[0], "owner")
	if _, err := projects.Create(ctx, tokens[0].Token, "Rejected"); !errors.Is(err, errProjectUnavailable) {
		t.Fatal("revoked actor created a project")
	}
	for _, name := range []string{"", " \t\n", strings.Repeat("x", 201), string([]byte{0xff}), "invalid\x00name"} {
		if _, err := projects.Create(ctx, secondOwnerSession.Token, name); !errors.Is(err, errProjectName) {
			t.Fatal("invalid project name accepted")
		}
	}
	canceled, stop := context.WithCancel(ctx)
	stop()
	if _, err := projects.Access(canceled, secondOwnerSession.Token, projectScope, own, projectRead); !errors.Is(err, context.Canceled) {
		t.Fatalf("project guard ignored cancellation: %v", err)
	}
	if _, err := database.ExecContext(ctx, `UPDATE auth_sessions SET issued_at=statement_timestamp()-interval '2 hours',expires_at=statement_timestamp()-interval '1 hour' WHERE id=$1`, tokens[1].Identity.SessionID); err != nil {
		t.Fatal(err)
	}
	denied(tokens[1].Token, projectScope, foreign, projectRead)
	if _, err := projects.Create(ctx, tokens[1].Token, "Expired actor"); !errors.Is(err, errProjectUnavailable) {
		t.Fatal("expired actor created a project")
	}
	if _, err := database.ExecContext(ctx, `UPDATE auth_accounts SET disabled_at=statement_timestamp() WHERE id=$1`, accounts[0]); err != nil {
		t.Fatal(err)
	}
	denied(secondOwnerSession.Token, projectScope, own, projectManage)
}
