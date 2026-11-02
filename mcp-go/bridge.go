package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"mime"
	"net"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"github.com/google/jsonschema-go/jsonschema"
)

const apiBodyLimit = 512 << 10
const mcpFrameLimit = 2 << 20
const readOperation = "scheme.read.v1"
const createOperation = "component.create.v1"

type creationUnits struct {
	FormatVersion int                      `json:"formatVersion"`
	Units         map[string]string        `json:"units"`
	Bases         map[string]*creationBase `json:"bases,omitempty"`
}

var errConfiguration = errors.New("invalid MCP configuration or session file")
var errAPI = errors.New("API operation unavailable or not confirmed; for a write retain the original UUID and read/replay before creating another command")
var errCatalog = errors.New("API operation catalog is incompatible")

type configuration struct {
	api, origin, project, scheme, cookie, token string
	write                                       bool
}

func decimal(value string, upperBound int64, zero bool) bool {
	n, err := strconv.ParseInt(value, 10, 64)
	return err == nil && n >= 0 && (zero || n > 0) && n <= upperBound && strconv.FormatInt(n, 10) == value
}

func originURL(value string) (*url.URL, bool) {
	u, err := url.Parse(value)
	return u, err == nil && (u.Scheme == "http" || u.Scheme == "https") && u.Hostname() != "" && u.Hostname() != "*" && u.User == nil && u.Path == "" && u.RawQuery == "" && !u.ForceQuery && u.Fragment == "" && u.Opaque == "" && u.String() == value
}

func loadConfiguration(getenv func(string) string) (configuration, error) {
	c := configuration{api: getenv("ENERSY_MCP_API_ORIGIN"), origin: getenv("ENERSY_MCP_AUTH_ORIGIN"), project: getenv("ENERSY_MCP_PROJECT_ID"), scheme: getenv("ENERSY_MCP_SCHEME_ID"), cookie: getenv("ENERSY_MCP_COOKIE_NAME")}
	u, valid := originURL(c.api)
	_, validOrigin := originURL(c.origin)
	write := getenv("ENERSY_MCP_ALLOW_WRITE")
	if !valid || !validOrigin || !decimal(c.project, 9223372036854775807, false) || !decimal(c.scheme, 2147483647, false) || (write != "" && write != "false" && write != "true") {
		return configuration{}, errConfiguration
	}
	if u.Scheme == "http" && u.Hostname() != "go-api" && u.Hostname() != "localhost" && !net.ParseIP(u.Hostname()).IsLoopback() {
		return configuration{}, errConfiguration
	}
	c.write = write == "true"
	if c.cookie == "" {
		c.cookie = "__Host-enersy_session"
	}
	if c.cookie != "__Host-enersy_session" && c.cookie != "enersy_session" {
		return configuration{}, errConfiguration
	}
	path := getenv("ENERSY_MCP_SESSION_FILE")
	if !filepath.IsAbs(path) {
		return configuration{}, errConfiguration
	}
	file, err := os.Open(path)
	if err != nil {
		return configuration{}, errConfiguration
	}
	body, readErr := io.ReadAll(io.LimitReader(file, 129))
	closeErr := file.Close()
	c.token = strings.TrimSpace(string(body))
	if readErr != nil || closeErr != nil || len(body) > 128 || len(c.token) != 43 || strings.ContainsAny(c.token, "\r\n \t") {
		return configuration{}, errConfiguration
	}
	for _, char := range c.token {
		if !(char >= 'a' && char <= 'z' || char >= 'A' && char <= 'Z' || char >= '0' && char <= '9' || char == '-' || char == '_') {
			return configuration{}, errConfiguration
		}
	}
	return c, nil
}

type headerMapping struct {
	Argument string `json:"argument"`
	Encoding string `json:"encoding"`
}

type operation struct {
	ID                       string          `json:"id"`
	Description              string          `json:"description"`
	ReadOnly                 bool            `json:"readOnly"`
	ReplaySemantics          string          `json:"replaySemantics"`
	ReturnsEngineeringResult bool            `json:"returnsEngineeringResult"`
	InputSchema              json.RawMessage `json:"inputSchema"`
	HTTP                     struct {
		Method       string                   `json:"method"`
		Path         string                   `json:"path"`
		BodyArgument string                   `json:"bodyArgument"`
		Headers      map[string]headerMapping `json:"headers"`
	} `json:"http"`
	validator *jsonschema.Resolved
}

type bridge struct {
	config configuration
	client *http.Client
	actor  struct {
		Account string `json:"accountId"`
		Session string `json:"sessionId"`
	}
}

