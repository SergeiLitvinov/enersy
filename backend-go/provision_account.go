package main

import (
	"context"
	"database/sql"
	"encoding/json"
	"io"
	"strconv"
	"strings"
)

// Container operator entry point. Secrets arrive on stdin, never argv/env.
func provisionAccount(ctx context.Context, database *sql.DB, input io.Reader, output io.Writer) error {
	body, err := io.ReadAll(io.LimitReader(input, (16<<10)+1))
	if err != nil {
		return err
	}
	if len(body) > 16<<10 {
		return errCredentialInput
	}
	var request struct {
		DisplayName string `json:"displayName"`
		Login       string `json:"login"`
		Password    string `json:"password"`
	}
	decoder := json.NewDecoder(strings.NewReader(string(body)))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&request); err != nil {
		return errCredentialInput
	}
	if decoder.Decode(&struct{}{}) != io.EOF {
		return errCredentialInput
	}
	id, err := (credentialStore{database: database}).Provision(ctx, request.DisplayName, request.Login, request.Password)
	if err != nil {
		return err
	}
	return json.NewEncoder(output).Encode(struct {
		AccountID string `json:"accountId"`
	}{strconv.FormatInt(id, 10)})
}
