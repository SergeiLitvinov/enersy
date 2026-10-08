package main

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"expvar"
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
	DBHost       string
	DBPort       string
	DBName       string
	DBUser       string
	DBPassword   string
	Port         string
	CORSOrigin   string
	JuliaBaseURL string
}

func loadConfig() Config {
	return Config{
		DBHost:       getEnv("DB_HOST", "postgres"),
		DBPort:       getEnv("DB_PORT", "5432"),
		DBName:       getEnv("POSTGRES_DB", "app_db"),
		DBUser:       getEnv("POSTGRES_USER", "app_user"),
		DBPassword:   getEnv("POSTGRES_PASSWORD", "app_pass"),
		Port:         getEnv("PORT", "8080"),
		CORSOrigin:   getEnv("CORS_ORIGIN", "*"),
		JuliaBaseURL: getEnv("JULIA_BASE_URL", "http://julia-compute:8001"),
	}
}

func main() {
	cfg := loadConfig()
	corsOrigin = cfg.CORSOrigin
	juliaBaseURL = cfg.JuliaBaseURL

	slog.Info("starting server", "port", cfg.Port, "cors_origin", cfg.CORSOrigin)

	initDB(cfg)

	mux := http.NewServeMux()

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

func initDB(cfg Config) {
	connStr := fmt.Sprintf("host=%s port=%s dbname=%s user=%s password=%s sslmode=disable",
		cfg.DBHost, cfg.DBPort, cfg.DBName, cfg.DBUser, cfg.DBPassword)

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

func handleHealth(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]string{"status": "ok"})
}

func handleReady(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	if db == nil {
		w.WriteHeader(http.StatusServiceUnavailable)
		json.NewEncoder(w).Encode(map[string]string{"status": "not ready", "reason": "database not connected"})
		return
	}
	start := time.Now()
	err := db.Ping()
	pingDuration := time.Since(start).String()
	if err != nil {
		w.WriteHeader(http.StatusServiceUnavailable)
		json.NewEncoder(w).Encode(map[string]string{"status": "not ready", "reason": err.Error(), "ping": pingDuration})
		return
	}
	w.WriteHeader(http.StatusOK)
	json.NewEncoder(w).Encode(map[string]string{"status": "ready", "ping": pingDuration})
}

func handleVersion(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]string{
		"version":    Version,
		"commit":     Commit,
		"build_time": BuildTime,
	})
}

// ============================================================================
// COMPONENT TYPES
// ============================================================================

