package main

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"expvar"
	"flag"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"strconv"
	"strings"
	"syscall"
	"time"

	_ "github.com/lib/pq"
)

var (
	Version   = "dev"
	Commit    = "none"
	BuildTime = "unknown"
)

type Response struct {
	Result interface{} `json:"result,omitempty"`
	Error  string      `json:"error,omitempty"`
}

var db *sql.DB
var corsOrigin string
var juliaBaseURL string

type Config struct {
	DBHost           string
	DBPort           string
	DBName           string
	DBUser           string
	DBPassword       string
	Port             string
	CORSOrigin       string
	JuliaBaseURL     string
	AuthOrigin       string
	AuthCookieSecure bool
}

func loadConfig() Config {
	return Config{
		DBHost:           getEnv("DB_HOST", "postgres"),
		DBPort:           getEnv("DB_PORT", "5432"),
		DBName:           getEnv("POSTGRES_DB", "app_db"),
		DBUser:           getEnv("POSTGRES_USER", "app_user"),
		DBPassword:       getEnv("POSTGRES_PASSWORD", "app_pass"),
		Port:             getEnv("PORT", "8080"),
		CORSOrigin:       getEnv("CORS_ORIGIN", "*"),
		JuliaBaseURL:     getEnv("JULIA_BASE_URL", "http://julia-compute:8001"),
		AuthOrigin:       getEnv("AUTH_ORIGIN", ""),
		AuthCookieSecure: getEnv("AUTH_COOKIE_SECURE", "true") != "false",
	}
}