func newBridge(ctx context.Context, config configuration) (*bridge, error) {
	b := &bridge{config: config, client: &http.Client{Timeout: 15 * time.Second,
		Transport:     &http.Transport{Proxy: nil, MaxResponseHeaderBytes: 32 << 10},
		CheckRedirect: func(*http.Request, []*http.Request) error { return errAPI }}}
	body, err := b.api(ctx, "GET", "/api/auth/session", nil, nil)
	if err != nil || json.Unmarshal(body, &b.actor) != nil || !decimal(b.actor.Account, 9223372036854775807, false) || !decimal(b.actor.Session, 9223372036854775807, false) {
		return nil, errAPI
	}
	if _, err := b.operations(ctx); err != nil {
		return nil, err
	}
	return b, nil
}

func (b *bridge) api(ctx context.Context, method, path string, body []byte, headers map[string]string) ([]byte, error) {
	if len(body) > 1<<20 || !strings.HasPrefix(path, "/api/") || strings.ContainsAny(path, "?#\\\r\n") {
		return nil, errAPI
	}
	r, err := http.NewRequestWithContext(ctx, method, b.config.api+path, bytes.NewReader(body))
	if err != nil {
		return nil, errAPI
	}
	// net/http treats Idempotency-Key as permission to retry a buffered POST
	// after a connection loss. Writes require an explicit reviewed replay here;
	// a caller must observe the unknown outcome instead of a hidden second send.
	if len(body) > 0 {
		r.GetBody = nil
	}
	// #nosec G124 -- Outbound Cookie request, not Set-Cookie. Browser policy
	// attributes are controlled by the API and are not transmitted by AddCookie.
	r.AddCookie(&http.Cookie{Name: b.config.cookie, Value: b.config.token})
	r.Header.Set("Origin", b.config.origin)
	r.Header.Set("Accept", "application/json")
	r.Header.Set("Content-Type", "application/json")
	if b.actor.Account != "" {
		r.Header.Set("X-Enersy-Account-Id", b.actor.Account)
		r.Header.Set("X-Enersy-Session-Id", b.actor.Session)
	}
	for name, value := range headers {
		r.Header.Set(name, value)
	}
	response, err := b.client.Do(r)
	if err != nil {
		return nil, errAPI
	}
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return nil, errAPI // Never reflect error bodies, credentials or redirect URLs.
	}
	typeName, _, err := mime.ParseMediaType(response.Header.Get("Content-Type"))
	if err != nil || typeName != "application/json" {
		return nil, errAPI
	}
	data, err := io.ReadAll(io.LimitReader(response.Body, apiBodyLimit+1))
	if err != nil || len(data) > apiBodyLimit || !validJSON(data) {
		return nil, errAPI
	}
	return data, nil
}

func (b *bridge) base() string {
	return fmt.Sprintf("/api/projects/%s/schemes/%s", b.config.project, b.config.scheme)
}

func (b *bridge) operations(ctx context.Context) ([]operation, error) {
	body, err := b.api(ctx, "GET", b.base()+"/operations", nil, nil)
	if err != nil {
		return nil, err
	}
	var catalog struct {
		Version    int         `json:"formatVersion"`
		Project    string      `json:"projectId"`
		Scheme     string      `json:"schemeId"`
		Operations []operation `json:"operations"`
	}
	if json.Unmarshal(body, &catalog) != nil || catalog.Version != 1 || catalog.Project != b.config.project || catalog.Scheme != b.config.scheme || len(catalog.Operations) > 32 {
		return nil, errCatalog
	}
	result := []operation{}
	seen := map[string]bool{}
	for _, op := range catalog.Operations {
		if seen[op.ID] {
			return nil, errCatalog
		}
		seen[op.ID] = true
		switch op.ID {
		case readOperation:
			if !op.ReadOnly || op.ReturnsEngineeringResult || op.ReplaySemantics != "fresh-observation" || op.HTTP.Path != b.base() || op.HTTP.Method != "GET" || op.HTTP.BodyArgument != "" || len(op.HTTP.Headers) != 0 {
				return nil, errCatalog
			}
		case createOperation:
			if !b.config.write {
				continue
			}
			if op.ReadOnly || op.ReturnsEngineeringResult || op.ReplaySemantics != "durable-command" || op.HTTP.Path != b.base()+"/components" || op.HTTP.Method != "POST" || op.HTTP.BodyArgument != "equipment" || len(op.HTTP.Headers) != 2 || op.HTTP.Headers["Idempotency-Key"] != (headerMapping{"commandId", "raw-string"}) || op.HTTP.Headers["If-Match"] != (headerMapping{"expectedTopologyRevision", "strong-etag"}) {
				return nil, errCatalog
			}
		default:
			continue // Publishing a future API capability does not implement its adapter.
		}
		var schema jsonschema.Schema
		if !safeSchema(op.InputSchema) || json.Unmarshal(op.InputSchema, &schema) != nil || schema.Type != "object" {
			return nil, errCatalog
		}
		op.validator, err = schema.Resolve(nil)
		if err != nil {
			return nil, errCatalog
		}
		result = append(result, op)
	}
	if !seen[readOperation] {
		return nil, errCatalog
	}
	return result, nil
}