func handleGetComponentTypes(w http.ResponseWriter, r *http.Request) {
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
	json.NewEncoder(w).Encode(types)
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
	json.NewEncoder(w).Encode(params)
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
	json.NewEncoder(w).Encode(models)
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
	json.NewEncoder(w).Encode(params)
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
		rows, err := db.Query("SELECT id, name, description, created_at, updated_at, owner_id FROM circuit_schemes ORDER BY updated_at DESC")
		if err != nil {
			sendError(w, "Database error: "+err.Error(), http.StatusInternalServerError)
			return
		}
		defer rows.Close()

		schemes := []map[string]interface{}{}
		for rows.Next() {
			var id int
			var name, description string
			var createdAt, updatedAt string
			var ownerID int
			if err := rows.Scan(&id, &name, &description, &createdAt, &updatedAt, &ownerID); err != nil {
				sendError(w, "Database scan error: "+err.Error(), http.StatusInternalServerError)
				return
			}
			schemes = append(schemes, map[string]interface{}{
				"id": id, "name": name, "description": description,
				"created_at": createdAt, "updated_at": updatedAt, "owner_id": ownerID,
			})
		}
		if err := rows.Err(); err != nil {
			sendError(w, "Database rows error: "+err.Error(), http.StatusInternalServerError)
			return
		}

		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(schemes)

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
		json.NewEncoder(w).Encode(map[string]interface{}{"id": id, "name": req.Name})
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
		var name, description string
		var createdAt, updatedAt string
		var ownerID int
		err := db.QueryRow("SELECT name, description, created_at, updated_at, owner_id FROM circuit_schemes WHERE id = $1", id).
			Scan(&name, &description, &createdAt, &updatedAt, &ownerID)
		if err == sql.ErrNoRows {
			sendError(w, "Scheme not found", http.StatusNotFound)
			return
		}
		if err != nil {
			sendError(w, "Database error: "+err.Error(), http.StatusInternalServerError)
			return
		}

		components := []map[string]interface{}{}
		compRows, err := db.Query(`
			SELECT sc.id, ct.code, sc.pos_x, sc.pos_y, sc.rotation, sc.custom_name,
			       sc.equipment_model_id, ct.id, sc.revision, COALESCE((SELECT jsonb_object_agg(param_key,param_value)
			       FROM scheme_component_params WHERE scheme_component_id=sc.id), '{}'::jsonb)
			FROM scheme_components sc
			JOIN component_types ct ON sc.component_type_id = ct.id
			WHERE sc.scheme_id = $1`, id)
		if err != nil {
			sendError(w, "Database error: "+err.Error(), http.StatusInternalServerError)
			return
		}
		defer compRows.Close()

		for compRows.Next() {
			var compID int
			var code string
			var x, y float64
			var rotation int
			var customName sql.NullString
			var modelID sql.NullInt64
			var typeID int
			var revision int64
			var paramsJSON []byte
			if err := compRows.Scan(&compID, &code, &x, &y, &rotation, &customName, &modelID, &typeID, &revision, &paramsJSON); err != nil {
				sendError(w, "Database scan error: "+err.Error(), http.StatusInternalServerError)
				return
			}
			cname := ""
			if customName.Valid {
				cname = customName.String
			}
			params := map[string]string{}
			if err := json.Unmarshal(paramsJSON, &params); err != nil {
				sendError(w, "Invalid stored parameters", http.StatusInternalServerError)
				return
			}
			var equipmentModelID any
			if modelID.Valid {
				equipmentModelID = modelID.Int64
			}
			components = append(components, map[string]interface{}{
				"id": compID, "type": code, "x": x, "y": y, "rotation": rotation, "name": cname,
				"params": params, "equipmentModelId": equipmentModelID, "typeId": typeID, "revision": strconv.FormatInt(revision, 10),
			})
		}
		if err := compRows.Err(); err != nil {
			sendError(w, "Database rows error: "+err.Error(), http.StatusInternalServerError)
			return
		}

		connections := []map[string]interface{}{}
		connRows, err := db.Query(`
			SELECT c.id, c.from_component_id, c.to_component_id, c.from_port, c.to_port,
			COALESCE(to_json(v.reasons), '[]'::json)
			FROM scheme_connections c LEFT JOIN invalid_scheme_connections v ON v.id=c.id
			WHERE c.scheme_id = $1`, id)
		if err != nil {
			sendError(w, "Database error: "+err.Error(), http.StatusInternalServerError)
			return
		}
		defer connRows.Close()

		for connRows.Next() {
			var connectionID, from, to int
			var fromPort, toPort string
			var reasonsJSON []byte
			if err := connRows.Scan(&connectionID, &from, &to, &fromPort, &toPort, &reasonsJSON); err != nil {
				sendError(w, "Database scan error: "+err.Error(), http.StatusInternalServerError)
				return
			}
			var reasons []string
			if err := json.Unmarshal(reasonsJSON, &reasons); err != nil {
				sendError(w, "Connection diagnostics error", http.StatusInternalServerError)
				return
			}
			connections = append(connections, map[string]interface{}{
				"id": connectionID, "validationErrors": reasons,
				"from": from, "to": to, "fromPort": fromPort, "toPort": toPort,
			})
		}
		if err := connRows.Err(); err != nil {
			sendError(w, "Database rows error: "+err.Error(), http.StatusInternalServerError)
			return
		}

		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]interface{}{
			"id": id, "name": name, "description": description,
			"created_at": createdAt, "updated_at": updatedAt, "owner_id": ownerID,
			"components": components, "connections": connections,
		})

	case "PUT":
		var req struct {
			Name        string `json:"name"`
			Description string `json:"description"`
		}
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			sendError(w, "Invalid request body: "+err.Error(), http.StatusBadRequest)
			return
		}
		_, err := db.Exec("UPDATE circuit_schemes SET name = $2, description = $3 WHERE id = $1",
			id, req.Name, req.Description)
		if err != nil {
			sendError(w, "Database error: "+err.Error(), http.StatusInternalServerError)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]interface{}{"success": true})

	case "DELETE":
		_, err := db.Exec("DELETE FROM circuit_schemes WHERE id = $1", id)
		if err != nil {
			sendError(w, "Database error: "+err.Error(), http.StatusInternalServerError)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]interface{}{"success": true})
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

	_, err = db.Exec("DELETE FROM scheme_connections WHERE id = $1", id)
	if err != nil {
		sendError(w, "Database error: "+err.Error(), http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{"success": true})
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

	components := []map[string]interface{}{}
	connections := []map[string]interface{}{}

	if db != nil {
		compRows, err := db.Query(`
			SELECT sc.id, ct.code, sc.pos_x, sc.pos_y, sc.rotation
			FROM scheme_components sc
			JOIN component_types ct ON sc.component_type_id = ct.id
			WHERE sc.scheme_id = $1`, schemeID)
		if err != nil {
			sendError(w, "Database error: "+err.Error(), http.StatusInternalServerError)
			return
		}
		defer compRows.Close()

		for compRows.Next() {
			var id int
			var code string
			var x, y float64
			var rotation int
			if err := compRows.Scan(&id, &code, &x, &y, &rotation); err != nil {
				sendError(w, "Database scan error: "+err.Error(), http.StatusInternalServerError)
				return
			}

			paramRows, err := db.Query("SELECT param_key, param_value FROM scheme_component_params WHERE scheme_component_id = $1", id)
			if err != nil {
				sendError(w, "Database error: "+err.Error(), http.StatusInternalServerError)
				return
			}
			params := map[string]string{}
			for paramRows.Next() {
				var key, value string
				if err := paramRows.Scan(&key, &value); err != nil {
					paramRows.Close()
					sendError(w, "Database scan error: "+err.Error(), http.StatusInternalServerError)
					return
				}
				params[key] = value
			}
			paramRows.Close()

			components = append(components, map[string]interface{}{
				"id": id, "type": code, "x": x, "y": y, "rotation": rotation, "params": params,
			})
		}

		if err := compRows.Err(); err != nil {
			sendError(w, "Database rows error: "+err.Error(), http.StatusInternalServerError)
			return
		}

		connRows, err := db.Query(`
			SELECT from_component_id, to_component_id, from_port, to_port
			FROM scheme_connections WHERE scheme_id = $1`, schemeID)
		if err != nil {
			sendError(w, "Database error: "+err.Error(), http.StatusInternalServerError)
			return
		}
		defer connRows.Close()

		for connRows.Next() {
			var from, to int
			var fromPort, toPort string
			if err := connRows.Scan(&from, &to, &fromPort, &toPort); err != nil {
				sendError(w, "Database scan error: "+err.Error(), http.StatusInternalServerError)
				return
			}
			connections = append(connections, map[string]interface{}{
				"from": from, "to": to, "fromPort": fromPort, "toPort": toPort,
			})
		}
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

	calcReq, err := json.Marshal(map[string]interface{}{
		"components":  components,
		"connections": connections,
		"modelGroup":  modelGroup,
		"method":      method,
	})
	if err != nil {
		sendError(w, "Failed to serialize request: "+err.Error(), http.StatusInternalServerError)
		return
	}

	proxyJulia(w, r, "/calculate", calcReq)
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
	req, err := http.NewRequestWithContext(r.Context(), r.Method, juliaBaseURL+path, bytes.NewReader(body))
	if err != nil {
		sendError(w, "Failed to create request: "+err.Error(), http.StatusInternalServerError)
		return
	}
	req.Header.Set("Content-Type", "application/json")

	client := &http.Client{Timeout: 25 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		writeComputeTransportError(w, err, "Julia service unreachable", http.StatusServiceUnavailable)
		return
	}
	defer resp.Body.Close()

	respBody, err := io.ReadAll(io.LimitReader(resp.Body, computeBodyLimit+1))
	if err != nil {
		writeComputeTransportError(w, err, "Incomplete Julia response", http.StatusBadGateway)
		return
	}
	if len(respBody) > computeBodyLimit {
		sendError(w, "Compute response exceeds size limit", http.StatusBadGateway)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(resp.StatusCode)
	w.Write(respBody)
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

// ============================================================================
// UTILS
// ============================================================================

func validateRequired(vals map[string]interface{}) string {
	for key, val := range vals {
		switch v := val.(type) {
		case string:
			if v == "" {
				return key + " is required"
			}
		case int:
			if v <= 0 {
				return key + " must be positive"
			}
		case float64:
			if v <= 0 {
				return key + " must be positive"
			}
		}
	}
	return ""
}

func sendError(w http.ResponseWriter, message string, code int) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	json.NewEncoder(w).Encode(Response{Error: message})
}