func main() {
	studyWorker := flag.Bool("study-worker", false, "Execute admitted immutable Study runs from PostgreSQL")
	provision := flag.Bool("provision-account", false, "Provision a local account from JSON on stdin, then exit")
	audit := flag.Bool("audit-database", false, "Read-only bootstrap and migration inventory as JSON; do not migrate or serve HTTP")
	catalog := flag.Bool("audit-catalog", false, "Read-only comparison with the shipped fresh-database seed baseline")
	checkMap := flag.Bool("check-catalog-map", false, "Validate an explicit legacy model reference map from stdin without changing data")
	applyMap := flag.Bool("apply-catalog-map", false, "Atomically apply an explicit legacy model reference map from stdin without replacing instance parameters")
	ownerAudit := flag.Bool("audit-legacy-owners", false, "Read-only fingerprint inventory of legacy users and scheme owner references")
	ownerCheck := flag.Bool("check-legacy-owner-map", false, "Validate an explicit legacy scheme owner map from stdin without changing data")
	ownerApply := flag.Bool("apply-legacy-owner-map", false, "Apply an explicit legacy owner metadata map without changing accounts or project access")
	flag.Parse()
	cfg := loadConfig()
	modes := 0
	for _, selected := range []bool{*studyWorker, *provision, *audit, *catalog, *checkMap, *applyMap, *ownerAudit, *ownerCheck, *ownerApply} {
		if selected {
			modes++
		}
	}
	if modes > 1 {
		slog.Error("choose exactly one operator mode")
		os.Exit(1)
	}
	if *audit || *catalog || *checkMap || *applyMap || *ownerAudit || *ownerCheck || *ownerApply {
		var plan catalogMap
		var ownerPlan legacyOwnerMap
		if *checkMap || *applyMap {
			var err error
			plan, err = readCatalogMap(os.Stdin)
			if err != nil {
				slog.Error("invalid catalog map; no database changes", "error", err)
				os.Exit(1)
			}
		}
		if *ownerCheck || *ownerApply {
			var err error
			ownerPlan, err = readLegacyOwnerMap(os.Stdin)
			if err != nil {
				slog.Error("invalid legacy owner map; no database changes", "error", err)
				os.Exit(1)
			}
		}
		ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
		defer cancel()
		database, err := sql.Open("postgres", databaseConnectionString(cfg))
		if err != nil {
			slog.Error("audit database open failed")
			os.Exit(1)
		}
		defer database.Close()
		source, err := configuredMigrationSource()
		if err != nil {
			slog.Error("audit migration source unavailable")
			os.Exit(1)
		}
		var report any
		if *ownerAudit {
			report, err = auditLegacyOwners(ctx, database, source)
		} else if *ownerCheck || *ownerApply {
			report, err = executeLegacyOwnerMap(ctx, database, source, ownerPlan, *ownerApply)
		} else if *catalog || *checkMap || *applyMap {
			var path string
			path, err = configuredCatalogBaseline()
			if err == nil {
				if *catalog {
					report, err = auditCatalog(ctx, database, source, path)
				} else {
					report, err = executeCatalogMap(ctx, database, source, path, plan, *applyMap)
				}
			}
		} else {
			report, err = auditDatabase(ctx, database, source)
		}
		if err != nil {
			slog.Error("database operator command failed; no success report produced", "error", err)
			os.Exit(1)
		}
		if err := json.NewEncoder(os.Stdout).Encode(report); err != nil {
			slog.Error("audit output failed")
			os.Exit(1)
		}
		return
	}
	corsOrigin = cfg.CORSOrigin
	juliaBaseURL = cfg.JuliaBaseURL

	slog.Info("starting server", "port", cfg.Port, "cors_origin", cfg.CORSOrigin)

	initDB(cfg)
	if *studyWorker {
		ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
		defer stop()
		defer db.Close()
		if err := serveStudyWorker(ctx, projectStore{database: db}, cfg.JuliaBaseURL, cfg.Port); err != nil {
			slog.Error("study worker failed", "error", err)
			os.Exit(1)
		}
		return
	}
	if *provision {
		ctx, cancel := context.WithTimeout(context.Background(), time.Minute)
		defer cancel()
		defer db.Close()
		if err := provisionAccount(ctx, db, os.Stdin, os.Stdout); err != nil {
			slog.Error("account provision failed")
			os.Exit(1)
		}
		return
	}

	mux := http.NewServeMux()
	auth := newAuthHTTP(db, cfg.AuthOrigin, cfg.AuthCookieSecure)
	mux.Handle("/api/auth/", auth)
	projectHTTP := projectsHTTP{auth: auth, workerURL: cfg.JuliaBaseURL}
	mux.Handle("/api/projects", projectHTTP)
	mux.Handle("/api/projects/", projectHTTP)

	// Healthcheck
	mux.HandleFunc("/health", handleHealth)
	mux.HandleFunc("/ready", handleReady)
	mux.HandleFunc("/version", handleVersion)
	mux.Handle("/metrics", expvar.Handler())

	// EES API routes
	mux.HandleFunc("/api/ees/component-types", enableCORS(handleGetComponentTypes))
	mux.HandleFunc("/api/ees/component-params/", enableCORS(handleGetComponentParams))
	mux.HandleFunc("/api/ees/equipment-models/", enableCORS(handleGetEquipmentModels))
	mux.HandleFunc("/api/ees/equipment-model/", enableCORS(handleGetEquipmentModelParams))
	mux.HandleFunc("/api/ees/schemes", enableCORS(handleSchemes))
	mux.HandleFunc("/api/ees/schemes/", enableCORS(handleSchemeByID))
	mux.HandleFunc("/api/ees/components", enableCORS(handleComponents))
	mux.HandleFunc("/api/ees/components/", enableCORS(handleComponentByIDOrParams))
	mux.HandleFunc("/api/ees/connections", enableCORS(handleConnections))
	mux.HandleFunc("/api/ees/connection-commands", enableCORS(handleConnectionCommands))
	mux.HandleFunc("/api/ees/connections/", enableCORS(handleConnectionByID))
	mux.HandleFunc("/api/ees/calculate/", enableCORS(handleCalculate))
	mux.HandleFunc("/api/ees/capabilities", enableCORS(handleCapabilities))
	mux.HandleFunc("/api/ees/compute-backends", enableCORS(handleComputeBackends))
	mux.HandleFunc("/api/ees/model-definitions", enableCORS(handleModelDefinitions))

	// Julia compute route
	mux.HandleFunc("/julia/solve", enableCORS(handleJuliaSolve))

	server := &http.Server{
		Addr:         ":" + cfg.Port,
		Handler:      securityHeadersMiddleware(loggingMiddleware(mux)),
		ReadTimeout:  15 * time.Second,
		WriteTimeout: 30 * time.Second,
		IdleTimeout:  60 * time.Second,
	}

	go func() {
		slog.Info("listening", "addr", server.Addr)
		if err := server.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			slog.Error("server failed", "error", err)
			os.Exit(1)
		}
	}()

	quit := make(chan os.Signal, 1)
	signal.Notify(quit, syscall.SIGINT, syscall.SIGTERM)
	<-quit

	slog.Info("shutting down server...")

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	if err := server.Shutdown(ctx); err != nil {
		slog.Error("server forced to shutdown", "error", err)
		os.Exit(1)
	}

	if db != nil {
		db.Close()
	}

	slog.Info("server stopped gracefully")
}

