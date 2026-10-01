package main

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"

	"github.com/golang-migrate/migrate/v4"
	"github.com/golang-migrate/migrate/v4/database/postgres"
	"github.com/golang-migrate/migrate/v4/source"
	_ "github.com/golang-migrate/migrate/v4/source/file"
)

// The shipped directory is resolved relative to the binary, never its working
// directory. Developers and test fixtures may select an explicit source URL.
func runMigrations(database *sql.DB) error {
	url := os.Getenv("MIGRATIONS_SOURCE")
	if url == "" {
		executable, err := os.Executable()
		if err != nil {
			return fmt.Errorf("migration executable path: %w", err)
		}
		url = "file://" + filepath.ToSlash(filepath.Join(filepath.Dir(executable), "database", "migrations"))
	}
	return runMigrationsFromSource(database, url)
}

func runMigrationsFromSource(database *sql.DB, url string) error {
	files, err := source.Open(url)
	if err != nil {
		return fmt.Errorf("migration source: %w", err)
	}
	defer files.Close()
	snapshot, err := snapshotMigrations(files)
	if err != nil {
		return err
	}
	latest, err := files.First()
	if err != nil {
		return fmt.Errorf("empty or unreadable migration source: %w", err)
	}
	for {
		next, err := files.Next(latest)
		if errors.Is(err, os.ErrNotExist) {
			break
		}
		if err != nil {
			return fmt.Errorf("migration source versions: %w", err)
		}
		latest = next
	}
	conn, err := database.Conn(context.Background())
	if err != nil {
		return fmt.Errorf("migration connection: %w", err)
	}
	defer conn.Close()
	driver, err := postgres.WithConnection(context.Background(), conn, &postgres.Config{})
	if err != nil {
		return fmt.Errorf("migration driver: %w", err)
	}
	// Closing the database driver also closes the application's pool. Its
	// lifetime belongs to the caller; only the source is closed here.
	checked := &integrityDriver{Driver: driver, conn: conn, source: snapshot, latest: latest}
	m, err := migrate.NewWithInstance("file", snapshot, "postgres", checked)
	if err != nil {
		return fmt.Errorf("migration instance: %w", err)
	}
	version, dirty, err := m.Version()
	if err != nil && !errors.Is(err, migrate.ErrNilVersion) {
		return fmt.Errorf("migration version: %w", err)
	}
	if dirty {
		return fmt.Errorf("dirty database migration version %d; manual recovery required", version)
	}
	if err == nil {
		if version > latest {
			return fmt.Errorf("database version %d is newer than supported version %d", version, latest)
		}
		body, _, err := files.ReadUp(version)
		if err != nil {
			return fmt.Errorf("database version %d is absent from migration source: %w", version, err)
		}
		if err := body.Close(); err != nil {
			return fmt.Errorf("migration source close: %w", err)
		}
	}
	if err := m.Up(); err != nil && !errors.Is(err, migrate.ErrNoChange) {
		return fmt.Errorf("migration up: %w", err)
	}
	version, dirty, err = m.Version()
	if err != nil || dirty || version != latest {
		return fmt.Errorf("migration completion mismatch: got %d (dirty=%t), expected %d: %v", version, dirty, latest, err)
	}
	slog.Info("migrations complete", "version", version, "dirty", dirty)
	return nil
}