func safeSchema(data []byte) bool {
	var value any
	if json.Unmarshal(data, &value) != nil {
		return false
	}
	var safe func(any) bool
	safe = func(value any) bool {
		switch v := value.(type) {
		case map[string]any:
			for key, child := range v {
				if key == "$ref" || key == "$dynamicRef" || key == "$id" || key == "$schema" && child != "https://json-schema.org/draft/2020-12/schema" || !safe(child) {
					return false
				}
			}
		case []any:
			for _, child := range v {
				if !safe(child) {
					return false
				}
			}
		}
		return true
	}
	return safe(value)
}

func (b *bridge) invoke(ctx context.Context, op operation, arguments json.RawMessage) ([]byte, error) {
	if len(arguments) == 0 {
		arguments = json.RawMessage(`{}`)
	}
	var value any
	if !validJSON(arguments) || json.Unmarshal(arguments, &value) != nil || op.validator.Validate(value) != nil {
		return nil, errors.New("invalid tool arguments; do not guess missing physical values")
	}
	var args map[string]json.RawMessage
	if json.Unmarshal(arguments, &args) != nil || args == nil {
		return nil, errCatalog
	}
	headers := map[string]string{}
	var command string
	for name, mapping := range op.HTTP.Headers {
		var v string
		if json.Unmarshal(args[mapping.Argument], &v) != nil {
			return nil, errCatalog
		}
		if name == "Idempotency-Key" {
			command = v
		}
		if mapping.Encoding == "strong-etag" {
			if !decimal(v, 9223372036854775807, true) {
				return nil, errors.New("invalid original topology revision")
			}
			v = strconv.Quote(v)
		}
		headers[name] = v
	}
	var body []byte
	if op.HTTP.BodyArgument != "" {
		body = args[op.HTTP.BodyArgument]
	}
	data, err := b.api(ctx, op.HTTP.Method, op.HTTP.Path, body, headers)
	if err != nil {
		return nil, err
	}
	if op.ID == readOperation {
		var graph struct{ ID, ProjectID string }
		if json.Unmarshal(data, &graph) != nil || graph.ID != b.config.scheme || graph.ProjectID != b.config.project {
			return nil, errAPI
		}
	} else {
		var receipt struct {
			Success                        bool
			ID, Revision, TopologyRevision string
			CommandID                      string
			Deleted                        *bool
			Params                         map[string]string
			DeclaredParameterUnits         *creationUnits
		}
		if json.Unmarshal(data, &receipt) != nil || !receipt.Success || receipt.CommandID != command || receipt.Deleted == nil || receipt.Params == nil || !decimal(receipt.ID, 2147483647, false) || !decimal(receipt.Revision, 9223372036854775807, false) || !decimal(receipt.TopologyRevision, 9223372036854775807, true) {
			return nil, errAPI
		}
		var requested struct {
			Params                   map[string]string `json:"params"`
			ParameterUnitDeclaration *creationUnits    `json:"parameterUnitDeclaration"`
		}
		if json.Unmarshal(body, &requested) != nil {
			return nil, errAPI
		}
		if units := requested.ParameterUnitDeclaration; units != nil {
			if !validCreationUnits(units, false) || !validCreationUnits(receipt.DeclaredParameterUnits, true) {
				return nil, errAPI
			}
			for key, unit := range units.Units {
				value, present := requested.Params[key]
				actual, confirmed := receipt.Params[key]
				if !present || !confirmed || actual != value || receipt.DeclaredParameterUnits.Units[key] != unit {
					return nil, errAPI
				}
			}
			for key, base := range units.Bases {
				actual := receipt.DeclaredParameterUnits.Bases[key]
				if base == nil && actual != nil || base != nil && (actual == nil || *actual != *base) {
					return nil, errAPI
				}
			}
		}
	}
	return data, nil
}