func databaseConnectionString(cfg Config) string {
	return fmt.Sprintf("host=%s port=%s dbname=%s user=%s password=%s sslmode=disable",
		cfg.DBHost, cfg.DBPort, cfg.DBName, cfg.DBUser, cfg.DBPassword)
}

func initDB(cfg Config) {
	connStr := databaseConnectionString(cfg)

	var err error
	db, err = sql.Open("postgres", connStr)
	if err != nil {
		slog.Warn("database open failed, will retry", "error", err)
		db = nil
		return
	}

	for i := 0; i < 10; i++ {
		if err := db.Ping(); err != nil {
			slog.Warn("database ping failed, retrying", "attempt", i+1, "error", err)
			time.Sleep(2 * time.Second)
			continue
		}
		slog.Info("database connection established")
		if err := runMigrations(db); err != nil {
			slog.Error("migrations failed; service is not ready", "error", err)
			db.Close()
			db = nil
		}
		return
	}

	slog.Error("database ping failed after 10 attempts")
	db = nil
}

func getEnv(key, defaultVal string) string {
	if val := os.Getenv(key); val != "" {
		return val
	}
	return defaultVal
}

type loggingResponseWriter struct {
	http.ResponseWriter
	statusCode int
}

func (lrw *loggingResponseWriter) WriteHeader(code int) {
	lrw.statusCode = code
	lrw.ResponseWriter.WriteHeader(code)
}

func securityHeadersMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Set("X-Frame-Options", "DENY")
		w.Header().Set("X-XSS-Protection", "0")
		w.Header().Set("Referrer-Policy", "strict-origin-when-cross-origin")
		w.Header().Set("Permissions-Policy", "camera=(), microphone=(), geolocation=()")
		next.ServeHTTP(w, r)
	})
}

func loggingMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		start := time.Now()
		lrw := &loggingResponseWriter{ResponseWriter: w, statusCode: http.StatusOK}
		next.ServeHTTP(lrw, r)
		duration := time.Since(start)
		slog.Info("request",
			"method", r.Method,
			"path", r.URL.Path,
			"status", lrw.statusCode,
			"duration", duration.String(),
			"remote", r.RemoteAddr,
		)
	})
}

func enableCORS(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		origin := r.Header.Get("Origin")
		allowedOrigin := corsOrigin
		if allowedOrigin == "" {
			allowedOrigin = "*"
		}
		if allowedOrigin == "*" || allowedOrigin == origin {
			w.Header().Set("Access-Control-Allow-Origin", allowedOrigin)
		}
		w.Header().Set("Access-Control-Allow-Methods", "POST, GET, PUT, PATCH, DELETE, OPTIONS")
		w.Header().Set("Access-Control-Allow-Headers", "Content-Type, Authorization, If-Match, Idempotency-Key")
		w.Header().Set("Access-Control-Expose-Headers", "ETag")

		if r.Method == "OPTIONS" {
			w.WriteHeader(http.StatusOK)
			return
		}

		next(w, r)
	}
}

func handleHealth(w http.ResponseWriter, _ *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	writeJSON(w, map[string]string{"status": "ok"})
}

func handleReady(w http.ResponseWriter, _ *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	if db == nil {
		w.WriteHeader(http.StatusServiceUnavailable)
		writeJSON(w, map[string]string{"status": "not ready", "reason": "database not connected"})
		return
	}
	start := time.Now()
	err := db.Ping()
	pingDuration := time.Since(start).String()
	if err != nil {
		w.WriteHeader(http.StatusServiceUnavailable)
		writeJSON(w, map[string]string{"status": "not ready", "reason": err.Error(), "ping": pingDuration})
		return
	}
	w.WriteHeader(http.StatusOK)
	writeJSON(w, map[string]string{"status": "ready", "ping": pingDuration})
}

func handleVersion(w http.ResponseWriter, _ *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	writeJSON(w, map[string]string{
		"version":    Version,
		"commit":     Commit,
		"build_time": BuildTime,
	})
}

// ============================================================================
// COMPONENT TYPES
// ============================================================================

func handleGetComponentTypes(w http.ResponseWriter, _ *http.Request) {
	if db == nil {
		sendError(w, "Database not available", http.StatusServiceUnavailable)
		return
	}

	rows, err := db.Query("SELECT id, code, name, category, description FROM component_types ORDER BY category, name")
	if err != nil {
		sendError(w, "Database error: "+err.Error(), http.StatusInternalServerError)
		return
	}
	defer rows.Close()

	types := []map[string]interface{}{}
	for rows.Next() {
		var id int
		var code, name, category string
		var description sql.NullString
		if err := rows.Scan(&id, &code, &name, &category, &description); err != nil {
			sendError(w, "Database scan error: "+err.Error(), http.StatusInternalServerError)
			return
		}

		desc := ""
		if description.Valid {
			desc = description.String
		}
		types = append(types, map[string]interface{}{
			"id": id, "code": code, "name": name, "category": category, "description": desc,
		})
	}
	if err := rows.Err(); err != nil {
		sendError(w, "Database rows error: "+err.Error(), http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	writeJSON(w, types)
}

func handleGetComponentParams(w http.ResponseWriter, r *http.Request) {
	if db == nil {
		sendError(w, "Database not available", http.StatusServiceUnavailable)
		return
	}

	parts := strings.Split(r.URL.Path, "/")
	code := parts[len(parts)-1]

	rows, err := db.Query(`
		SELECT pt.param_key, pt.param_name, pt.param_type, pt.default_value, pt.unit
		FROM component_params_template pt
		JOIN component_types ct ON pt.component_type_id = ct.id
		WHERE ct.code = $1 ORDER BY pt.param_name`, code)
	if err != nil {
		sendError(w, "Database error: "+err.Error(), http.StatusInternalServerError)
		return
	}
	defer rows.Close()

	params := []map[string]interface{}{}
	for rows.Next() {
		var key, name, ptype, defaultVal, unit string
		if err := rows.Scan(&key, &name, &ptype, &defaultVal, &unit); err != nil {
			sendError(w, "Database scan error: "+err.Error(), http.StatusInternalServerError)
			return
		}
		params = append(params, map[string]interface{}{
			"key": key, "name": name, "type": ptype, "default": defaultVal, "unit": unit,
		})
	}
	if err := rows.Err(); err != nil {
		sendError(w, "Database rows error: "+err.Error(), http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	writeJSON(w, params)
}

func handleGetEquipmentModels(w http.ResponseWriter, r *http.Request) {
	if db == nil {
		sendError(w, "Database not available", http.StatusServiceUnavailable)
		return
	}

	parts := strings.Split(r.URL.Path, "/")
	code := parts[len(parts)-1]

	rows, err := db.Query(`
		SELECT em.id, em.model_name, em.manufacturer, em.description
		FROM equipment_models em
		JOIN component_types ct ON em.component_type_id = ct.id
		WHERE ct.code = $1 ORDER BY em.model_name`, code)
	if err != nil {
		sendError(w, "Database error: "+err.Error(), http.StatusInternalServerError)
		return
	}
	defer rows.Close()

	models := []map[string]interface{}{}
	for rows.Next() {
		var id int
		var modelName string
		var manufacturer, description sql.NullString
		if err := rows.Scan(&id, &modelName, &manufacturer, &description); err != nil {
			sendError(w, "Database scan error: "+err.Error(), http.StatusInternalServerError)
			return
		}
		mf := ""
		if manufacturer.Valid {
			mf = manufacturer.String
		}
		desc := ""
		if description.Valid {
			desc = description.String
		}
		models = append(models, map[string]interface{}{
			"id": id, "model_name": modelName, "manufacturer": mf, "description": desc,
		})
	}
	if err := rows.Err(); err != nil {
		sendError(w, "Database rows error: "+err.Error(), http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	writeJSON(w, models)
}

func handleGetEquipmentModelParams(w http.ResponseWriter, r *http.Request) {
	if db == nil {
		sendError(w, "Database not available", http.StatusServiceUnavailable)
		return
	}

	parts := strings.Split(r.URL.Path, "/")
	id, err := strconv.Atoi(parts[len(parts)-1])
	if err != nil {
		sendError(w, "Invalid model ID", http.StatusBadRequest)
		return
	}

	rows, err := db.Query(`
		SELECT param_key, param_value
		FROM equipment_model_params
		WHERE equipment_model_id = $1`, id)
	if err != nil {
		sendError(w, "Database error: "+err.Error(), http.StatusInternalServerError)
		return
	}
	defer rows.Close()

	params := map[string]string{}
	for rows.Next() {
		var key, value string
		if err := rows.Scan(&key, &value); err != nil {
			sendError(w, "Database scan error: "+err.Error(), http.StatusInternalServerError)
			return
		}
		params[key] = value
	}
	if err := rows.Err(); err != nil {
		sendError(w, "Database rows error: "+err.Error(), http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	writeJSON(w, params)
}

// ============================================================================
// SCHEMES
// ============================================================================

func handleSchemes(w http.ResponseWriter, r *http.Request) {
	if db == nil {
		sendError(w, "Database not available", http.StatusServiceUnavailable)
		return
	}

	switch r.Method {
	case "GET":
		rows, err := db.QueryContext(r.Context(), "SELECT id, name, description, created_at, updated_at, owner_id FROM circuit_schemes WHERE project_id IS NULL ORDER BY updated_at DESC")
		if err != nil {
			sendError(w, "Database error: "+err.Error(), http.StatusInternalServerError)
			return
		}
		defer rows.Close()

		schemes := []map[string]interface{}{}
		for rows.Next() {
			var id int
			var name string
			var description sql.NullString
			var createdAt, updatedAt *string
			var ownerID *int
			if err := rows.Scan(&id, &name, &description, &createdAt, &updatedAt, &ownerID); err != nil {
				sendError(w, "Database scan error: "+err.Error(), http.StatusInternalServerError)
				return
			}
			schemes = append(schemes, map[string]interface{}{
				"id": id, "name": name, "description": description.String,
				"created_at": createdAt, "updated_at": updatedAt, "owner_id": ownerID,
			})
		}
		if err := rows.Err(); err != nil {
			sendError(w, "Database rows error: "+err.Error(), http.StatusInternalServerError)
			return
		}

		w.Header().Set("Content-Type", "application/json")
		writeJSON(w, schemes)

	case "POST":
		var req struct {
			Name        string `json:"name"`
			Description string `json:"description"`
		}
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			sendError(w, "Invalid request body: "+err.Error(), http.StatusBadRequest)
			return
		}
		if req.Name == "" {
			sendError(w, "name is required", http.StatusBadRequest)
			return
		}
		var id int
		err := db.QueryRow(
			"INSERT INTO circuit_schemes (name, description) VALUES ($1, $2) RETURNING id",
			req.Name, req.Description,
		).Scan(&id)
		if err != nil {
			sendError(w, "Database error: "+err.Error(), http.StatusInternalServerError)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		writeJSON(w, map[string]interface{}{"id": id, "name": req.Name})
	}
}

func handleSchemeByID(w http.ResponseWriter, r *http.Request) {
	if db == nil {
		sendError(w, "Database not available", http.StatusServiceUnavailable)
		return
	}

	parts := strings.Split(r.URL.Path, "/")
	id, err := strconv.Atoi(parts[len(parts)-1])
	if err != nil {
		sendError(w, "Invalid scheme ID", http.StatusBadRequest)
		return
	}

	switch r.Method {
	case "GET":
		serveSchemeSnapshot(w, r, db, id, 0, "")
	case "PUT":
		var req struct {
			Name        string `json:"name"`
			Description string `json:"description"`
		}
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			sendError(w, "Invalid request body: "+err.Error(), http.StatusBadRequest)
			return
		}
		result, err := db.ExecContext(r.Context(), "UPDATE circuit_schemes SET name = $2, description = $3 WHERE id = $1 AND project_id IS NULL",
			id, req.Name, req.Description)
		if err != nil {
			sendError(w, "Database error: "+err.Error(), http.StatusInternalServerError)
			return
		}
		if count, err := result.RowsAffected(); err != nil || count == 0 {
			sendError(w, "Scheme not found", 404)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		writeJSON(w, map[string]interface{}{"success": true})

	case "DELETE":
		result, err := db.ExecContext(r.Context(), "DELETE FROM circuit_schemes WHERE id = $1 AND project_id IS NULL", id)
		if err != nil {
			sendError(w, "Database error: "+err.Error(), http.StatusInternalServerError)
			return
		}
		if count, err := result.RowsAffected(); err != nil || count == 0 {
			sendError(w, "Scheme not found", 404)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		writeJSON(w, map[string]interface{}{"success": true})
	}
}

// ============================================================================
// COMPONENTS
// ============================================================================

func handleComponentByIDOrParams(w http.ResponseWriter, r *http.Request) {
	if db == nil {
		sendError(w, "Database not available", http.StatusServiceUnavailable)
		return
	}

	parts := strings.Split(r.URL.Path, "/")

	// Проверка на /components/{id}/params
	if len(parts) >= 5 && parts[len(parts)-1] == "params" {
		handleComponentParams(w, r)
		return
	}

	// otherwise /components/{id}
	id, err := strconv.Atoi(parts[len(parts)-1])
	if err != nil {
		sendError(w, "Invalid component ID", http.StatusBadRequest)
		return
	}

	handleComponentMutation(w, r, db, id, false)
}

func handleComponentParams(w http.ResponseWriter, r *http.Request) {
	if db == nil {
		sendError(w, "Database not available", http.StatusServiceUnavailable)
		return
	}
	parts := strings.Split(r.URL.Path, "/")
	if len(parts) < 2 {
		componentWriteError(w, http.StatusBadRequest, "invalid_component_id", "Некорректный ID оборудования")
		return
	}
	id, err := strconv.Atoi(parts[len(parts)-2])
	if err != nil {
		componentWriteError(w, http.StatusBadRequest, "invalid_component_id", "Некорректный ID оборудования")
		return
	}
	handleComponentMutation(w, r, db, id, true)
}

// ============================================================================
// CONNECTIONS
// ============================================================================

func handleConnectionByID(w http.ResponseWriter, r *http.Request) {
	if db == nil {
		sendError(w, "Database not available", http.StatusServiceUnavailable)
		return
	}

	if r.Method != "DELETE" {
		return
	}

	parts := strings.Split(r.URL.Path, "/")
	id, err := strconv.Atoi(parts[len(parts)-1])
	if err != nil {
		sendError(w, "Invalid connection ID", http.StatusBadRequest)
		return
	}

	result, err := db.ExecContext(r.Context(), `WITH legacy AS MATERIALIZED (
 SELECT c.id FROM scheme_connections c JOIN circuit_schemes s ON s.id=c.scheme_id
 WHERE c.id=$1 AND s.project_id IS NULL FOR UPDATE OF s)
 DELETE FROM scheme_connections c USING legacy WHERE c.id=legacy.id`, id)
	if err != nil {
		sendError(w, "Database error: "+err.Error(), http.StatusInternalServerError)
		return
	}
	if count, err := result.RowsAffected(); err != nil || count == 0 {
		sendError(w, "Connection not found", 404)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	writeJSON(w, map[string]interface{}{"success": true})
}

// ============================================================================
// CALCULATE (прокси на Julia)
// ============================================================================

func handleCalculate(w http.ResponseWriter, r *http.Request) {
	if !requireMethod(w, r, http.MethodPost) {
		return
	}
	if db == nil {
		sendError(w, "Database not available", http.StatusServiceUnavailable)
		return
	}
	parts := strings.Split(r.URL.Path, "/")
	schemeID, err := strconv.Atoi(parts[len(parts)-1])
	if err != nil {
		sendError(w, "Invalid scheme ID", http.StatusBadRequest)
		return
	}

	input, err := readCalculationInput(r.Context(), db, schemeID)
	if errors.Is(err, sql.ErrNoRows) {
		sendError(w, "Scheme not found", http.StatusNotFound)
		return
	}
	if err != nil {
		slog.Error("calculation input read failed", "scheme_id", schemeID, "error", err)
		sendError(w, "Could not read calculation snapshot", http.StatusInternalServerError)
		return
	}

	// Прокси на Julia
	modelGroup := r.URL.Query().Get("modelGroup")
	if modelGroup == "" {
		modelGroup = "three-phase"
	}
	method := r.URL.Query().Get("method")
	if method == "" {
		method = "newton-raphson"
	}

	backend, backendErr := calculationBackendOption(r.URL.Query())
	if backendErr != nil {
		sendError(w, "Invalid compute backend", 400)
		return
	}
	workerInput := map[string]interface{}{
		"components":  input.Components,
		"connections": input.Connections,
		"modelGroup":  modelGroup,
		"method":      method,
	}
	if backend != "" {
		workerInput["computeBackend"] = backend
	}
	budget, budgetErr := calculationExecutionOption(r.URL.Query())
	if budgetErr != nil {
		sendError(w, "Invalid calculation time budget", 400)
		return
	}
	if budget != 0 {
		workerInput["executionOptions"] = map[string]int64{"max_time_ms": budget}
	}
	limits, ok := readCalculationLimits(w, r)
	if !ok {
		return
	}
	if !limitTargetsBelongToInput(limits, input) {
		sendError(w, "Operating limit equipment is absent from this scheme", 400)
		return
	}
	if limits != nil {
		workerInput["operatingLimits"] = limits
	}
	calcReq, err := json.Marshal(workerInput)
	if err != nil {
		sendError(w, "Failed to serialize request: "+err.Error(), http.StatusInternalServerError)
		return
	}

	proxyComputeResult(w, r, juliaBaseURL, "/calculate", calcReq, func(status int, result []byte) bool {
		if status >= 200 && status < 300 && !confirmsCalculationLimits(result, limits) {
			sendError(w, "Worker did not confirm requested operating limits", 502)
			return false
		}
		return true
	})
}

const computeBodyLimit = 8 << 20

func requireMethod(w http.ResponseWriter, r *http.Request, method string) bool {
	if r.Method == method {
		return true
	}
	w.Header().Set("Allow", method)
	sendError(w, "Method not allowed", http.StatusMethodNotAllowed)
	return false
}

// Preserve structured diagnostics and propagate cancellation to the worker.
func proxyJulia(w http.ResponseWriter, r *http.Request, path string, body []byte) {
	proxyCompute(w, r, juliaBaseURL, path, body, nil)
}

// Commit only a complete valid response, optionally after a fresh authorization check.
func proxyCompute(w http.ResponseWriter, r *http.Request, workerURL, path string, body []byte, beforeCommit func() bool) {
	proxyComputeResult(w, r, workerURL, path, body, func(_ int, _ []byte) bool {
		return beforeCommit == nil || beforeCommit()
	})
}

// The callback receives the complete bounded response before it is exposed.
// Persistence failures must never be reported as successfully archived results.
func proxyComputeResult(w http.ResponseWriter, r *http.Request, workerURL, path string, body []byte, beforeCommit func(int, []byte) bool) {
	req, err := http.NewRequestWithContext(r.Context(), r.Method, workerURL+path, bytes.NewReader(body))
	if err != nil {
		sendError(w, "Failed to create request: "+err.Error(), http.StatusInternalServerError)
		return
	}
	req.Header.Set("Content-Type", "application/json")

	client := &http.Client{Timeout: 25 * time.Second, CheckRedirect: func(_ *http.Request, _ []*http.Request) error {
		return http.ErrUseLastResponse
	}}
	// #nosec G704 -- workerURL is operator configuration and path is a constant
	// API endpoint, never a client-supplied URL. Do not forward inputs on redirects.
	resp, err := client.Do(req)
	if err != nil {
		writeComputeTransportError(w, err, "Julia service unreachable", http.StatusServiceUnavailable)
		return
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 300 && resp.StatusCode < 400 {
		sendError(w, "Unexpected compute redirect", http.StatusBadGateway)
		return
	}

	respBody, err := io.ReadAll(io.LimitReader(resp.Body, computeBodyLimit+1))
	if err != nil {
		writeComputeTransportError(w, err, "Incomplete Julia response", http.StatusBadGateway)
		return
	}
	if len(respBody) > computeBodyLimit {
		sendError(w, "Compute response exceeds size limit", http.StatusBadGateway)
		return
	}
	// Validate before committing the upstream status or exposing any partial body.
	// Syntax validation does not establish numerical or endpoint schema validity.
	if !json.Valid(respBody) {
		sendError(w, "Invalid Julia JSON response", http.StatusBadGateway)
		return
	}
	if beforeCommit != nil && !beforeCommit(resp.StatusCode, respBody) {
		return
	}
	writeJSONBody(w, resp.StatusCode, respBody)
}

// Classify failures during both request dispatch and response streaming.
// Closing the HTTP connection does not guarantee that the worker stops computing.
func writeComputeTransportError(w http.ResponseWriter, err error, message string, status int) {
	if errors.Is(err, context.DeadlineExceeded) {
		sendError(w, "Julia service timeout", http.StatusGatewayTimeout)
	} else if errors.Is(err, context.Canceled) {
		sendError(w, "Compute request cancelled", http.StatusRequestTimeout)
	} else {
		sendError(w, message, status)
	}
}

// ============================================================================
// JULIA COMPUTE
// ============================================================================

func handleJuliaSolve(w http.ResponseWriter, r *http.Request) {
	if !requireMethod(w, r, http.MethodPost) {
		return
	}
	body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, computeBodyLimit))
	if err != nil {
		var limit *http.MaxBytesError
		if errors.As(err, &limit) {
			sendError(w, "Request exceeds size limit", http.StatusRequestEntityTooLarge)
		} else {
			sendError(w, "Request body unreadable", http.StatusBadRequest)
		}
		return
	}
	proxyJulia(w, r, "/solve", body)
}

func handleCapabilities(w http.ResponseWriter, r *http.Request) {
	if !requireMethod(w, r, http.MethodGet) {
		return
	}
	proxyJulia(w, r, "/capabilities", nil)
}

func handleComputeBackends(w http.ResponseWriter, r *http.Request) {
	if !requireMethod(w, r, http.MethodGet) {
		return
	}
	proxyJulia(w, r, "/ready", nil)
}

// ============================================================================
// UTILS
// ============================================================================

func sendError(w http.ResponseWriter, message string, code int) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	writeJSON(w, Response{Error: message})
}
